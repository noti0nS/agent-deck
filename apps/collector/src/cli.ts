#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Source } from '@agent-deck/core';
import { adapterHealthToDoctor, formatDoctorReport } from '@agent-deck/doctor';
import { AgyAdapter } from './adapters/agy.js';
import { setupAgyHooks, uninstallAgyHooks } from './adapters/agy-hooks.js';
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
import { ModelCatalogSync } from './model-catalog.js';
import { runMcp } from './mcp.js';
import { collectorPort, collectorUrl, checkCollector, privateLanUrl, type LanListener } from './config.js';
import { readProviderSetup, setupProviders, type Provider } from './provider-setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getDefaultCollectorDbPath(): string {
  return process.env.AGENT_DECK_DB_PATH || join(homedir(), '.agent-deck', 'collector.db');
}

export function getDefaultWebBuildDir(): string {
  return resolve(__dirname, '..', '..', 'web', 'build');
}

export function createProviderAdapters(providers: Provider[], enableAgyRemoteControl = false) {
  return providers.map(provider => {
    switch (provider) {
      case 'opencode': return new OpenCodeAdapter();
      case 'claude': return new ClaudeAdapter();
      case 'codex': return new CodexAdapter();
      case 'agy': return new AgyAdapter({ enableRemoteControl: enableAgyRemoteControl });
    }
  });
}

const usage = `Usage: agent-deck <start|status|doctor|setup|probe|devices|uninstall|pair|run|import|mcp>
From source: npm run agent-deck doctor (no -- separator needed for commands).
First run asks which providers to enable. Run setup again to change them.
Non-interactive: npm run agent-deck setup providers codex,opencode (or none).
Hook repair: setup claude / setup agy. Network access: setup tailscale.
Help and doctor are always available without setup.`;

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0] || 'start';
  const args = argv.slice(1);
  if (['help', '--help', '-h'].includes(cmd) || args.includes('--help')) { console.log(usage); return 0; }
  if (!['start', 'status', 'doctor', 'setup', 'probe', 'devices', 'uninstall', 'pair', 'run', 'import', 'mcp'].includes(cmd)) {
    console.error(`Unknown command: ${cmd}\n${usage}`); return 1;
  }
  if (cmd === 'setup' && args[0] && !['providers', 'claude', 'agy', 'tailscale'].includes(args[0])) {
    console.error(usage); return 1;
  }
  const shimName = process.platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook';
  const commandPath = resolve(__dirname, '..', '..', '..', 'tools', 'hook-shim', shimName);
  let providers: Provider[] = [];
  const providerWizard = cmd === 'setup' && (!args[0] || args[0] === 'providers');
  // Diagnostics, help, and explicit hook maintenance must remain usable when setup is broken.
  if (cmd !== 'doctor' && cmd !== 'uninstall' && (cmd !== 'setup' || providerWizard)) {
    const configStore = new CollectorStore(getDefaultCollectorDbPath());
    try {
      if (providerWizard) {
        if (args[0] === 'providers' && (!args[1] || args.length !== 2)) throw new Error('Usage: agent-deck setup providers codex,opencode (or none)');
        return await setupProviders(configStore, commandPath, args[1]) ? 0 : 1;
      }
      let setup = readProviderSetup(configStore);
      if (!setup) {
        if (!await setupProviders(configStore, commandPath)) return 1;
        setup = readProviderSetup(configStore)!;
      }
      providers = setup.providers;
    } finally { configStore.close(); }
  }
  if (cmd === 'mcp') { await runMcp(); return 0; }

  if (cmd === 'devices') {
    const store = new CollectorStore(getDefaultCollectorDbPath());
    try {
      const pairing = new CollectorEngine({ store }).pairing;
      if (args[0] === 'revoke' && args[1]) {
        if (!pairing.revokeDevice(args[1])) throw new Error('Unknown device ID. Use devices list.');
        console.log('Device revoked. Active LAN streams close within five seconds.');
      } else if (args[0] === 'revoke-all') {
        pairing.revokeAll();
        console.log('All LAN devices and outstanding pairing codes revoked.');
      } else if (!args[0] || args[0] === 'list') {
        console.table(pairing.listDevices());
      } else { throw new Error('Usage: agent-deck devices <list|revoke ID|revoke-all>'); }
    } finally { store.close(); }
    return 0;
  }

  if (cmd === 'setup' && args[0] === 'tailscale') {
    const httpsPort = Number(process.env.AGENT_DECK_SERVE_HTTPS_PORT || 443);
    const result = await configureTailscaleServe(collectorPort(), httpsPort);
    console.log(result.message);
    if (result.url) console.log(result.url);
    return result.ok ? 0 : 1;
  }

  if (cmd === 'probe') {
    const srcIdx = args.indexOf('--source');
    const source = (srcIdx >= 0 ? args[srcIdx + 1] : args[0] || 'opencode') as Source;
    if (source !== 'pty' && !providers.includes(source as Provider)) throw new Error(`Provider ${source} is disabled. Run setup to enable it.`);
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
    const tsUrl = await getTailscaleMagicDnsUrl(collectorPort());
    const report = {
      generatedAt: Date.now(),
      nodeVersion: process.version,
      platform: process.platform,
      collectorRunning: await checkCollector(),
      collectorUrl: collectorUrl(),
      tailscaleUrl: tsUrl,
      dbSizeBytes: store.getDbSizeBytes(),
      adapters: adapters.map((a) => adapterHealthToDoctor(a.health()))
    };
    console.log(formatDoctorReport(report));
    console.log('Provider rows show local detection and capabilities, not active collector connections.');
    if (!report.collectorRunning) console.log('Start the collector in a separate terminal and keep it open: npm run agent-deck start');
    store.close();
    return 0;
  }

  if (cmd === 'setup' && (args[0] === 'claude' || args[0] === 'agy')) {
    const dryRun = args.includes('--dry-run');
    const shimName = process.platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook';
    const exePath = resolve(__dirname, '..', '..', '..', 'tools', 'hook-shim', shimName);
    // Built by `npm run build:hooks`. Falls back to PATH for packaged installs
    // that ship the shim alongside the CLI instead of in the repo tree.
    if (!existsSync(exePath)) throw new Error('Hook shim missing. Run npm run build:hooks before setup.');
    const commandPath = exePath;
    const res = args[0] === 'agy' ? setupAgyHooks({ commandPath, dryRun }) : setupClaudeHooks({ commandPath, dryRun });
    console.log(res.diff);
    if (res.backupPath) {
      console.log(`\nBacked up original settings to: ${res.backupPath}`);
    }
    if (res.modified) {
      console.log(`${args[0] === 'agy' ? 'Antigravity' : 'Claude Code'} observer hooks installed.`);
    }
    return 0;
  }

  if (cmd === 'uninstall') {
    if (args[0] === 'agy') {
      const res = uninstallAgyHooks();
      console.log(res.restored ? 'Removed Agent Deck Antigravity hooks.' : 'No Antigravity hook changes found.');
      return 0;
    }
    const res = uninstallClaudeHooks();
    console.log(res.restored ? 'Removed agent-deck hooks from ~/.claude/settings.json.' : 'No Claude hook changes found.');
    return 0;
  }

  if (cmd === 'import') {
    const dbPath = getDefaultCollectorDbPath();
    const store = new CollectorStore(dbPath);
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const res = runHistoryBackfill(engine, { providers });
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
    if (args.includes('--local')) {
      const { code } = engine.pairing.generatePairingCode();
      console.log(`Local browser pairing code: ${code} (expires 5 min; no tablet QR)`);
      store.close();
      return 0;
    }
    // The collector may have been started in another terminal with different env.
    const listener = store.getSetting<LanListener>('lan_listener');
    const lanUrl = privateLanUrl(listener);
    if (!lanUrl || !await checkCollector(lanUrl)) {
      console.error('No running LAN listener was found. Tailscale users do not need pairing.');
      console.error('For local Wi-Fi, restart the collector with AGENT_DECK_LAN_HOST set to this PC\'s private IPv4 address.');
      console.error('Windows: ./start-local-wifi.ps1 -LanAddress <PC-private-IPv4>');
      store.close();
      return 1;
    }
    const { code } = engine.pairing.generatePairingCode();
    const qr = renderAsciiQr(`${lanUrl}?code=${code}`);
    console.log('  Scan to open Agent Deck on your tablet');
    console.log(qr);
    console.log(lanUrl);
    console.log(`                             code: ${code}  (expires 5 min)`);
    store.close();
    return 0;
  }

  if (cmd === 'status') {
    const online = await checkCollector();
    console.log(`Collector ${online ? 'ONLINE' : 'OFFLINE'} (${collectorUrl()})`);
    return online ? 0 : 1;
  }

  if (cmd === 'start') {
    const port = collectorPort();
    const dbPath = getDefaultCollectorDbPath();
    const store = new CollectorStore(dbPath);
    const modelCatalog = new ModelCatalogSync(store);
    const staticDir = getDefaultWebBuildDir();
    const engine = new CollectorEngine({
      store,
      staticDir: existsSync(staticDir) ? staticDir : undefined
    });

    const app = await buildHttpServer(engine, {
      staticDir: existsSync(staticDir) ? staticDir : undefined
    });
    const host = process.env.AGENT_DECK_HOST || '127.0.0.1';
    const lanHost = process.env.AGENT_DECK_LAN_HOST;
    let lanApp: Awaited<ReturnType<typeof buildHttpServer>> | undefined;
    const cleanup = async () => {
      if (lanApp) { lanApp.server.closeAllConnections(); await lanApp.close(); }
      app.server.closeAllConnections();
      await app.close();
      await engine.stopAdapters();
      await modelCatalog.stop();
      store.close();
    };
    try {
      if (host === '0.0.0.0' || host === '::') throw new Error('Refusing wildcard bind; use a specific local address.');
      if (lanHost && !privateLanUrl({ host: lanHost, port })) throw new Error('AGENT_DECK_LAN_HOST must be a specific private IPv4 address.');
      // Claim listeners before starting adapters, imports, or background jobs.
      await app.listen({ port, host });
      if (lanHost) {
        lanApp = await buildHttpServer(engine, { staticDir: existsSync(staticDir) ? staticDir : undefined });
        await lanApp.listen({ port, host: lanHost });
      }
      store.setSetting('lan_listener', lanHost ? { host: lanHost, port } : null);
      modelCatalog.start();
      // Bootstrap first-run 90-day history backfill if not yet run (§7.3)
      const importedProviders = store.getSetting<{ providers?: Provider[] }>('last_history_import')?.providers ?? [];
      const pendingProviders = providers.filter(provider => !importedProviders.includes(provider));
      if (process.env.AGENT_DECK_IMPORT_HISTORY !== '0' && pendingProviders.length) {
        runHistoryBackfill(engine, { providers: pendingProviders });
      }

      for (const adapter of createProviderAdapters(providers, engine.state.prefs.enableAgyRemoteControl)) engine.registerAdapter(adapter);
      engine.registerAdapter(new PtyAdapter());
      await engine.startAdapters();

    } catch (error) {
      await cleanup();
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Run npm run agent-deck doctor. Stop the existing collector in its terminal before restarting, or choose another AGENT_DECK_PORT.`);
        return 1;
      }
      throw error;
    }
    if (lanHost) console.log(`Local Wi-Fi: http://${lanHost}:${port} (device pairing required)`);
    const tsAddress = findTailscaleAddress();
    const tailscaleUrl = await getTailscaleMagicDnsUrl(port);
    console.log(
      `Agent Deck collector listening on http://${host}:${port}` +
        (tsAddress ? ` (tailnet interface: ${tsAddress})` : '') +
        (tailscaleUrl ? ` -> ${tailscaleUrl}` : '')
    );
    console.log('Keep this terminal open. Press Ctrl+C to stop. Run doctor in another terminal.');
    // Own the foreground lifecycle explicitly, including graceful terminal shutdown.
    await new Promise<void>(resolveStopped => {
      const stopped = () => {
        process.removeListener('SIGINT', stopped);
        process.removeListener('SIGTERM', stopped);
        app.server.removeListener('close', stopped);
        resolveStopped();
      };
      process.once('SIGINT', stopped);
      process.once('SIGTERM', stopped);
      app.server.once('close', stopped);
      app.server.ref();
    });
    await cleanup();
    return 0;
  }

  console.log(usage);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  runCli().then(code => { process.exitCode = code; }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
