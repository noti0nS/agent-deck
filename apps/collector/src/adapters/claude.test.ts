import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import {
  ClaudeAdapter,
  CLAUDE_HOOK_EVENTS,
  normalizeClaudeHookDatagram,
  setupClaudeHooks,
  uninstallClaudeHooks
} from './claude.js';

describe('ClaudeAdapter, Hook Shim & Settings Setup/Uninstall', () => {
  it('uses native inventory busy/idle/waiting and observed disappearance without treating historical background state as execution', async () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const now = Date.now();
    let snapshot: unknown = [
      { sessionId: 'live', cwd: 'P:/demo', kind: 'interactive', startedAt: now - 600_000, pid: 123, status: 'busy' },
      { sessionId: 'background', cwd: 'P:/other', kind: 'background', startedAt: now - 600_000, state: 'working' },
      { sessionId: 'blocked', cwd: 'P:/blocked', kind: 'background', startedAt: now - 600_000, state: 'blocked' },
      { sessionId: 'waiting', cwd: 'P:/waiting', kind: 'interactive', startedAt: now - 600_000, pid: 124, status: 'waiting', waitingFor: 'permission prompt' }
    ];
    const adapter = new ClaudeAdapter({ udpPort: 0, listSessions: async () => snapshot });
    adapter['ctx'] = { emit: e => engine.ingest(e), reportHealth: h => engine.reportAdapterHealth(h), getSetting: () => undefined, setSetting: () => {} };
    engine.registerAdapter(adapter);
    try {
      await adapter.reconcileNativeSessions();
      expect(engine.state.runs['claude:live'].status).toBe('running');
      expect(adapter.sessionAlive('live')).toBe(true);
      engine.tickTimers(now + 300_000);
      expect(engine.state.runs['claude:live'].status).toBe('running');
      expect(engine.state.runs['claude:background'].status).toBe('detached');
      expect(engine.state.runs['claude:blocked'].status).toBe('detached');
      expect(engine.state.runs['claude:waiting'].status).toBe('waiting');
      expect(engine.state.runs['claude:waiting'].attention?.kind).toBe('permission');
      snapshot = [{ sessionId: 'live', cwd: 'P:/demo', kind: 'interactive', startedAt: now - 600_000, pid: 123, status: 'idle' }];
      await adapter.reconcileNativeSessions();
      expect(engine.state.runs['claude:live'].status).toBe('idle');
      expect(engine.state.runs['claude:blocked'].status).toBe('detached');
      snapshot = [];
      await adapter.reconcileNativeSessions();
      expect(engine.state.runs['claude:live'].status).toBe('detached');
      expect(adapter.sessionAlive('live')).toBe(false);
      snapshot = { malformed: true };
      await adapter.reconcileNativeSessions();
      expect(adapter.sessionAlive('live')).toBeUndefined();
    } finally { store.close(); }
  });

  it('discards a native inventory response that finishes after the adapter stops', async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    const emitted: unknown[] = [];
    const adapter = new ClaudeAdapter({ udpPort: 0, listSessions: () => pending });
    adapter['ctx'] = { emit: e => emitted.push(e), reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
    const request = adapter.reconcileNativeSessions();
    await adapter.stop();
    release([{ sessionId: 'late', cwd: 'P:/demo', kind: 'interactive', startedAt: Date.now(), pid: 1, status: 'busy' }]);
    await request;
    expect(emitted).toEqual([]);
    expect(adapter.sessionAlive('late')).toBeUndefined();
  });

  it('rejects duplicate, stale and out-of-order native datagrams after SessionEnd', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new ClaudeAdapter({ udpPort: 0 });
    adapter['ctx'] = { emit: e => engine.ingest(e), reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
    const now = Date.now();
    const closed = { _agent_deck_source: 'claude', session_id: 'closed', cwd: 'P:/demo', hook_event_name: 'SessionEnd', event_id: 'end', emitted_at_ms: now };
    try {
      expect(adapter.ingestHook(closed, now)).toBe(true);
      expect(adapter.ingestHook(closed, now)).toBe(false);
      expect(adapter.ingestHook({ ...closed, event_id: 'late', hook_event_name: 'PreToolUse', emitted_at_ms: now - 1000 }, now)).toBe(false);
      expect(adapter.ingestHook({ ...closed, event_id: 'old', emitted_at_ms: now - 300_000 }, now)).toBe(false);
      expect(engine.state.runs['claude:closed'].status).toBe('done');
    } finally { store.close(); }
  });

  it('preserves unrelated hooks and later settings, rejects malformed settings, and installs bounded observers', () => {
    const dir = join(tmpdir(), `agent-deck-claude-preserve-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const settingsPath = join(dir, 'settings.json');
    const custom = { matcher: 'Bash', hooks: [{ type: 'command', command: 'custom-audit' }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [custom] }, theme: 'dark' }));
    try {
      setupClaudeHooks({ settingsPath, commandPath: 'P:/Program Files/agent-deck-hook.exe' });
      const installed = JSON.parse(readFileSync(settingsPath, 'utf8'));
      for (const event of CLAUDE_HOOK_EVENTS) {
        const owned = installed.hooks[event].filter((entry: { _source?: string }) => entry._source === 'agent-deck');
        expect(owned).toHaveLength(1);
        expect(owned[0].hooks[0].timeout).toBe(2);
        expect(owned[0].hooks[0].command).toBe('P:/Program Files/agent-deck-hook.exe');
        expect(owned[0].hooks[0].args).toEqual(['--source', 'claude', '--udp-addr', '127.0.0.1:4101']);
        expect(owned[0].hooks[0].onFailure).toBe('continue');
      }
      expect(setupClaudeHooks({ settingsPath, commandPath: 'P:/Program Files/agent-deck-hook.exe' }).modified).toBe(false);
      installed.theme = 'light';
      writeFileSync(settingsPath, JSON.stringify(installed));
      uninstallClaudeHooks({ settingsPath });
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ hooks: { PreToolUse: [custom] }, theme: 'light' });
      writeFileSync(settingsPath, '{broken');
      expect(() => setupClaudeHooks({ settingsPath })).toThrow('invalid JSON');
      expect(readFileSync(settingsPath, 'utf8')).toBe('{broken');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('tracks native lifecycle and messages without tool sessions or transcript resurrection', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new ClaudeAdapter({ udpPort: 0 });
    adapter['ctx'] = { emit: e => engine.ingest(e), reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
    const send = (event: string, extra: Record<string, unknown> = {}) => adapter.ingestHook({ hook_event_name: event, session_id: 'native', cwd: 'P:/projects/demo', ...extra });
    try {
      send('SessionStart', { model: 'claude-opus-4-6' });
      expect(engine.state.runs['claude:native'].status).toBe('idle');
      send('UserPromptSubmit', { prompt: 'Fix the bug', prompt_id: 'prompt' });
      send('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tool_1', tool_input: { command: 'npm test' } });
      send('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'tool_1' });
      expect(engine.state.runs['claude:native'].status).toBe('waiting');
      send('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tool_1', error: 'exit 1' });
      expect(engine.state.runs['claude:native'].attention).toBeUndefined();
      send('MessageDisplay', { message_id: 'message', index: 0, delta: 'Fixed ' });
      send('MessageDisplay', { message_id: 'message', index: 1, delta: 'the bug.', final: true });
      send('MessageDisplay', { message_id: 'message', index: 1, delta: 'duplicate', final: true });
      expect(engine.state.runs['claude:native'].recentMessages?.[0].preview).toBe('Fixed the bug.');
      send('PreCompact');
      expect(engine.state.runs['claude:native'].status).toBe('compacting');
      send('PostCompact');
      send('Stop', { last_assistant_message: 'All fixed and tested.', prompt_id: 'prompt' });
      expect(engine.state.runs['claude:native'].status).toBe('idle');
      expect(engine.state.runs['claude:native'].recentMessages?.[0].preview).toBe('All fixed and tested.');
      adapter.tailJsonlFile(join(process.cwd(), 'fixtures/claude/session-fixture-1.jsonl'), 'native', 'P-projects-demo');
      expect(engine.state.runs['claude:native'].status).toBe('idle');
      expect(engine.state.runs['claude:native'].recentMessages?.[0].preview).toBe('All fixed and tested.');
      expect(Object.keys(engine.state.runs)).toEqual(['claude:native']);
      send('SessionEnd');
      expect(adapter.sessionAlive('native')).toBe(false);
      expect(engine.state.runs['claude:native'].status).toBe('done');
    } finally { store.close(); }
  });

  it('links subagents without completing the parent and ignores informational notifications', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const send = (event: string, extra: Record<string, unknown> = {}) => {
      for (const e of normalizeClaudeHookDatagram({ hook_event_name: event, session_id: 'parent', cwd: 'P:/demo', ...extra })) engine.ingest(e);
    };
    try {
      send('UserPromptSubmit', { prompt: 'Investigate' });
      send('SubagentStart', { agent_id: 'child', agent_type: 'Explore' });
      send('PreToolUse', { agent_id: 'child', tool_name: 'Read', tool_use_id: 'read' });
      send('SubagentStop', { agent_id: 'child', last_assistant_message: 'Found issue' });
      expect(engine.state.runs['claude:parent'].status).toBe('running');
      expect(engine.state.runs['claude:parent:agent:child'].parentId).toBe('claude:parent');
      expect(engine.state.runs['claude:parent:agent:child'].status).toBe('done');
      expect(normalizeClaudeHookDatagram({ session_id: 'parent', hook_event_name: 'Notification', notification_type: 'auth_success' })).toEqual([]);
      send('StopFailure', { error: 'rate_limit', last_assistant_message: 'Rate limit reached' });
      expect(engine.state.runs['claude:parent'].status).toBe('failed');
    } finally { store.close(); }
  });

  it('installs hooks idempotently with diff preview + backup and restores settings.json byte-for-byte on uninstall', () => {
    const tempDir = join(tmpdir(), `agent-deck-claude-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const settingsPath = join(tempDir, 'settings.json');
    const originalContent = '{\n  "theme": "dark",\n  "customSetting": 42\n}\n';
    writeFileSync(settingsPath, originalContent, 'utf8');

    const res1 = setupClaudeHooks({ settingsPath, commandPath: 'agent-deck-hook' });
    expect(res1.modified).toBe(true);
    expect(res1.diff).toContain('+      {');
    expect(res1.diff).toContain('agent-deck-hook');
    expect(res1.backupPath && existsSync(res1.backupPath)).toBe(true);

    const afterFirstInstall = readFileSync(settingsPath, 'utf8');
    // Second install must be idempotent
    setupClaudeHooks({ settingsPath, commandPath: 'agent-deck-hook' });
    const afterSecondInstall = readFileSync(settingsPath, 'utf8');
    expect(afterSecondInstall).toBe(afterFirstInstall);

    // Uninstall must restore byte-for-byte
    const unRes = uninstallClaudeHooks({ settingsPath });
    expect(unRes.restored).toBe(true);
    const restoredContent = readFileSync(settingsPath, 'utf8');
    expect(restoredContent).toBe(originalContent);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tails fixtures/claude/session-fixture-1.jsonl with persisted byte offsets and reconciles hand-summed token counts', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new ClaudeAdapter({ udpPort: 0 });

    adapter['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    const fixturePath = join(process.cwd(), 'fixtures', 'claude', 'session-fixture-1.jsonl');
    const count1 = adapter.tailJsonlFile(fixturePath, 'ses_claude_1', 'P-projects-demo');
    expect(count1).toBe(7);

    // Tailing again with no file growth reads 0 lines (persisted byte offset)
    const count2 = adapter.tailJsonlFile(fixturePath, 'ses_claude_1', 'P-projects-demo');
    expect(count2).toBe(0);

    const run = engine.state.runs['claude:ses_claude_1'];
    expect(run).toBeDefined();
    expect(run.title).toBe('Fix Windows path normalization in hook shim');
    expect(run.subtitle).toBe('Make sure the Claude hook shim exits 0 and tailer tracks byte offsets');
    expect(run.agentMode).toBe('accept-edits');
    // Hand-summed transcript tokens: 20,000 + 30,000 = 50,000 input; 1,500 + 2,500 = 4,000 output; 50,000 + 50,000 = 100,000 cacheRead
    expect(run.usage.tokensIn).toBe(50_000);
    expect(run.usage.tokensOut).toBe(4_000);
    expect(run.usage.cacheRead).toBe(100_000);
    expect(run.usage.precision).toBe('derived');
    expect(run.usage.costSource).toBe('estimated');
    expect(run.filesChanged?.[0]).toMatchObject({
      path: 'src/adapters/claude.ts',
      additions: 85,
      deletions: 4
    });

    // Apply live UDP hook events on top of transcript state
    for (const ev of normalizeClaudeHookDatagram({
      hook_event_name: 'Notification',
      session_id: 'ses_claude_1',
      message: 'Claude wants permission to run Bash(npm test)'
    })) {
      engine.ingest(ev);
    }
    expect(engine.state.runs['claude:ses_claude_1'].status).toBe('waiting');

    for (const ev of normalizeClaudeHookDatagram({
      hook_event_name: 'Stop',
      session_id: 'ses_claude_1'
    })) {
      // Stop while waiting stays waiting until cleared or resumed
      engine.ingest(ev);
    }
    store.close();
  });

  // The shim is a build artifact (`npm run build:hooks`), not a committed file,
  // so this test is skipped until it has been built on this machine.
  const shimName = process.platform === 'win32' ? 'agent-deck-hook.exe' : 'agent-deck-hook';
  const exePath = join(process.cwd(), 'tools', 'hook-shim', shimName);

  it.skipIf(!existsSync(exePath))('observes native payloads through compiled shim and loopback receiver without agent execution', async () => {
    const port = await new Promise<number>((resolve) => {
      const reservation = createSocket('udp4');
      reservation.bind(0, '127.0.0.1', () => {
        const selected = reservation.address().port;
        reservation.close(() => resolve(selected));
      });
    });
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new ClaudeAdapter({ udpPort: port, projectsDir: join(tmpdir(), `absent-claude-${Date.now()}`), pollIntervalMs: 60_000, listSessions: async () => [] });
    let terminal: () => void = () => {};
    const received = new Promise<void>(resolve => { terminal = resolve; });
    await adapter.start({ emit: e => { engine.ingest(e); if (e.type === 'run.ended') terminal(); },
      reportHealth: h => engine.reportAdapterHealth(h), getSetting: () => undefined, setSetting: () => {} });
    try {
      for (const payload of [
        { hook_event_name: 'SessionStart', source: 'startup' },
        { hook_event_name: 'UserPromptSubmit', prompt: 'Synthetic observer transport check' },
        { hook_event_name: 'Stop', last_assistant_message: 'Observer delivered the native message.' },
        { hook_event_name: 'SessionEnd' }
      ]) {
        const result = spawnSync(exePath, ['--source', 'claude', '--udp-addr', `127.0.0.1:${port}`], {
          input: JSON.stringify({ session_id: 'transport-check', cwd: 'P:/observer-test', ...payload }),
          timeout: 2000, encoding: 'utf8'
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }
      await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('Native hook was not received')), 3000))]);
      expect(Object.keys(engine.state.runs)).toEqual(['claude:transport-check']);
      expect(engine.state.runs['claude:transport-check'].status).toBe('done');
      expect(engine.state.runs['claude:transport-check'].recentMessages?.[0].preview).toBe('Observer delivered the native message.');
      expect(adapter.sessionAlive('transport-check')).toBe(false);
    } finally { await adapter.stop(); store.close(); }
  });

  it.skipIf(!existsSync(exePath))('executes the compiled hook shim, firing a UDP datagram and exiting 0 unconditionally', async () => {

    const received = await new Promise<string>((resolve) => {
      const server = createSocket('udp4');
      server.on('message', (msg) => {
        const str = msg.toString('utf8');
        server.close();
        resolve(str);
      });
      server.bind(0, '127.0.0.1', () => {
        const port = server.address().port;
        const payload = JSON.stringify({
          hook_event_name: 'PreToolUse',
          session_id: 'ses_shim_test',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' }
        });
        const res = spawnSync(exePath, [], {
          input: payload,
          env: { ...process.env, AGENT_DECK_UDP_ADDR: `127.0.0.1:${port}` },
          timeout: 2000
        });
        expect(res.status).toBe(0);
      });
    });

    const parsed = JSON.parse(received);
    expect(parsed.hook_event_name).toBe('PreToolUse');
    expect(parsed.session_id).toBe('ses_shim_test');
  });
});
