import { describe, expect, it } from 'vitest';
import { applyStatusEvent, createInitialDeckState, createInitialRun, reduceEnvelope, type RunStatus } from './index.js';

const payload = { source: 'codex' as const, nativeId: 'thread', projectPath: '/project', projectName: 'project', title: 'project', model: 'test', confidence: 'live' as const };
describe('native lifecycle authority', () => {
  it('promotes an imported thread only when an authoritative observation explicitly makes it current', () => {
    const history = reduceEnvelope(createInitialDeckState(), { seq: 1, ts: 1000, type: 'run.started', runId: 'codex:thread', payload: { ...payload, historical: true } });
    const current = reduceEnvelope(history, { seq: 2, ts: 2000, type: 'run.updated', runId: 'codex:thread', payload: { historical: false, confidence: 'live' } });
    expect(current.runs['codex:thread'].historical).toBe(false);
    const replay = reduceEnvelope(current, { seq: 3, ts: 1000, type: 'run.started', runId: 'codex:thread', payload });
    expect(replay.runs['codex:thread'].historical).toBe(false);
  });
  it.each(['waiting', 'failed', 'running'] as RunStatus[])('reconciles %s from the server without fabricating recent activity', status => {
    const run = createInitialRun('codex:thread', payload, 1000);
    run.status = status;
    run.attention = { kind: 'permission', summary: 'Old approval', requestedAt: 1000 };
    const result = applyStatusEvent(run, { seq: 1, ts: 2000, type: 'state.changed', runId: run.id,
      payload: { from: status, to: 'idle', reason: 'codex_runtime', confidence: 'live' } });
    expect(result.run.status).toBe('idle');
    expect(result.run.lastActivityAt).toBe(1000);
    expect(result.run.attention).toBeUndefined();
  });
  it('reopens only explicit native SessionStart, not a historical replay', () => {
    const run = createInitialRun('codex:thread', payload, 1000);
    run.status = 'done'; run.endedAt = 1500;
    const event = { seq: 1, ts: 2000, type: 'run.started' as const, runId: run.id, payload };
    expect(applyStatusEvent(run, event).run.endedAt).toBe(1500);
    const resumed = applyStatusEvent(run, { ...event, payload: { ...payload, resumed: true } }).run;
    expect(resumed.endedAt).toBeUndefined();
    expect(resumed.status).toBe('idle');
  });
  it('counts a native invocation signal as activity without inventing a turn', () => {
    const run = createInitialRun('agy:conversation', { ...payload, source: 'agy' }, 1000);
    const result = applyStatusEvent(run, { seq: 1, ts: 2000, type: 'state.changed', runId: run.id,
      payload: { from: 'running', to: 'running', reason: 'agy_invocation_activity' } });
    expect(result.run.lastActivityAt).toBe(2000);
    expect(result.run.usage.turns).toBe(0);
  });
});
