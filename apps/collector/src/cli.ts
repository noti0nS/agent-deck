#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from '@agent-deck/core';
import { adapterHealthToDoctor, formatDoctorReport } from '@agent-deck/doctor';
import { AgyAdapter } from './adapters/agy.js';
import {
  ClaudeAdapter,
  setupClaudeHooks,
  uninstallClaudeHooks
} from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { PtyAdapter, runCliInPtyWrapper } from './adapters/pty.js';
import { CollectorEngine, buildHttpServer } from './http.js';
import { runHistoryBackfill } from './import.js';
import {
  configureTailscaleServe,
  findTailscaleAddress,
  getTailscaleMagicDnsUrl,
  renderAsciiQr
} from './pair.js';
import { CollectorStore } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getDefaultCollectorDbPath(): string {
  return process.env.AGENT_DECK_DB_PATH || join(homedir(), '.agent-deck', 'collector.db');
}

export function getDefaultWebBuildDir(): string {
  return resolve(__dirname, '..', '..', 'web', 'build');
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] || 'status';
  const args = argv.slice(1);

  if (cmd === 'probe') {
    const srcIdx = args.indexOf('--source');
    const source = (srcIdx >= 0 ? args[srcIdx + 1] : args[0] || 'opencode') as Source;
    const tailIdx = args.indexOf('--tail');
    const tail = tailIdx >= 0 ? Math.max(1, Number(args[tailIdx + 1]) || 20) : 20;

    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const emitted: Array<{ seq: number; type: string; runId?: string; status?: string }> = [];

    const ctx = {
      emit: (ev: Parameters<CollectorEngine['ingest']>[0]) => {
        const env = engine.ingest(ev);
        const run = env.runId ? engine.state.runs[env.runId] : undefined;
        emitted.push({
          seq: env.seq,
          type: env.type,
          runId: env.runId,
          status: run?.status
        });
      },
      reportHealth: (h: Parameters<CollectorEngine['reportAdapterHealth']>[0]) =>
        engine.reportAdapterHealth(h),
      getSetting: <T>(k: string) => store.getSetting<T>(k),
      setSetting: <T>(k: string, v: T) => store.setSetting<T>(k, v)
    };

    if (source === 'opencode') {
      const adapter = new OpenCodeAdapter();
      const caps = await adapter.probe();
      console.log(`[probe] source=opencode capabilities=${JSON.stringify(caps)}`);
      adapter['ctx'] = ctx;
      adapter.reconcileFromDb(tail, 'polled');
    } else if (source === 'claude') {
      const adapter = new ClaudeAdapter({ udpPort: 0 });
      const caps = await adapter.probe();
      console.log(`[probe] source=claude capabilities=${JSON.stringify(caps)}`);
      adapter['ctx'] = ctx;
      adapter.scanTranscripts(tail);
    } else if (source === 'codex') {
      const adapter = new CodexAdapter();
      const caps = await adapter.probe();
      console.log(`[probe] source=codex capabilities=${JSON.stringify(caps)}`);
      adapter['ctx'] = ctx;
      adapter.scanRolloutFiles(tail);
    } else if (source === 'agy') {
      const adapter = new AgyAdapter();
      const caps = await adapter.probe();
      console.log(`[probe] source=agy capabilities=${JSON.stringify(caps)}`);
      adapter['ctx'] = ctx;
      adapter.pollConversations(tail);
    } else {
      const adapter = new PtyAdapter();
      const caps = await adapter.probe();
      console.log(`[probe] source=pty capabilities=${JSON.stringify(caps)}`);
    }

    const tailEvents = emitted.slice(-tail);
    for (const e of tailEvents) {
      console.log(`#${e.seq}  ${e.type.padEnd(18)}  ${(e.runId ?? '-').padEnd(36)}  status=${e.status ?? '-'}`);
    }
    const runs = Object.values(engine.state.runs);
    const totalIn = runs.reduce((acc, r) => acc + r.usage.tokensIn, 0);
    const totalOut = runs.reduce((acc, r) => acc + r.usage.tokensOut, 0);
    const totalCost = runs.reduce((acc, r) => acc + (r.usage.costUsd ?? 0), 0);
    console.log(
      `\nSummary: ${runs.length} runs | tokensIn=${totalIn} | tokensOut=${totalOut} | costUsd=$${totalCost.toFixed(4)}`
    );
    store.close();
    return 0;
  }

  if (cmd === 'doctor') {
    const dbPath = getDefaultCollectorDbPath();
    const store = new CollectorStore(dbPath);
    const adapters = [
      new OpenCodeAdapter(),
      new ClaudeAdapter({ udpPort: 0 }),
      new CodexAdapter(),
      new AgyAdapter(),
      new PtyAdapter()
    ];
    for (const a of adapters) {
      await a.probe();
    }
    const tsUrl = await getTailscaleMagicDnsUrl();
    const report = {
      generatedAt: Date.now(),
      nodeVersion: process.version,
      platform: process.platform,
      collectorRunning: false,
      collectorUrl: 'http://127.0.0.1:4100',
      tailscaleUrl: tsUrl,
      dbSizeBytes: store.getDbSizeBytes(),
      adapters: adapters.map((a) => adapterHealthToDoctor(a.health()))
    };
    console.log(formatDoctorReport(report));
    store.close();
    return 0;
  }

  if (cmd === 'setup' && args[0] === 'claude') {
    const dryRun = args.includes('--dry-run');
    const shimName = process.platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook';
    const exePath = resolve(__dirname, '..', '..', '..', 'tools', 'hook-shim', shimName);
    // Built by `npm run build:hooks`. Falls back to PATH for packaged installs
    // that ship the shim alongside the CLI instead of in the repo tree.
    const commandPath = existsSync(exePath) ? exePath : 'agent-deck-hook';
    const res = setupClaudeHooks({ commandPath, dryRun });
    console.log(res.diff);
    if (res.backupPath) {
      console.log(`\nBacked up original settings to: ${res.backupPath}`);
    }
    if (res.modified) {
      console.log('Claude Code hooks installed (tagged `_source: "agent-deck"`).');
    }
    return 0;
  }

  if (cmd === 'uninstall') {
    const res = uninstallClaudeHooks();
    console.log(res.restored ? 'Restored ~/.claude/settings.json.' : 'No Claude hook changes found.');
    return 0;
  }

  if (cmd === 'import') {
    const dbPath = getDefaultCollectorDbPath();
    const store = new CollectorStore(dbPath);
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const res = runHistoryBackfill(engine);
    console.log(
      `History backfill complete in ${res.durationMs}ms: opencode=${res.opencodeSessions}, claudeLines=${res.claudeLines}, codexLines=${res.codexLines}, agy=${res.agyConversations}`
    );
    store.close();
    return 0;
  }

  if (cmd === 'run') {
    const sepIdx = args.indexOf('--');
    const cliArgs = sepIdx >= 0 ? args.slice(sepIdx + 1) : args;
    if (cliArgs.length === 0) {
      console.error('Usage: agent-deck run -- <cli> [args...]');
      return 1;
    }
    const [targetCmd, ...restArgs] = cliArgs;
    return await runCliInPtyWrapper(targetCmd, restArgs);
  }

  if (cmd === 'pair') {
    const dbPath = getDefaultCollectorDbPath();
    const store = new CollectorStore(dbPath);
    const engine = new CollectorEngine({ store });
    const { code } = engine.pairing.generatePairingCode();
    const tsUrl = (await getTailscaleMagicDnsUrl()) ?? 'https://deck.<tailnet>.ts.net';
    const qr = renderAsciiQr(`${tsUrl}?code=${code}`);
    console.log('  Scan to open Agent Deck on your tablet');
    console.log(`${qr}   ${tsUrl}`);
    console.log(`                             code: ${code}  (expires 5 min)`);
    store.close();
    return 0;
  }

  if (cmd === 'status') {
    try {
      const res = await fetch('http://127.0.0.1:4100/api/health');
      if (res.ok) {
        const data = (await res.json()) as { seq?: number; metrics?: { sseClientCount?: number } };
        console.log(`Collector ONLINE (seq=${data.seq}, sseClients=${data.metrics?.sseClientCount ?? 0})`);
        return 0;
      }
    } catch {
      // offline
    }
    console.log('Collector OFFLINE (http://127.0.0.1:4100)');
    return 0;
  }

  if (cmd === 'start') {
    const port = Number(process.env.AGENT_DECK_PORT || 4100);
    const dbPath = getDefaultCollectorDbPath();
    const store = new CollectorStore(dbPath);
    const staticDir = getDefaultWebBuildDir();
    const engine = new CollectorEngine({
      store,
      staticDir: existsSync(staticDir) ? staticDir : undefined
    });

    // Bootstrap first-run 90-day history backfill if not yet run (§7.3)
    if (!store.getSetting('last_history_import')) {
      runHistoryBackfill(engine);
    }

    engine.registerAdapter(new OpenCodeAdapter());
    engine.registerAdapter(new ClaudeAdapter());
    engine.registerAdapter(new CodexAdapter());
    engine.registerAdapter(new AgyAdapter({ enableRemoteControl: engine.state.prefs.enableAgyRemoteControl }));
    engine.registerAdapter(new PtyAdapter());
    await engine.startAdapters();

    const app = await buildHttpServer(engine, {
      staticDir: existsSync(staticDir) ? staticDir : undefined
    });

    // Bind loopback (127.0.0.1) or Tailscale IP — never 0.0.0.0 (P6, §9, §10.3)
    const host = process.env.AGENT_DECK_HOST || '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') {
      throw new Error('Refusing to bind 0.0.0.0: Agent Deck binds only loopback or Tailscale interface (P6).');
    }

    await app.listen({ port, host });
    const tsAddress = findTailscaleAddress();
    // Publish on HTTPS :443 by default; set AGENT_DECK_SERVE_HTTPS_PORT to use a
    // dedicated port when another app already owns the tailnet root.
    const serveHttpsPort = Number(process.env.AGENT_DECK_SERVE_HTTPS_PORT || 0) || undefined;
    const serveRes = await configureTailscaleServe(port, serveHttpsPort);
    console.log(
      `Agent Deck collector listening on http://${host}:${port}` +
        (tsAddress ? ` (tailnet interface: ${tsAddress})` : '') +
        (serveRes.url ? ` -> ${serveRes.url}` : ` (tailscale serve: ${serveRes.message})`)
    );
    return 0;
  }

  console.log(`Usage: agent-deck <start|status|doctor|probe|setup claude|uninstall|pair|run|import>`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
