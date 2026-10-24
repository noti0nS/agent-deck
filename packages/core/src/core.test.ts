import { describe, expect, it } from 'vitest';
import {
  applyStatusEvent,
  compareRunsByPriority,
  computeConfidence,
  createInitialDeckState,
  createInitialRun,
  evaluateLivenessAndTimers,
  getSortedDeckRuns,
  reduceEnvelope,
  reduceWireFrame,
  type AgentRun,
  type Envelope,
  type RunStatus
} from './index.js';

function makeRun(status: RunStatus = 'running', ts = 1_000_000): AgentRun {
  const r = createInitialRun(
    'opencode:ses_1',
    {
      source: 'opencode',
      nativeId: 'ses_1',
      projectPath: 'P:\\projects\\demo',
      projectName: 'demo',
      title: 'Demo Session',
      model: 'gpt-5',
      confidence: 'live',
      startedAt: ts
    },
    ts
  );
  r.status = status;
  return r;
}

describe('StatusEngine table-driven transitions', () => {
  const cases: Array<{
    name: string;
    initial: RunStatus;
    event: Envelope;
    expected: RunStatus;
  }> = [
    {
      name: 'attention.raised -> waiting (from running)',
      initial: 'running',
      event: {
        seq: 1,
        ts: 1_001_000,
        type: 'attention.raised',
        runId: 'opencode:ses_1',
        payload: {
          attention: {
            kind: 'permission',
            summary: 'wants to run: dotnet test',
            requestedAt: 1_001_000
          }
        }
      },
      expected: 'waiting'
    },
    {
      name: 'waiting is sticky across unrelated file.changed or todo.updated',
      initial: 'waiting',
      event: {
        seq: 2,
        ts: 1_002_000,
        type: 'file.changed',
        runId: 'opencode:ses_1',
        payload: { path: 'src/index.ts', additions: 10, deletions: 2 }
      },
      expected: 'waiting'
    },
    {
      name: 'attention.cleared -> previous working state',
      initial: 'waiting',
      event: {
        seq: 3,
        ts: 1_003_000,
        type: 'attention.cleared',
        runId: 'opencode:ses_1',
        payload: { reason: 'resolved' }
      },
      expected: 'running'
    },
    {
      name: 'tool.started -> running & clears waiting',
      initial: 'waiting',
      event: {
        seq: 4,
        ts: 1_004_000,
        type: 'tool.started',
        runId: 'opencode:ses_1',
        payload: { label: 'bash', detail: 'npm test' }
      },
      expected: 'running'
    },
    {
      name: 'compact.started -> compacting',
      initial: 'running',
      event: {
        seq: 5,
        ts: 1_005_000,
        type: 'compact.started',
        runId: 'opencode:ses_1',
        payload: {}
      },
      expected: 'compacting'
    },
    {
      name: 'message.completed clears compacting -> running',
      initial: 'compacting',
      event: {
        seq: 6,
        ts: 1_006_000,
        type: 'message.completed',
        runId: 'opencode:ses_1',
        payload: { role: 'assistant', preview: 'Done compacting' }
      },
      expected: 'running'
    },
    {
      name: 'turn.completed -> done',
      initial: 'running',
      event: {
        seq: 7,
        ts: 1_007_000,
        type: 'turn.completed',
        runId: 'opencode:ses_1',
        payload: { turn: 1, durationMs: 5000 }
      },
      expected: 'done'
    },
    {
      name: 'fatal error.raised -> failed (sticky)',
      initial: 'running',
      event: {
        seq: 8,
        ts: 1_008_000,
        type: 'error.raised',
        runId: 'opencode:ses_1',
        payload: { message: 'Process crashed', recoverable: false }
      },
      expected: 'failed'
    },
    {
      name: 'failed stays sticky on tool.completed',
      initial: 'failed',
      event: {
        seq: 9,
        ts: 1_009_000,
        type: 'tool.completed',
        runId: 'opencode:ses_1',
        payload: { label: 'bash', ok: true }
      },
      expected: 'failed'
    }
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const prev = makeRun(tc.initial, 1_000_000);
      if (tc.initial === 'waiting') {
        prev.previousWorkingStatus = 'running';
        prev.attention = {
          kind: 'permission',
          summary: 'pending',
          requestedAt: 1_000_000
        };
      }
      const res = applyStatusEvent(prev, tc.event);
      expect(res.to).toBe(tc.expected);
      expect(res.run.status).toBe(tc.expected);
    });
  }

  it('transitions running -> stalled after > 120s quiet while alive', () => {
    const run = makeRun('running', 1_000_000);
    const before = evaluateLivenessAndTimers(run, { alive: true, now: 1_119_000 });
    expect(before.to).toBe('running');

    const after = evaluateLivenessAndTimers(run, { alive: true, now: 1_125_000 });
    expect(after.to).toBe('stalled');
    expect(after.changed).toBe(true);
  });

  it('transitions done -> idle after 90s while session alive', () => {
    const run = makeRun('done', 1_000_000);
    run.doneAt = 1_000_000;
    const before = evaluateLivenessAndTimers(run, { alive: true, now: 1_080_000 });
    expect(before.to).toBe('done');

    const after = evaluateLivenessAndTimers(run, { alive: true, now: 1_095_000 });
    expect(after.to).toBe('idle');
  });

  it('transitions to detached when liveness is lost, and resumes without fabricating running', () => {
    const run = makeRun('running', 1_000_000);
    const lost = evaluateLivenessAndTimers(run, { alive: false, now: 1_010_000 });
    expect(lost.to).toBe('detached');

    const restored = evaluateLivenessAndTimers(lost.run, { alive: true, now: 1_020_000 });
    expect(restored.to).toBe('idle');
    expect(restored.to).not.toBe('running');
  });

  it('computes confidence levels accurately (live, polled, inferred)', () => {
    const run = makeRun('running', 1_000_000);
    expect(computeConfidence(run, 1_030_000)).toBe('live');
    expect(computeConfidence(run, 1_070_000, { lastPolledAt: 1_068_000 })).toBe('polled');
    expect(computeConfidence(run, 1_070_000, { lastPolledAt: 1_050_000 })).toBe('inferred');
  });

  it('sorts runs strictly by priority: waiting > failed > stalled > compacting > running > done > idle > detached', () => {
    const statuses: RunStatus[] = [
      'detached',
      'idle',
      'done',
      'running',
      'compacting',
      'stalled',
      'failed',
      'waiting'
    ];
    const runs = statuses.map((s, idx) => {
      const r = makeRun(s, 1_000_000 + idx);
      r.id = `opencode:${s}`;
      return r;
    });
    const sorted = [...runs].sort(compareRunsByPriority);
    expect(sorted.map((r) => r.status)).toEqual([
      'waiting',
      'failed',
      'stalled',
      'compacting',
      'running',
      'done',
      'idle',
      'detached'
    ]);
  });

  it('handles out-of-order timestamps, clock skew, and duplicate sequence numbers in reducer', () => {
    let state = createInitialDeckState();
    const env1: Envelope = {
      seq: 1,
      ts: 2_000_000,
      type: 'run.started',
      runId: 'opencode:s1',
      payload: {
        source: 'opencode',
        nativeId: 's1',
        projectPath: '/p',
        projectName: 'p',
        title: 'Test',
        model: 'gpt-5',
        confidence: 'live'
      }
    };
    const env2Skew: Envelope = {
      seq: 2,
      ts: 1_990_000, // clock skew backwards 10s
      type: 'tool.started',
      runId: 'opencode:s1',
      payload: { label: 'bash', detail: 'ls' }
    };

    state = reduceEnvelope(state, env1);
    state = reduceEnvelope(state, env2Skew);
    // Duplicate seq 2 should be a no-op
    const stateDup = reduceEnvelope(state, env2Skew);
    expect(stateDup).toBe(state);
    expect(state.runs['opencode:s1'].lastActivityAt).toBe(2_000_000);
    expect(state.runs['opencode:s1'].usage.toolCalls).toBe(1);
  });

  it('property test: replaying recorded event log equals applying wireframe batches and snapshot', () => {
    const now = Date.now();
    const events: Envelope[] = [
      {
        seq: 1,
        ts: now - 50_000,
        type: 'run.started',
        runId: 'opencode:r1',
        payload: {
          source: 'opencode',
          nativeId: 'r1',
          projectPath: 'P:\\app',
          projectName: 'app',
          title: 'Build feature',
          model: 'claude-sonnet-4',
          confidence: 'live'
        }
      },
      {
        seq: 2,
        ts: now - 40_000,
        type: 'turn.started',
        runId: 'opencode:r1',
        payload: { turn: 1, promptPreview: 'Implement login' }
      },
      {
        seq: 3,
        ts: now - 30_000,
        type: 'tool.started',
        runId: 'opencode:r1',
        payload: { stepId: 'st1', label: 'edit', detail: 'src/auth.ts +20 -2' }
      },
      {
        seq: 4,
        ts: now - 20_000,
        type: 'file.changed',
        runId: 'opencode:r1',
        payload: { path: 'src/auth.ts', additions: 20, deletions: 2 }
      },
      {
        seq: 5,
        ts: now - 15_000,
        type: 'usage.tick',
        runId: 'opencode:r1',
        payload: {
          tokensInTotal: 15000,
          tokensOutTotal: 1200,
          costUsdTotal: 0.085,
          costSource: 'tool',
          precision: 'exact'
        }
      },
      {
        seq: 6,
        ts: now - 10_000,
        type: 'todo.updated',
        runId: 'opencode:r1',
        payload: {
          todos: [
            { position: 1, content: 'Write auth', status: 'completed' },
            { position: 2, content: 'Write tests', status: 'in_progress' }
          ]
        }
      },
      {
        seq: 7,
        ts: now - 5_000,
        type: 'turn.completed',
        runId: 'opencode:r1',
        payload: { turn: 1, durationMs: 35000 }
      }
    ];

    let stateSequential = createInitialDeckState();
    for (const ev of events) {
      stateSequential = reduceEnvelope(stateSequential, ev);
    }

    const wireFrame = events.map((e) => [e.seq, e.type, e.runId, e.payload, e.ts] as [number, typeof e.type, string | undefined, unknown, number]);
    const stateBatched = reduceWireFrame(createInitialDeckState(), wireFrame);

    expect(stateBatched).toEqual(stateSequential);
    expect(getSortedDeckRuns(stateBatched.runs)[0].status).toBe('done');
    expect(stateBatched.aggregates.todayTokensIn).toBe(15000);
    expect(stateBatched.aggregates.todayCostExactUsd).toBe(0.085);
    expect(stateBatched.aggregates.hasExactCost).toBe(true);
    expect(stateBatched.aggregates.hasEstimatedCost).toBe(false);
  });
});
