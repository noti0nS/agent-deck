import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import {
  OpenCodeAdapter,
  normalizeOpenCodeSseEvent,
  parseOpenCodeModel,
  type OpenCodeSessionRow
} from './opencode.js';

describe('OpenCodeAdapter & fixture replay', () => {
  it('uses session status events rather than persisted compaction timestamps', () => {
    const metadata = normalizeOpenCodeSseEvent({ type: 'session.updated', properties: { info: {
      id: 'ses_one', directory: 'P:/project', time: { compacting: 100, updated: 200 }
    } } }, 300);
    expect(metadata.some(event => event.type === 'compact.started')).toBe(false);
    for (const [type, expected] of [['busy', 'running'], ['retry', 'running'], ['idle', 'idle']]) {
      const events = normalizeOpenCodeSseEvent({ type: 'session.status', properties: { sessionID: 'ses_one', status: { type } } });
      expect(events.at(-1)?.runId).toBe('opencode:ses_one');
      expect(events.at(-1)?.payload).toMatchObject({ to: expected });
    }
  });

  it('does not infer running from a recent database update or an old compaction marker', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = { emit: event => engine.ingest(event), reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
    const row = JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'opencode', 'sessions.json'), 'utf8'))[0] as OpenCodeSessionRow;
    adapter.emitSessionRow(null, { ...row, time_updated: Date.now(), time_compacting: Date.now() - 86400000 });
    expect(engine.state.runs[`opencode:${row.id}`].status).toBe('idle');
    expect(adapter.sessionAlive(row.id)).toBeUndefined();
    store.close();
  });

  it('reconciles removed busy entries to idle and drops liveness on connection failure', async () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = { emit: event => engine.ingest(event), reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
    adapter['serviceUrl'] = 'http://existing-server';
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    try {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ses_one: { type: 'busy' } })));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'ses_one', directory: 'P:/real-project', title: 'Actual session' })));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ info: { id: 'msg_one', role: 'assistant' }, parts: [{ type: 'text', text: 'Latest session message' }] }])));
      await adapter.reconcileSessionStatuses();
      expect(adapter.sessionAlive('ses_one')).toBe(true);
      expect(engine.state.runs['opencode:ses_one'].status).toBe('running');
      expect(engine.state.runs['opencode:ses_one'].projectName).toBe('real-project');
      expect(engine.state.runs['opencode:ses_one'].recentMessages?.[0].preview).toBe('Latest session message');
      const row = JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'opencode', 'sessions.json'), 'utf8'))[0] as OpenCodeSessionRow;
      adapter.emitSessionRow(null, { ...row, id: 'ses_one', time_compacting: 1 });
      expect(engine.state.runs['opencode:ses_one'].status).toBe('running');
      expect(engine.state.runs['opencode:ses_one'].projectName).toBe('real-project');
      fetchMock.mockResolvedValueOnce(new Response('{}'));
      fetchMock.mockResolvedValueOnce(new Response('[]'));
      await adapter.reconcileSessionStatuses();
      expect(engine.state.runs['opencode:ses_one'].status).toBe('idle');
      expect(adapter.sessionAlive('ses_one')).toBeUndefined();
      // A delayed message on an already idle session must not resurrect Running.
      fetchMock.mockResolvedValueOnce(new Response('{}'));
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ info: { id: 'msg_final', role: 'assistant' }, parts: [{ type: 'text', text: 'Finished' }] }])));
      await adapter.reconcileSessionStatuses();
      expect(engine.state.runs['opencode:ses_one'].status).toBe('idle');
      expect(engine.state.runs['opencode:ses_one'].recentMessages?.[0].preview).toBe('Finished');
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ses_one: { type: 'busy' } })));
      fetchMock.mockResolvedValueOnce(new Response('[]'));
      await adapter.reconcileSessionStatuses();
      fetchMock.mockRejectedValueOnce(new Error('Disconnected'));
      await adapter.reconcileSessionStatuses();
      expect(adapter.sessionAlive('ses_one')).toBeUndefined();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ses_unknown: { type: 'busy' } })));
      fetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
      await adapter.reconcileSessionStatuses();
      expect(engine.state.runs['opencode:ses_unknown']).toBeUndefined();
    } finally {
      fetchMock.mockRestore();
      store.close();
    }
  });

  it('parses OpenCode model JSON and plain strings', () => {
    expect(parseOpenCodeModel('{"id":"gpt-5.6-luna-fast","providerID":"openai"}')).toBe(
      'gpt-5.6-luna-fast'
    );
    expect(parseOpenCodeModel('claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('replays fixtures/opencode/sessions.json and fixtures/opencode/events.jsonl deterministically', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new OpenCodeAdapter({ dbPath: 'nonexistent.db' });

    adapter['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    const sessionsRaw = readFileSync(
      join(process.cwd(), 'fixtures', 'opencode', 'sessions.json'),
      'utf8'
    );
    const sessions = JSON.parse(sessionsRaw) as OpenCodeSessionRow[];
    for (const s of sessions) {
      adapter.emitSessionRow(null, s, 'polled');
    }

    const parentRun = engine.state.runs['opencode:ses_opencode_fixture_1'];
    const childRun = engine.state.runs['opencode:ses_opencode_fixture_child'];
    expect(parentRun).toBeDefined();
    expect(childRun).toBeDefined();
    expect(parentRun.children).toContain('opencode:ses_opencode_fixture_child');
    expect(parentRun.usage.tokensIn).toBe(412000);
    expect(parentRun.usage.tokensOut).toBe(18000);
    expect(parentRun.usage.costUsd).toBe(0.1425);
    expect(parentRun.usage.precision).toBe('exact');
    expect(parentRun.usage.costSource).toBe('tool');

    // Replay SSE events from fixtures/opencode/events.jsonl
    const eventsLines = readFileSync(
      join(process.cwd(), 'fixtures', 'opencode', 'events.jsonl'),
      'utf8'
    )
      .trim()
      .split(/\r?\n/);

    for (const line of eventsLines) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const normalized = normalizeOpenCodeSseEvent(raw, 1792731210000);
      for (const ev of normalized) {
        engine.ingest(ev);
      }
    }

    const updatedParent = engine.state.runs['opencode:ses_opencode_fixture_1'];
    expect(updatedParent.todos).toHaveLength(2);
    expect(updatedParent.todos[0].status).toBe('completed');
    expect(updatedParent.status).toBe('done');
    store.close();
  });
});
