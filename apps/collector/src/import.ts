import type { CollectorEngine } from './http.js';
import { AgyAdapter } from './adapters/agy.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import type { Provider } from './provider-setup.js';

export interface HistoryImportResult {
  opencodeSessions: number;
  claudeLines: number;
  codexLines: number;
  agyConversations: number;
  durationMs: number;
}

/**
 * Bounded 90-day history backfill across all four sources (§7.3, M6).
 * Tags imported rows with `historical: true` and uses idempotent sample keys
 * so re-running `agent-deck import` never double-counts tokens or cost.
 */
export async function runHistoryBackfill(
  engine: CollectorEngine,
  options?: {
    providers?: Provider[];
    days?: number;
    maxPerSource?: number;
    opencodeServiceUrl?: string;
    claudeProjectsDir?: string;
    codexSessionsDir?: string;
    agyBaseDir?: string;
  }
): Promise<HistoryImportResult> {
  const startMs = Date.now();
  const days = options?.days ?? 90;
  const maxPerSource = options?.maxPerSource ?? 100;
  const cutoffTs = startMs - days * 86_400_000;

  let opencodeSessions = 0;
  let claudeLines = 0;
  let codexLines = 0;
  let agyConversations = 0;

  const ctx = {
    emit: (ev: Parameters<CollectorEngine['ingest']>[0]) => {
      if (ev.type === 'run.started' && ev.payload && typeof ev.payload === 'object') {
        (ev.payload as Record<string, unknown>).historical = true;
      }
      engine.ingest(ev);
    },
    reportHealth: (h: Parameters<CollectorEngine['reportAdapterHealth']>[0]) =>
      engine.reportAdapterHealth(h),
    getSetting: <T>(k: string) => engine.store.getSetting<T>(k),
    setSetting: <T>(k: string, v: T) => engine.store.setSetting<T>(k, v)
  };

  // 1. OpenCode backfill
  if (!options?.providers || options.providers.includes('opencode')) {
    const opencode = new OpenCodeAdapter({ serviceUrlOverride: options?.opencodeServiceUrl });
    opencodeSessions = await opencode.importHistory(ctx, maxPerSource, cutoffTs);
  }

  // 2. Claude Code backfill
  if (!options?.providers || options.providers.includes('claude')) {
    const claude = new ClaudeAdapter({ projectsDir: options?.claudeProjectsDir, udpPort: 0 });
    claude['ctx'] = ctx;
    claudeLines = claude.scanTranscripts(maxPerSource);
  }

  // 3. Codex backfill
  if (!options?.providers || options.providers.includes('codex')) {
    const codex = new CodexAdapter({ sessionsDir: options?.codexSessionsDir });
    codex['ctx'] = ctx;
    codexLines = codex.scanRolloutFiles(maxPerSource);
  }

  // 4. agy backfill
  if (!options?.providers || options.providers.includes('agy')) {
    const agy = new AgyAdapter({ baseDir: options?.agyBaseDir });
    agy['ctx'] = ctx;
    agyConversations = agy.pollConversations(maxPerSource);
  }

  const result: HistoryImportResult = {
    opencodeSessions,
    claudeLines,
    codexLines,
    agyConversations,
    durationMs: Date.now() - startMs
  };

  engine.store.setSetting('last_history_import', {
    ...result,
    providers: [...new Set([
      ...(engine.store.getSetting<{ providers?: Provider[] }>('last_history_import')?.providers ?? []),
      ...(options?.providers ?? ['opencode', 'claude', 'codex', 'agy'])
    ])],
    importedAt: Date.now()
  });

  return result;
}
