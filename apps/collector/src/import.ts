import { existsSync } from 'node:fs';
import type { CollectorEngine } from './http.js';
import { AgyAdapter } from './adapters/agy.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter, type OpenCodeSessionRow } from './adapters/opencode.js';
import { withReadonlySqlite } from './adapters/readonly-sqlite.js';

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
export function runHistoryBackfill(
  engine: CollectorEngine,
  options?: {
    days?: number;
    maxPerSource?: number;
    opencodeDbPath?: string;
    claudeProjectsDir?: string;
    codexSessionsDir?: string;
    agyBaseDir?: string;
  }
): HistoryImportResult {
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
  const opencode = new OpenCodeAdapter({ dbPath: options?.opencodeDbPath });
  opencode['ctx'] = ctx;
  if (existsSync(opencode.dbPath)) {
    try {
      withReadonlySqlite(opencode.dbPath, (db) => {
        const rows = db
          .prepare(
            `SELECT id, parent_id, directory, title, agent, model, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    time_created, time_updated, time_compacting,
                    summary_additions, summary_deletions, summary_files
             FROM session
             WHERE time_updated >= ?
             ORDER BY time_updated DESC
             LIMIT ?`
          )
          .all(cutoffTs, maxPerSource) as OpenCodeSessionRow[];

        for (const r of rows.reverse()) {
          opencode.emitSessionRow(db, r, 'inferred', true);
          opencodeSessions += 1;
        }
      });
    } catch {
      // ignore
    }
  }

  // 2. Claude Code backfill
  const claude = new ClaudeAdapter({ projectsDir: options?.claudeProjectsDir, udpPort: 0 });
  claude['ctx'] = ctx;
  claudeLines = claude.scanTranscripts(maxPerSource);

  // 3. Codex backfill
  const codex = new CodexAdapter({ sessionsDir: options?.codexSessionsDir });
  codex['ctx'] = ctx;
  codexLines = codex.scanRolloutFiles(maxPerSource);

  // 4. agy backfill
  const agy = new AgyAdapter({ baseDir: options?.agyBaseDir });
  agy['ctx'] = ctx;
  agyConversations = agy.pollConversations(maxPerSource);

  const result: HistoryImportResult = {
    opencodeSessions,
    claudeLines,
    codexLines,
    agyConversations,
    durationMs: Date.now() - startMs
  };

  engine.store.setSetting('last_history_import', {
    ...result,
    importedAt: Date.now()
  });

  return result;
}
