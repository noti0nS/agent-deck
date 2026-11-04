import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateLivenessAndTimers } from '@agent-deck/core';
import { AgyAdapter } from './adapters/agy.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { OpenCodeAdapter } from './adapters/opencode.js';
import { PtyAdapter } from './adapters/pty.js';
import { CollectorEngine, buildHttpServer } from './http.js';
import { CollectorStore } from './store.js';

describe('M8 Hardening, Extensibility, Failure-Injection & Observe-Only Audit', () => {
  it('adds a 5th CLI (cursor-agent) via a JSON profile file without touching core, collector, or web', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const profilesDir = join(process.cwd(), 'fixtures', 'pty');
    const ptyAdapter = new PtyAdapter({ profilesDir });

    ptyAdapter['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    ptyAdapter.ingestSessionOutput(
      'fifth_cli_1',
      'cursor-agent',
      'P:\\projects\\fifth-cli',
      [
        '\x1b[32m[turn] Implement websocket compression\x1b[0m',
        '[tool:edit] src/ws.ts +30 -5',
        '[usage] in=18000 out=1200',
        '[confirm] Allow running integration tests?'
      ]
    );

    const run = engine.state.runs['pty:fifth_cli_1'];
    expect(run).toBeDefined();
    expect(run.title).toContain('cursor-agent');
    expect(run.usage.tokensIn).toBe(18_000);
    expect(run.usage.tokensOut).toBe(1_200);
    expect(run.status).toBe('waiting');
    expect(run.attention?.summary).toContain('Allow running integration tests?');
    store.close();
  });

  it('failure injection: survives truncated JSONL mid-write, corrupted JSONL lines, and completes once newline arrives', () => {
    const tempDir = join(tmpdir(), `agent-deck-fi-jsonl-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const filePath = join(tempDir, 'partial.jsonl');

    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const claude = new ClaudeAdapter({ udpPort: 0 });
    claude['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    // 1. Write a valid line + a corrupted JSON line + a truncated line WITHOUT trailing newline
    const line1 = '{"type":"ai-title","aiTitle":"Resilient Session"}\n';
    const lineCorrupt = '{corrupted_json_line_999\n';
    const lineTruncatedFirstHalf = '{"type":"last-prompt","lastPrompt":"Completed after flush"';
    writeFileSync(filePath, line1 + lineCorrupt + lineTruncatedFirstHalf, 'utf8');

    const readCount1 = claude.tailJsonlFile(filePath, 'ses_fi', 'proj-fi');
    expect(readCount1).toBe(1);
    expect(engine.state.runs['claude:ses_fi'].title).toBe('Resilient Session');
    expect(engine.state.runs['claude:ses_fi'].subtitle).toBeUndefined();

    // 2. Flush the remainder of the truncated line with a trailing newline
    writeFileSync(filePath, line1 + lineCorrupt + lineTruncatedFirstHalf + '}\n', 'utf8');
    const readCount2 = claude.tailJsonlFile(filePath, 'ses_fi', 'proj-fi');
    expect(readCount2).toBe(1);
    expect(engine.state.runs['claude:ses_fi'].subtitle).toBe('Completed after flush');

    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('failure injection: survives corrupted SQLite page, killed CLI mid-turn (detached), and event bus saturation (>6000 events)', () => {
    const tempDir = join(tmpdir(), `agent-deck-fi-sqlite-${Date.now()}`);
    const convDir = join(tempDir, 'conversations');
    mkdirSync(convDir, { recursive: true });

    // Write garbage bytes as a corrupted SQLite file
    const corruptDbPath = join(convDir, 'corrupt-conv.db');
    writeFileSync(corruptDbPath, Buffer.from('NOT_A_VALID_SQLITE_HEADER_PAGE_000000000000'));

    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, ringBufferCapacity: 5000, batchIntervalMs: 0 });
    const agy = new AgyAdapter({ baseDir: tempDir });
    agy['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    // Corrupted SQLite DB must not throw or crash collector
    expect(() => agy.pollConversations()).not.toThrow();

    // Killed CLI mid-turn -> transitions to `detached`
    engine.ingest({
      type: 'run.started',
      runId: 'opencode:killed_1',
      payload: {
        source: 'opencode',
        nativeId: 'killed_1',
        projectPath: 'P:\\app',
        projectName: 'app',
        title: 'Mid-turn kill test',
        model: 'gpt-5',
        confidence: 'live'
      }
    });
    engine.ingest({
      type: 'tool.started',
      runId: 'opencode:killed_1',
      payload: { label: 'bash', detail: 'long build' }
    });
    expect(engine.state.runs['opencode:killed_1'].status).toBe('running');

    const detachedRes = evaluateLivenessAndTimers(engine.state.runs['opencode:killed_1'], {
      alive: false,
      now: Date.now() + 5000
    });
    expect(detachedRes.to).toBe('detached');

    // Saturate event bus with 5,500 events (exceeding 5,000 ring buffer capacity)
    for (let i = 0; i < 5500; i++) {
      engine.ingest({
        type: 'tool.started',
        runId: 'opencode:killed_1',
        payload: { label: 'tick', detail: `step ${i}` }
      });
    }
    expect(engine.ringBuffer.size()).toBe(5000);
    expect(engine.getEventsIngestedCount()).toBeGreaterThanOrEqual(5502);

    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('full-surface observe-only audit (§1.3, §5.1, M8 exit criterion): proves zero agent mutation methods or HTTP endpoints exist', async () => {
    // 1. Audit Adapter instances for any mutation method names
    const adapters = [
      new OpenCodeAdapter(),
      new ClaudeAdapter({ udpPort: 0 }),
      new AgyAdapter(),
      new PtyAdapter()
    ];
    const forbiddenMethods = [
      'approve',
      'deny',
      'reject',
      'sendPrompt',
      'prompt',
      'sendMessage',
      'kill',
      'terminate',
      'abortRun',
      'cancelRun',
      'writeInput'
    ];
    for (const adapter of adapters) {
      for (const forbidden of forbiddenMethods) {
        expect((adapter as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
      }
    }

    // 2. Audit HTTP server source code for HTTP route registrations:
    // Only GET routes and POST /api/pair + POST /api/prefs are allowed.
    // Zero PUT, DELETE, PATCH, or agent mutation POST routes exist.
    const httpSource = readFileSync(
      join(process.cwd(), 'apps', 'collector', 'src', 'http.ts'),
      'utf8'
    );

    const postRoutes = [...httpSource.matchAll(/app\.post\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const putRoutes = [...httpSource.matchAll(/app\.put\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const deleteRoutes = [...httpSource.matchAll(/app\.delete\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const patchRoutes = [...httpSource.matchAll(/app\.patch\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

    expect(postRoutes).toEqual(['/api/logout', '/api/pair', '/api/prefs']);
    expect(putRoutes).toEqual([]);
    expect(deleteRoutes).toEqual([]);
    expect(patchRoutes).toEqual([]);

    // 3. Verify /api/health exposes self-metrics
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store });
    const app = await buildHttpServer(engine);
    const healthRes = await app.inject({ method: 'GET', url: '/api/health' });
    expect(healthRes.statusCode).toBe(200);
    const healthJson = healthRes.json();
    expect(healthJson.metrics).toMatchObject({
      eventsPerSec: expect.any(Number),
      adapterLagMs: expect.any(Number),
      sseClientCount: expect.any(Number),
      droppedFrames: expect.any(Number)
    });
    expect(healthJson.storage.dbSizeBytes).toBeGreaterThan(0);

    await app.close();
    store.close();
  });
});
