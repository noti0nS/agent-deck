import { describe, expect, it } from 'vitest';
import { CollectorEngine } from './http.js';
import { CollectorStore } from './store.js';
import type { Adapter } from './adapter-spi.js';

describe('session evidence expiry', () => {
  it('expires starting and compacting history, persists it, and resumes only with new activity', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const now = Date.now();
    for (const id of ['empty', 'compact']) engine.ingest({ type: 'run.started', runId: `codex:${id}`, ts: now - 273 * 3600_000,
      payload: { source: 'codex', nativeId: id, projectPath: '/project', projectName: 'project', title: id, model: 'test', confidence: 'polled' } });
    engine.ingest({ type: 'compact.started', runId: 'codex:compact', ts: now - 138 * 3600_000, payload: {} });
    engine.tickTimers(now);
    expect(engine.state.aggregates.activeCount).toBe(0);
    expect(Object.values(store.loadAllRuns()).map(r => r.status)).toEqual(['detached', 'detached']);
    engine.tickTimers(now + 6000);
    expect(engine.state.runs['codex:compact'].status).toBe('detached');
    engine.ingest({ type: 'tool.started', runId: 'codex:compact', ts: now + 7000, payload: { stepId: 'call', label: 'tool', detail: 'test' } });
    expect(engine.state.runs['codex:compact'].status).toBe('running');
    expect(Object.keys(engine.state.runs)).toHaveLength(2);
    store.close();
  });

  it('uses session-specific liveness and reconciles stored states at startup', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const now = Date.now();
    engine.ingest({ type: 'run.started', runId: 'codex:alive', ts: now - 200_000,
      payload: { source: 'codex', nativeId: 'alive', projectPath: '/p', projectName: 'p', title: 'p', model: 't', confidence: 'polled' } });
    engine.registerAdapter({ source: 'codex', sessionAlive: (id: string) => id === 'alive',
      probe: async () => ({ liveEvents: false, attention: false, subagents: false, usagePrecision: 'none', notes: [] }),
      start: async () => {}, stop: async () => {}, health: () => engine.state.adapters.codex
    } satisfies Adapter);
    engine.tickTimers(now);
    expect(engine.state.runs['codex:alive'].status).toBe('starting');
    const restarted = new CollectorEngine({ store, batchIntervalMs: 0 });
    expect(restarted.state.runs['codex:alive'].status).toBe('detached');
    expect(restarted.state.aggregates.activeCount).toBe(0);
    store.close();
  });
});
