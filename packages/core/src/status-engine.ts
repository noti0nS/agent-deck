import type {
  AgentRun,
  AttentionClearedPayload,
  AttentionRaisedPayload,
  Confidence,
  Envelope,
  ErrorRaisedPayload,
  RunEndedPayload,
  RunStartedPayload,
  RunStatus,
  ToolCompletedPayload,
  ToolStartedPayload,
  TurnCompletedPayload,
  TurnStartedPayload
} from './types.js';

export const STATUS_PRIORITY: Record<RunStatus, number> = {
  waiting: 90,
  failed: 80,
  stalled: 70,
  compacting: 60,
  running: 50,
  starting: 45,
  done: 40,
  idle: 30,
  detached: 20
};

export interface LivenessInput {
  alive: boolean;
  now: number;
  stallThresholdMs?: number; // default 120_000 (120 s)
  doneToIdleMs?: number;     // default 90_000 (90 s)
  liveWindowMs?: number;     // default 60_000 (60 s)
  pollWindowMs?: number;     // default 5_000 (5 s)
  lastPolledAt?: number;
}

export interface StatusTransitionResult {
  run: AgentRun;
  changed: boolean;
  from: RunStatus;
  to: RunStatus;
  reason: string;
}

export function compareRunsByPriority(a: AgentRun, b: AgentRun): number {
  const pa = STATUS_PRIORITY[a.status] ?? 0;
  const pb = STATUS_PRIORITY[b.status] ?? 0;
  if (pa !== pb) return pb - pa;
  return b.lastActivityAt - a.lastActivityAt;
}

export function computeConfidence(
  run: Pick<AgentRun, 'lastEventAt' | 'confidence'>,
  now: number,
  options?: { lastPolledAt?: number; liveWindowMs?: number; pollWindowMs?: number }
): Confidence {
  const liveWindowMs = options?.liveWindowMs ?? 60_000;
  const pollWindowMs = options?.pollWindowMs ?? 5_000;

  if (run.lastEventAt && now - run.lastEventAt <= liveWindowMs && run.confidence === 'live') {
    return 'live';
  }
  if (options?.lastPolledAt && now - options.lastPolledAt <= pollWindowMs) {
    return 'polled';
  }
  if (run.confidence === 'polled' && run.lastEventAt && now - run.lastEventAt <= liveWindowMs) {
    return 'polled';
  }
  return 'inferred';
}

export function createInitialRun(id: string, payload: RunStartedPayload, ts: number): AgentRun {
  const startedAt = payload.startedAt ?? ts;
  return {
    id,
    source: payload.source,
    nativeId: payload.nativeId,
    parentId: payload.parentId,
    projectPath: payload.projectPath,
    projectName: payload.projectName,
    title: payload.title || payload.projectName || id,
    subtitle: payload.subtitle,
    model: payload.model || 'unknown',
    agentMode: payload.agentMode,
    status: 'starting',
    confidence: payload.confidence,
    startedAt,
    lastActivityAt: ts,
    lastEventAt: ts,
    todos: [],
    usage: {
      tokensIn: 0,
      tokensOut: 0,
      costSource: 'none',
      precision: 'none',
      turns: 0,
      toolCalls: 0,
      activeMs: 0
    },
    children: [],
    unread: false,
    historical: payload.historical,
    filesChanged: [],
    recentMessages: [],
    recentSteps: [],
    activityTimeline: new Array(60).fill('none')
  };
}

/**
 * Pure StatusEngine transition function:
 * Given the previous AgentRun and a normalized Envelope, computes the next status
 * and step/attention updates deterministically without IO.
 */
export function applyStatusEvent(prev: AgentRun, env: Envelope): StatusTransitionResult {
  const from = prev.status;
  const run: AgentRun = {
    ...prev,
    todos: [...prev.todos],
    children: [...prev.children],
    usage: { ...prev.usage },
    filesChanged: prev.filesChanged ? [...prev.filesChanged] : [],
    recentMessages: prev.recentMessages ? [...prev.recentMessages] : [],
    recentSteps: prev.recentSteps ? [...prev.recentSteps] : [],
    activityTimeline: prev.activityTimeline ? [...prev.activityTimeline] : new Array(60).fill('none')
  };

  // Out-of-order protection: only advance lastEventAt monotonically
  const eventTs = Math.max(prev.lastEventAt ?? 0, env.ts);
  run.lastEventAt = eventTs;

  let to: RunStatus = from;
  let reason: string = env.type;

  switch (env.type) {
    case 'run.started': {
      if (from === 'detached') {
        // Reappeared
        to = prev.previousWorkingStatus ?? 'idle';
        reason = 'reconnected';
      } else if (from === 'starting') {
        to = 'starting';
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      break;
    }

    case 'attention.raised': {
      const p = env.payload as AttentionRaisedPayload;
      if (from !== 'waiting') {
        run.previousWorkingStatus = from === 'starting' ? 'running' : from;
      }
      run.attention = p.attention;
      to = 'waiting';
      reason = `attention:${p.attention.kind}`;
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, 'waiting');
      break;
    }

    case 'attention.cleared': {
      const p = env.payload as AttentionClearedPayload | undefined;
      run.attention = undefined;
      if (from === 'waiting') {
        to = run.endedAt ? 'done' : (run.previousWorkingStatus ?? 'running');
        reason = p?.reason ?? 'attention.cleared';
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      break;
    }

    case 'turn.started': {
      const p = env.payload as TurnStartedPayload;
      run.endedAt = undefined;
      run.doneAt = undefined;
      run.unread = false;
      run.usage.turns = Math.max(run.usage.turns + 1, p?.turn ?? run.usage.turns + 1);
      run.currentStep = {
        label: 'think',
        detail: p?.promptPreview ? p.promptPreview.slice(0, 80) : 'processing turn',
        startedAt: env.ts
      };
      // If attention was raised, starting a new turn means user answered in terminal
      if (from === 'waiting') {
        run.attention = undefined;
      }
      to = 'running';
      reason = 'turn.started';
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, 'thinking');
      break;
    }

    case 'tool.started': {
      const p = env.payload as ToolStartedPayload;
      const step = {
        id: p.stepId ?? `${env.seq}`,
        label: p.label,
        detail: p.detail,
        tool: p.tool ?? p.label,
        startedAt: env.ts
      };
      run.currentStep = step;
      run.usage.toolCalls += 1;
      if (from === 'waiting') {
        // Activity resumed -> clear sticky waiting
        run.attention = undefined;
      }
      to = 'running';
      reason = `tool:${p.label}`;
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, 'tool');
      break;
    }

    case 'tool.completed': {
      const p = env.payload as ToolCompletedPayload;
      const completedStep = {
        id: p.stepId ?? run.currentStep?.id ?? `${env.seq}`,
        label: p.label || run.currentStep?.label || 'tool',
        detail: p.detail ?? run.currentStep?.detail ?? '',
        tool: run.currentStep?.tool ?? p.label,
        startedAt: run.currentStep?.startedAt ?? Math.max(0, env.ts - (p.durationMs ?? 0)),
        endedAt: env.ts,
        ok: p.ok
      };
      run.recentSteps = [completedStep, ...(run.recentSteps ?? [])].slice(0, 50);
      if (p.durationMs && p.durationMs > 0) {
        run.usage.activeMs += p.durationMs;
      }
      if (from !== 'waiting' && from !== 'failed') {
        to = 'running';
        reason = 'tool.completed';
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, p.ok ? 'tool' : 'error');
      break;
    }

    case 'message.completed': {
      if (from === 'waiting') {
        // Unrelated message preview does not clear waiting unless activity explicitly resumes,
        // wait: rule says: "attention.raised -> waiting (sticky; survives unrelated events; clears when CLI resolves it or activity resumes)"
        // Wait: rule table ALSO says: "`tool.started`, `turn.started`, `message.completed` -> `running` bump lastActivityAt".
        // Let's respect sticky waiting on non-tool events unless attention was idle_prompt, OR keep waiting sticky against message.completed if permission is pending!
        if (run.attention && run.attention.kind === 'permission') {
          to = 'waiting';
        } else {
          run.attention = undefined;
          to = 'running';
        }
      } else if (from !== 'failed') {
        to = 'running';
      }
      if (from === 'compacting') {
        to = 'running';
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, 'thinking');
      break;
    }

    case 'compact.started': {
      if (from !== 'waiting' && from !== 'failed') {
        to = 'compacting';
        reason = 'compact.started';
        run.currentStep = {
          label: 'compact',
          detail: 'compacting context window',
          startedAt: env.ts
        };
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, 'thinking');
      break;
    }

    case 'compact.completed': {
      if (from === 'compacting') {
        to = 'running';
        reason = 'compact.completed';
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      break;
    }

    case 'turn.completed': {
      const p = env.payload as TurnCompletedPayload | undefined;
      if (p?.durationMs && p.durationMs > 0) {
        run.usage.activeMs = Math.max(run.usage.activeMs, p.durationMs);
      }
      if (from !== 'waiting' && from !== 'failed') {
        to = 'done';
        run.doneAt = env.ts;
        run.unread = true;
        run.currentStep = undefined;
        reason = 'turn.completed';
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      break;
    }

    case 'error.raised': {
      const p = env.payload as ErrorRaisedPayload;
      if (!p.recoverable) {
        to = 'failed';
        run.unread = true;
        run.attention = {
          kind: 'error',
          summary: p.message,
          requestedAt: env.ts
        };
        reason = `fatal:${p.message}`;
      }
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      pushActivityTick(run, 'error');
      break;
    }

    case 'run.ended': {
      const p = env.payload as RunEndedPayload;
      run.endedAt = p.endedAt ?? env.ts;
      run.attention = undefined;
      run.currentStep = undefined;
      to = p.outcome;
      if (p.outcome === 'done') {
        run.doneAt = run.endedAt;
      }
      if (p.outcome === 'done' || p.outcome === 'failed') {
        run.unread = true;
      }
      reason = `run.ended:${p.outcome}`;
      run.lastActivityAt = Math.max(run.lastActivityAt, env.ts);
      break;
    }

    case 'state.changed': {
      const p = env.payload as { from: RunStatus; to: RunStatus; reason: string; confidence?: Confidence };
      // Sticky waiting and failed rules:
      if (from === 'waiting' && p.to !== 'waiting' && p.reason !== 'attention.cleared' && p.to !== 'running') {
        to = 'waiting';
      } else if (from === 'failed' && p.to !== 'running' && p.to !== 'idle') {
        to = 'failed';
      } else {
        to = p.to;
        reason = p.reason;
      }
      if (p.confidence) {
        run.confidence = p.confidence;
      }
      break;
    }

    default: {
      // Other events (file.changed, todo.updated, usage.tick, run.updated)
      // Do not override sticky waiting or failed states.
      break;
    }
  }

  run.status = to;
  return {
    run,
    changed: from !== to,
    from,
    to,
    reason
  };
}

/**
 * Evaluates time-based and liveness-based state transitions:
 * - No event for > 120s while `running` and liveness ok -> `stalled`
 * - `done` for > 90s while session alive -> `idle`
 * - Liveness lost without end event -> `detached`
 * - Liveness lost, then reappears -> resume from last known (never fabricate `running`)
 */
export function evaluateLivenessAndTimers(prev: AgentRun, input: LivenessInput): StatusTransitionResult {
  const stallThresholdMs = input.stallThresholdMs ?? 120_000;
  const doneToIdleMs = input.doneToIdleMs ?? 90_000;
  const from = prev.status;
  let to: RunStatus = from;
  let reason = 'tick';

  const run: AgentRun = {
    ...prev,
    confidence: computeConfidence(prev, input.now, {
      lastPolledAt: input.lastPolledAt,
      liveWindowMs: input.liveWindowMs,
      pollWindowMs: input.pollWindowMs
    })
  };

  if (!input.alive) {
    if (from !== 'done' && from !== 'failed' && from !== 'detached' && !prev.endedAt) {
      run.previousWorkingStatus = from === 'running' ? 'idle' : from;
      to = 'detached';
      reason = 'liveness_lost';
    }
  } else {
    // Process/session is alive
    if (from === 'detached') {
      // Reappeared: resume from last known without fabricating `running`
      const resumeState = prev.previousWorkingStatus && prev.previousWorkingStatus !== 'running'
        ? prev.previousWorkingStatus
        : 'idle';
      to = resumeState;
      reason = 'liveness_restored';
    } else if (from === 'running') {
      const quietMs = Math.max(0, input.now - prev.lastActivityAt);
      if (quietMs > stallThresholdMs) {
        to = 'stalled';
        reason = `quiet_${Math.round(quietMs / 1000)}s`;
      }
    } else if (from === 'done' && !prev.endedAt) {
      const sinceDone = Math.max(0, input.now - (prev.doneAt ?? prev.lastActivityAt));
      if (sinceDone >= doneToIdleMs) {
        to = 'idle';
        reason = 'done_timeout_90s';
      }
    }
  }

  run.status = to;
  return {
    run,
    changed: from !== to,
    from,
    to,
    reason
  };
}

function pushActivityTick(run: AgentRun, tick: 'none' | 'thinking' | 'tool' | 'waiting' | 'error'): void {
  const timeline = run.activityTimeline ? [...run.activityTimeline] : new Array(60).fill('none');
  timeline.push(tick);
  while (timeline.length > 60) {
    timeline.shift();
  }
  run.activityTimeline = timeline;
}
