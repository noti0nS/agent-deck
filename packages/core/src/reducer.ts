import {
  applyStatusEvent,
  compareRunsByPriority,
  createInitialRun
} from './status-engine.js';
import {
  DEFAULT_DECK_PREFS,
  type AdapterHealth,
  type AgentRun,
  type DeckAggregates,
  type DeckState,
  type Envelope,
  type FileChangedPayload,
  type HealthChangedPayload,
  type MessageCompletedPayload,
  type RunEndedPayload,
  type RunStartedPayload,
  type RunUpdatedPayload,
  type Source,
  type TodoUpdatedPayload,
  type UsageTickPayload,
  type WireFrame
} from './types.js';

const SOURCES: Source[] = ['opencode', 'claude', 'codex', 'agy', 'pty'];

export function createInitialDeckState(): DeckState {
  const adapters = {} as Record<Source, AdapterHealth>;
  for (const source of SOURCES) {
    adapters[source] = {
      source,
      status: 'off',
      capabilities: {
        liveEvents: false,
        usagePrecision: 'none',
        attention: false,
        subagents: false,
        notes: []
      }
    };
  }

  return {
    seq: 0,
    runs: {},
    adapters,
    aggregates: {
      todayTokensIn: 0,
      todayTokensOut: 0,
      todayCostExactUsd: 0,
      todayCostEstimatedUsd: 0,
      hasExactCost: false,
      hasEstimatedCost: false,
      activeCount: 0,
      waitingCount: 0,
      stalledCount: 0,
      failedCount: 0,
      burnRateTokensPerMin: 0,
      burnRateUsdPerMin: 0,
      burnRateAlarm: false
    },
    prefs: { ...DEFAULT_DECK_PREFS }
  };
}

export function reduceEnvelope(state: DeckState, env: Envelope): DeckState {
  // Ignore already-applied sequences if strictly older
  if (env.seq > 0 && env.seq <= state.seq) {
    return state;
  }

  const nextRuns: Record<string, AgentRun> = { ...state.runs };
  const nextAdapters: Record<Source, AdapterHealth> = { ...state.adapters };

  if (env.type === 'health.changed') {
    const p = env.payload as HealthChangedPayload;
    if (p?.adapter?.source) {
      nextAdapters[p.adapter.source] = p.adapter;
    }
    return {
      ...state,
      seq: Math.max(state.seq, env.seq),
      adapters: nextAdapters
    };
  }

  const runId = env.runId;
  if (!runId) {
    return {
      ...state,
      seq: Math.max(state.seq, env.seq)
    };
  }

  let run = nextRuns[runId];

  if (env.type === 'run.started') {
    const p = env.payload as RunStartedPayload;
    if (!run) {
      run = createInitialRun(runId, p, env.ts);
    } else {
      run = {
        ...run,
        title: p.title || run.title,
        subtitle: p.subtitle ?? run.subtitle,
        model: p.model || run.model,
        projectPath: p.projectPath || run.projectPath,
        projectName: p.projectName || run.projectName,
        parentId: p.parentId ?? run.parentId,
        agentMode: p.agentMode ?? run.agentMode,
        confidence: p.confidence ?? run.confidence,
        historical: p.historical ?? run.historical
      };
    }
    if (p.parentId && nextRuns[p.parentId]) {
      const parent = nextRuns[p.parentId];
      if (!parent.children.includes(runId)) {
        nextRuns[p.parentId] = {
          ...parent,
          children: [...parent.children, runId]
        };
      }
    }
    run.children = Object.values(nextRuns).filter(child => child.parentId === runId).map(child => child.id);
  }

  if (!run) {
    // Synthesize skeleton run if an event arrives before run.started
    const [sourcePart, ...nativeParts] = runId.split(':');
    const source = (SOURCES.includes(sourcePart as Source) ? sourcePart : 'pty') as Source;
    const nativeId = nativeParts.join(':') || runId;
    run = createInitialRun(
      runId,
      {
        source,
        nativeId,
        projectPath: '',
        projectName: nativeId.slice(0, 12),
        title: nativeId.slice(0, 12),
        model: 'unknown',
        confidence: 'live',
        startedAt: env.ts
      },
      env.ts
    );
  }

  // Apply StatusEngine first
  const transitioned = applyStatusEvent(run, env);
  run = transitioned.run;

  // Apply domain data updates
  switch (env.type) {
    case 'run.updated': {
      const p = env.payload as RunUpdatedPayload;
      run = {
        ...run,
        title: p.title ?? run.title,
        subtitle: p.subtitle ?? run.subtitle,
        model: p.model ?? run.model,
        agentMode: p.agentMode ?? run.agentMode,
        projectPath: p.projectPath ?? run.projectPath,
        projectName: p.projectName ?? run.projectName,
        parentId: p.parentId ?? run.parentId,
        confidence: p.confidence ?? run.confidence,
        unread: p.unread ?? run.unread,
        historical: p.historical ?? run.historical
      };
      if (p.parentId && nextRuns[p.parentId]) {
        const parent = nextRuns[p.parentId];
        if (!parent.children.includes(runId)) {
          nextRuns[p.parentId] = {
            ...parent,
            children: [...parent.children, runId]
          };
        }
      }
      break;
    }

    case 'run.ended': {
      const p = env.payload as RunEndedPayload;
      if (p.usage) {
        run.usage = {
          ...run.usage,
          ...p.usage
        };
      }
      break;
    }

    case 'message.completed': {
      const p = env.payload as MessageCompletedPayload;
      const previewText = (p.preview ?? '').slice(0, 400);
      const msg = {
        id: p.messageId ?? `${env.seq}`,
        role: p.role,
        preview: previewText,
        ts: env.ts
      };
      run.recentMessages = [msg, ...(run.recentMessages ?? []).filter(m => m.id !== msg.id || m.role !== msg.role)]
        .sort((a, b) => b.ts - a.ts).slice(0, 30);
      break;
    }

    case 'file.changed': {
      const p = env.payload as FileChangedPayload;
      const existing = (run.filesChanged ?? []).filter((f) => f.path !== p.path);
      run.filesChanged = [
        {
          path: p.path,
          additions: p.additions,
          deletions: p.deletions,
          ts: env.ts
        },
        ...existing
      ].slice(0, 50);
      break;
    }

    case 'todo.updated': {
      const p = env.payload as TodoUpdatedPayload;
      run.todos = [...(p.todos ?? [])].sort((a, b) => a.position - b.position);
      break;
    }

    case 'usage.tick': {
      const p = env.payload as UsageTickPayload;
      const usage = { ...run.usage };
      if (typeof p.tokensInTotal === 'number') {
        usage.tokensIn = p.tokensInTotal;
      } else if (typeof p.tokensInDelta === 'number') {
        usage.tokensIn += p.tokensInDelta;
      }

      if (typeof p.tokensOutTotal === 'number') {
        usage.tokensOut = p.tokensOutTotal;
      } else if (typeof p.tokensOutDelta === 'number') {
        usage.tokensOut += p.tokensOutDelta;
      }

      if (typeof p.tokensReasoningTotal === 'number') {
        usage.tokensReasoning = p.tokensReasoningTotal;
      } else if (typeof p.tokensReasoningDelta === 'number') {
        usage.tokensReasoning = (usage.tokensReasoning ?? 0) + p.tokensReasoningDelta;
      }

      if (typeof p.cacheReadTotal === 'number') {
        usage.cacheRead = p.cacheReadTotal;
      } else if (typeof p.cacheReadDelta === 'number') {
        usage.cacheRead = (usage.cacheRead ?? 0) + p.cacheReadDelta;
      }

      if (typeof p.cacheWriteTotal === 'number') {
        usage.cacheWrite = p.cacheWriteTotal;
      } else if (typeof p.cacheWriteDelta === 'number') {
        usage.cacheWrite = (usage.cacheWrite ?? 0) + p.cacheWriteDelta;
      }

      if (typeof p.costUsdTotal === 'number') {
        usage.costUsd = p.costUsdTotal;
      } else if (typeof p.costUsdDelta === 'number') {
        usage.costUsd = (usage.costUsd ?? 0) + p.costUsdDelta;
      }

      if (typeof p.activeMsTotal === 'number') {
        usage.activeMs = p.activeMsTotal;
      } else if (typeof p.activeMsDelta === 'number') {
        usage.activeMs += p.activeMsDelta;
      }

      if (typeof p.turn === 'number' && p.turn > usage.turns) {
        usage.turns = p.turn;
      }

      usage.costSource = p.costSource ?? usage.costSource;
      usage.precision = p.precision ?? usage.precision;
      run.usage = usage;
      break;
    }

    default:
      break;
  }

  nextRuns[runId] = run;
  const aggregates = computeDeckAggregates(nextRuns, state.prefs.burnRateAlarmUsdPerMin);

  return {
    ...state,
    seq: Math.max(state.seq, env.seq),
    runs: nextRuns,
    adapters: nextAdapters,
    aggregates
  };
}

export function reduceWireFrame(state: DeckState, frame: WireFrame, defaultTs = Date.now()): DeckState {
  let next = state;
  for (const item of frame) {
    const [seq, type, runId, payload, ts] = item;
    next = reduceEnvelope(next, {
      seq,
      type,
      runId,
      payload,
      ts: ts ?? defaultTs
    });
  }
  return next;
}

export function computeDeckAggregates(
  runsMap: Record<string, AgentRun>,
  burnRateAlarmUsdPerMin = 0.5
): DeckAggregates {
  const runs = Object.values(runsMap);
  let todayTokensIn = 0;
  let todayTokensOut = 0;
  let todayCostExactUsd = 0;
  let todayCostEstimatedUsd = 0;
  let hasExactCost = false;
  let hasEstimatedCost = false;
  let activeCount = 0;
  let waitingCount = 0;
  let stalledCount = 0;
  let failedCount = 0;
  let burnRateTokensPerMin = 0;
  let burnRateUsdPerMin = 0;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();

  for (const run of runs) {
    if (!run.historical && (run.status === 'running' || run.status === 'compacting' || run.status === 'starting')) {
      activeCount += 1;
    } else if (!run.historical && run.status === 'waiting') {
      waitingCount += 1;
    } else if (!run.historical && run.status === 'stalled') {
      stalledCount += 1;
    } else if (!run.historical && run.status === 'failed') {
      failedCount += 1;
    }

    const isToday = run.lastActivityAt >= startOfTodayMs || run.startedAt >= startOfTodayMs;
    if (isToday) {
      todayTokensIn += run.usage.tokensIn;
      todayTokensOut += run.usage.tokensOut;
      if (typeof run.usage.costUsd === 'number' && run.usage.costUsd > 0) {
        if (run.usage.costSource === 'tool' && run.usage.precision === 'exact') {
          todayCostExactUsd += run.usage.costUsd;
          hasExactCost = true;
        } else if (run.usage.costSource === 'estimated') {
          todayCostEstimatedUsd += run.usage.costUsd;
          hasEstimatedCost = true;
        }
      }
    }

    if (!run.historical && (run.status === 'running' || run.status === 'compacting')) {
      const durationMin = Math.max(1, (run.lastActivityAt - run.startedAt) / 60_000);
      burnRateTokensPerMin += (run.usage.tokensIn + run.usage.tokensOut) / durationMin;
      if (typeof run.usage.costUsd === 'number' && run.usage.costUsd > 0) {
        burnRateUsdPerMin += run.usage.costUsd / durationMin;
      }
    }
  }

  return {
    todayTokensIn,
    todayTokensOut,
    todayCostExactUsd: Number(todayCostExactUsd.toFixed(4)),
    todayCostEstimatedUsd: Number(todayCostEstimatedUsd.toFixed(4)),
    hasExactCost,
    hasEstimatedCost,
    activeCount,
    waitingCount,
    stalledCount,
    failedCount,
    burnRateTokensPerMin: Math.round(burnRateTokensPerMin),
    burnRateUsdPerMin: Number(burnRateUsdPerMin.toFixed(4)),
    burnRateAlarm: burnRateUsdPerMin >= burnRateAlarmUsdPerMin
  };
}

export function getSortedDeckRuns(runsMap: Record<string, AgentRun>): AgentRun[] {
  return Object.values(runsMap).sort(compareRunsByPriority);
}
