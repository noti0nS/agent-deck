import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { AgyAdapter } from './agy.js';
import { AGY_HOOK_NAME, AgyHookNormalizer, agyHookExecutable, agyHooksInstalled, buildAgyHooks, setupAgyHooks, uninstallAgyHooks } from './agy-hooks.js';

const common = { _agent_deck_source: 'agy', source: 'startup', conversationId: 'conversation-1', workspacePaths: ['P:\\projects\\demo'], modelName: 'gemini-test' };

describe('Antigravity native hooks configuration', () => {
  it.skipIf(process.platform !== 'win32')('runs a simple Windows executable through the cmd argument launcher', () => {
    const executablePath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
    const config = buildAgyHooks({}, executablePath) as any;
    const command = config[AGY_HOOK_NAME].PostToolUse[0].hooks[0].command as string;
    // Test the executable token through cmd.exe, including ordinary Win32 argv
    // quoting, instead of bypassing the shell as the native-shim tests do.
    const executable = command.split(' --source ')[0];
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `${executable} cmd.exe`], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('cmd.exe');
  });

  it('keeps paths that cmd.exe parses unquoted, including scoped npm installs', () => {
    const scopedPath = 'C:\\Users\\demo\\AppData\\Local\\nvm\\v24.13.1\\node_modules\\@noti0ns\\agent-deck\\tools\\hook-shim\\bin\\win32-x64\\agent-deck-hook.exe';
    expect(agyHookExecutable(scopedPath, 'win32')).toBe(scopedPath);
    expect(agyHookExecutable('C:\\Program Files\\agent-deck-hook.exe', 'win32')).toBe('"C:\\Program Files\\agent-deck-hook.exe"');
    expect(agyHookExecutable('/opt/agent deck/agent-deck-hook', 'linux')).toBe('"/opt/agent deck/agent-deck-hook"');
    const command = (buildAgyHooks({}, scopedPath) as any)[AGY_HOOK_NAME].Stop[0].command as string;
    if (process.platform === 'win32') {
      expect(command).toBe(`${scopedPath} --source agy --event Stop --udp-addr 127.0.0.1:4102`);
      expect(command).not.toContain('"');
    }
  });

  it('never installs a pre-tool observer and retires one left by an earlier install', () => {
    const hook = (event: string) => ({ type: 'command', command: `C:\\hook.exe --source agy --event ${event} --udp-addr 127.0.0.1:4102` });
    const dir = mkdtempSync(join(tmpdir(), 'agy-retired-'));
    const path = join(dir, 'hooks.json');
    const legacy = {
      [AGY_HOOK_NAME]: {
        enabled: true,
        SessionStart: [hook('SessionStart')],
        PreInvocation: [hook('PreInvocation')],
        PostInvocation: [hook('PostInvocation')],
        PreToolUse: [{ matcher: '*', hooks: [hook('PreToolUse')] }],
        PostToolUse: [{ matcher: '*', hooks: [hook('PostToolUse')] }],
        Stop: [hook('Stop')]
      }
    };
    writeFileSync(path, JSON.stringify(legacy));
    try {
      // A pre-tool hook that gates every tool call is not a usable observer.
      expect(agyHooksInstalled(path)).toBe(false);
      expect(setupAgyHooks({ hooksPath: path, commandPath: 'C:\\hook.exe' }).modified).toBe(true);
      const installed = JSON.parse(readFileSync(path, 'utf8'));
      expect(installed[AGY_HOOK_NAME].PreToolUse).toBeUndefined();
      expect(JSON.stringify(installed)).not.toContain('PreToolUse');
      expect(agyHooksInstalled(path)).toBe(true);
      expect(uninstallAgyHooks({ hooksPath: path }).restored).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('installs once, preserves all unrelated hooks and removes only the observer even after subsequent user edits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-hooks-'));
    const path = join(dir, 'hooks.json');
    const original = { custom: { PreInvocation: [{ type: 'command', command: 'my-check' }] } };
    writeFileSync(path, JSON.stringify(original));
    try {
      const first = setupAgyHooks({ hooksPath: path, commandPath: 'C:\\Program Files\\agent-deck-hook.exe' });
      expect(first.modified).toBe(true);
      expect(JSON.parse(readFileSync(first.backupPath!, 'utf8'))).toEqual(original);
      const installedText = readFileSync(path, 'utf8');
      expect(agyHooksInstalled(path)).toBe(true);
      expect(setupAgyHooks({ hooksPath: path, commandPath: 'C:\\Program Files\\agent-deck-hook.exe' }).modified).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(installedText);
      const installed = JSON.parse(installedText);
      expect(installed.custom).toEqual(original.custom);
      expect(installed[AGY_HOOK_NAME].PostToolUse[0].hooks[0].command).toContain('"C:\\Program Files\\agent-deck-hook.exe" --source agy --event PostToolUse');
      installed.later = { Stop: [{ command: 'later-user-hook' }] };
      writeFileSync(path, JSON.stringify(installed));
      expect(uninstallAgyHooks({ hooksPath: path }).restored).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...original, later: installed.later });
      expect(uninstallAgyHooks({ hooksPath: path }).restored).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses malformed JSON and a user-owned name collision without modifying the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-invalid-'));
    const path = join(dir, 'hooks.json');
    try {
      for (const text of ['{broken', '[]', JSON.stringify({ [AGY_HOOK_NAME]: { Stop: [{ command: 'user-command' }] } })]) {
        writeFileSync(path, text);
        expect(() => setupAgyHooks({ hooksPath: path })).toThrow();
        expect(readFileSync(path, 'utf8')).toBe(text);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('dry run makes no changes and disabled hooks do not claim live capability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-dry-'));
    const path = join(dir, 'hooks.json');
    try {
      writeFileSync(path, '{}');
      expect(setupAgyHooks({ hooksPath: path, dryRun: true }).diff).toContain('PreInvocation');
      expect(readFileSync(path, 'utf8')).toBe('{}');
      const config = buildAgyHooks({});
      (config[AGY_HOOK_NAME] as Record<string, unknown>).enabled = false;
      writeFileSync(path, JSON.stringify(config));
      expect(agyHooksInstalled(path)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Antigravity lifecycle event ingestion', () => {
  const shimPath = join(process.cwd(), 'tools', 'hook-shim', process.platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook');
  it.skipIf(!existsSync(shimPath))('observes lifecycle through the compiled shim without producing hook decisions on stdout', async () => {
    const reserve = createSocket('udp4');
    await new Promise<void>(resolve => reserve.bind(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise<void>(resolve => reserve.close(resolve));
    const dir = mkdtempSync(join(tmpdir(), 'agy-compiled-shim-'));
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ udpPort: port, baseDir: dir, hooksPath: join(dir, 'hooks.json') });
    const received: Record<string, unknown>[] = [];
    const ingest = adapter.ingestHookDatagram.bind(adapter);
    adapter.ingestHookDatagram = (raw, ts) => { received.push(raw); return ingest(raw, ts); };
    const native = { conversationId: 'native-shim-session', workspacePaths: ['P:\\projects\\shim-fixture'], modelName: 'gemini-test', source: 'native-source' };
    const send = async (event: string, extra: Record<string, unknown> = {}) => {
      const before = received.length;
      const result = spawnSync(shimPath, ['--source', 'agy', '--event', event, '--udp-addr', `127.0.0.1:${port}`], {
        input: JSON.stringify({ ...native, ...extra }), encoding: 'utf8', timeout: 5000, windowsHide: true
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      await expect.poll(() => received.length).toBe(before + 1);
    };
    try {
      setupAgyHooks({ hooksPath: join(dir, 'hooks.json'), commandPath: shimPath, udpPort: port });
      await adapter.start({ emit: ev => engine.ingest(ev), reportHealth: h => engine.reportAdapterHealth(h), getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v) });
      const beganAt = Date.now();
      await send('SessionStart');
      expect(engine.state.runs['agy:native-shim-session'].status).toBe('idle');
      await send('PreInvocation', { invocationNum: 0, initialNumSteps: 0 });
      expect(engine.state.runs['agy:native-shim-session'].status).toBe('running');
      await send('PreToolUse', { stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'fixture only' } } });
      await send('PostToolUse', { stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'fixture only' } }, error: '' });
      await send('Stop', { executionNum: 1, terminationReason: 'model_stop', fullyIdle: true, error: '' });
      const run = engine.state.runs['agy:native-shim-session'];
      expect(run.status).toBe('idle');
      expect(run.usage.toolCalls).toBe(1);
      expect(run.recentSteps).toHaveLength(1);
      expect(Object.keys(engine.state.runs)).toEqual(['agy:native-shim-session']);
      expect(new Set(received.map(item => item.event_id)).size).toBe(received.length);
      for (const item of received) {
        expect(item._agent_deck_source).toBe('agy');
        expect(item.source).toBe('native-source');
        expect(item.event_id).toMatch(/^[0-9a-f]{32}$/);
        expect(item.emitted_at_ms).toBeGreaterThanOrEqual(beganAt);
        expect(item.emitted_at_ms).toBeLessThanOrEqual(Date.now());
      }
      expect(adapter.health().lastEventAt).toBe(received.at(-1)!.emitted_at_ms);
      expect(adapter.sessionAlive('native-shim-session')).toBeUndefined();
    } finally { await adapter.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('receives native hook datagrams over loopback UDP without opening an agent session', async () => {
    const reserve = createSocket('udp4');
    await new Promise<void>(resolve => reserve.bind(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise<void>(resolve => reserve.close(resolve));
    const dir = mkdtempSync(join(tmpdir(), 'agy-udp-'));
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ udpPort: port, baseDir: dir, hooksPath: join(dir, 'hooks.json') });
    const sender = createSocket('udp4');
    try {
      setupAgyHooks({ hooksPath: join(dir, 'hooks.json'), udpPort: port });
      await adapter.start({ emit: ev => engine.ingest(ev), reportHealth: h => engine.reportAdapterHealth(h), getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v) });
      const data = Buffer.from(JSON.stringify({ ...common, hook_event_name: 'SessionStart' }));
      await new Promise<void>((resolve, reject) => sender.send(data, port, '127.0.0.1', error => error ? reject(error) : resolve()));
      await expect.poll(() => engine.state.runs['agy:conversation-1']?.status).toBe('idle');
      expect(adapter.health().capabilities.liveEvents).toBe(true);
      expect(adapter.health().lastEventAt).toBeGreaterThan(0);
    } finally { sender.close(); await adapter.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not let a delayed database snapshot resurrect a cycle already stopped by native hooks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-reconcile-'));
    const db = new Database(join(dir, 'conversation.db'));
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, step_payload BLOB)');
    db.prepare('INSERT INTO steps (idx,status,metadata) VALUES (0,2,?)').run('call_1  run_command  {"CommandLine":"test"}');
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ udpPort: 0, baseDir: dir });
    adapter['ctx'] = { emit: ev => engine.ingest(ev), reportHealth: h => engine.reportAdapterHealth(h), getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v) };
    try {
      adapter.ingestHookDatagram({ ...common, hook_event_name: 'Stop', fullyIdle: true });
      adapter.ingestConversationDb('conversation-1', join(dir, 'conversation.db'), undefined, -1, Date.now() + 100);
      expect(engine.state.runs['agy:conversation-1'].status).toBe('idle');
      expect(engine.state.runs['agy:conversation-1'].usage.toolCalls).toBe(0);
      expect(Object.keys(engine.state.runs)).toEqual(['agy:conversation-1']);
    } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps one conversation across model invocations and tool calls, deduplicates datagrams, and stops only when fully idle', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ udpPort: 0, baseDir: join(tmpdir(), 'missing-agy-base') });
    adapter['ctx'] = { emit: ev => engine.ingest(ev), reportHealth: h => engine.reportAdapterHealth(h), getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v) };
    const now = Date.now();
    const send = (event: string, extra = {}, ts = now) => adapter.ingestHookDatagram({ ...common, hook_event_name: event, ...extra }, ts);
    try {
      send('SessionStart');
      expect(engine.state.runs['agy:conversation-1'].status).toBe('idle');
      expect(engine.state.runs['agy:conversation-1'].usage.turns).toBe(0);
      send('PreInvocation', { invocationNum: 0 });
      send('PostInvocation', { invocationNum: 0 });
      const tool = { stepIdx: 3, toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } };
      send('PreToolUse', tool);
      expect(send('PreToolUse', tool)).toBe(0);
      send('PostToolUse', { ...tool, error: '' });
      send('PreInvocation', { invocationNum: 1 });
      expect(engine.state.runs['agy:conversation-1'].usage.turns).toBe(1);
      expect(engine.state.runs['agy:conversation-1'].usage.toolCalls).toBe(1);
      expect(engine.state.runs['agy:conversation-1'].recentSteps).toHaveLength(1);
      send('Stop', { fullyIdle: false, executionNum: 1 });
      expect(engine.state.runs['agy:conversation-1'].status).toBe('running');
      expect(adapter.sessionAlive('conversation-1')).toBe(true);
      send('Stop', { fullyIdle: true, executionNum: 1 });
      expect(engine.state.runs['agy:conversation-1'].status).toBe('idle');
      expect(adapter.sessionAlive('conversation-1')).toBeUndefined();
      send('PreInvocation', { invocationNum: 0 }, now + 2000);
      expect(engine.state.runs['agy:conversation-1'].usage.turns).toBe(2);
      expect(Object.keys(engine.state.runs)).toEqual(['agy:conversation-1']);
      expect(engine.state.runs['agy:conversation-1'].projectName).toBe('demo');
    } finally { store.close(); }
  });

  it('rejects wrong-source, missing identity, path traversal, and malformed tool events', () => {
    const normalizer = new AgyHookNormalizer();
    expect(normalizer.normalize({ ...common, _agent_deck_source: 'claude', hook_event_name: 'SessionStart' })).toEqual([]);
    expect(normalizer.normalize({ ...common, conversationId: '', hook_event_name: 'SessionStart' })).toEqual([]);
    expect(normalizer.normalize({ ...common, conversationId: '../secret', hook_event_name: 'SessionStart' })).toEqual([]);
    expect(normalizer.normalize({ ...common, hook_event_name: 'OtherEvent' })).toEqual([]);
    expect(normalizer.normalize({ ...common, hook_event_name: 'PreToolUse' })).toEqual([]);
  });

  it('reports fatal termination and does not invent session closure from Stop', () => {
    const normalizer = new AgyHookNormalizer();
    const events = normalizer.normalize({ ...common, hook_event_name: 'Stop', error: 'model failure', fullyIdle: true });
    expect(events.some(event => event.type === 'error.raised')).toBe(true);
    expect(events.some(event => event.type === 'run.ended')).toBe(false);
  });

  it('ignores replayed, stale and out-of-order datagrams after an authoritative stop', () => {
    const normalizer = new AgyHookNormalizer();
    const now = Date.now();
    const stop = { ...common, hook_event_name: 'Stop', fullyIdle: true, event_id: 'native-stop-1', emitted_at_ms: now };
    expect(normalizer.normalize(stop, now).length).toBeGreaterThan(0);
    expect(normalizer.normalize(stop, now + 10_000)).toEqual([]);
    expect(normalizer.normalize({ ...common, hook_event_name: 'PreInvocation', event_id: 'earlier', emitted_at_ms: now - 1 }, now)).toEqual([]);
    expect(normalizer.normalize({ ...common, hook_event_name: 'PreInvocation', event_id: 'stale', emitted_at_ms: now - 130_000 }, now)).toEqual([]);
    expect(normalizer.normalize({ ...common, hook_event_name: 'PreInvocation', event_id: 'next', emitted_at_ms: now + 1 }, now + 1).some(event => event.type === 'turn.started')).toBe(true);
  });
});
