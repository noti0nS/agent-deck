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
  normalizeClaudeHookDatagram,
  setupClaudeHooks,
  uninstallClaudeHooks
} from './claude.js';

describe('ClaudeAdapter, Hook Shim & Settings Setup/Uninstall', () => {
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
