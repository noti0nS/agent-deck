export type Source = 'opencode' | 'claude' | 'codex' | 'agy' | 'pty';

export type RunStatus =
  | 'starting'    // process/session exists, no turn yet
  | 'running'     // actively working
  | 'waiting'     // blocked on a permission prompt or a question ← highest priority
  | 'compacting'  // context compaction in progress
  | 'stalled'     // was running, no activity > threshold
  | 'idle'        // session open, nothing happening
  | 'done'        // turn complete
  | 'failed'      // error / non-zero exit
  | 'detached';   // process gone without a clean end event

export type Confidence = 'live' | 'polled' | 'inferred';

export type UsagePrecision = 'exact' | 'derived' | 'partial' | 'none';
export type CostSource = 'tool' | 'estimated' | 'none';

export interface Step {
  id?: string;
  label: string;    // 'edit' | 'bash' | 'read' | 'think' | 'web' | 'mcp:name'
  detail: string;   // 'src/api/routes.ts +42 −7'
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  tool?: string;
}

export interface Todo {
  position: number;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  tokensReasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  costSource: CostSource;
  precision?: UsagePrecision;
  turns: number;
  toolCalls: number;
  activeMs: number;
}

// Read-only. The monitor reports that an agent is blocked and why;
// it can never answer on the user's behalf (P5).
export interface Attention {
  id?: string;
  kind: 'permission' | 'question' | 'error' | 'idle_prompt';
  summary: string;
  resource?: string;
  projectPath?: string;
  requestedAt: number;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  ts: number;
}

export interface MessagePreview {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  preview: string; // <= 400 chars
  ts: number;
}

export type ActivityTick = 'none' | 'thinking' | 'tool' | 'waiting' | 'error';

export interface AgentRun {
  id: string;                 // stable: `${source}:${nativeId}`
  source: Source;
  nativeId: string;
  parentId?: string;          // subagent tree
  projectPath: string;
  projectName: string;        // basename, disambiguated
  title: string;
  subtitle?: string;          // e.g. Codex thread_goal_updated or Claude last-prompt
  model: string;
  agentMode?: string;         // build / plan / accept-edits / auto
  status: RunStatus;
  previousWorkingStatus?: RunStatus; // used when clearing attention
  confidence: Confidence;
  startedAt: number;
  lastActivityAt: number;
  lastEventAt?: number;
  doneAt?: number;
  endedAt?: number;
  currentStep?: Step;         // one-line "now"
  activeSteps?: Step[];
  todos: Todo[];
  usage: Usage;
  attention?: Attention;      // display-only "needs you" indicator
  children: string[];
  unread: boolean;            // finished/failed since last viewed
  historical?: boolean;       // imported from history backfill
  filesChanged?: FileChange[];
  recentMessages?: MessagePreview[];
  recentSteps?: Step[];
  activityTimeline?: ActivityTick[]; // 60 buckets (1 per second)
}

export interface Capabilities {
  liveEvents: boolean;
  usagePrecision: UsagePrecision;
  attention: boolean;
  subagents: boolean;
  notes: string[];
}

export interface AdapterHealth {
  source: Source;
  status: 'connected' | 'degraded' | 'off';
  capabilities: Capabilities;
  lastSeenAt?: number;
  lastError?: string;
  lagMs?: number;
  transport?: 'poll' | 'udp' | 'sse';
  configured?: boolean;
  lastPolledAt?: number;
  lastEventAt?: number;
  parseErrors?: number;
  ignoredEvents?: number;
}

export type EventType =
  | 'run.started'
  | 'run.updated'
  | 'run.ended'
  | 'state.changed'
  | 'turn.started'
  | 'turn.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'message.completed'
  | 'file.changed'
  | 'todo.updated'
  | 'attention.raised'
  | 'attention.cleared'
  | 'usage.tick'
  | 'error.raised'
  | 'health.changed'
  | 'compact.started'
  | 'compact.completed';

export interface RunStartedPayload {
  source: Source;
  nativeId: string;
  parentId?: string;
  projectPath: string;
  projectName: string;
  title: string;
  subtitle?: string;
  model: string;
  agentMode?: string;
  confidence: Confidence;
  startedAt?: number;
  historical?: boolean;
}

export interface RunUpdatedPayload {
  title?: string;
  subtitle?: string;
  model?: string;
  agentMode?: string;
  projectPath?: string;
  projectName?: string;
  parentId?: string;
  confidence?: Confidence;
  unread?: boolean;
}

export interface RunEndedPayload {
  outcome: 'done' | 'failed' | 'detached';
  usage?: Partial<Usage>;
  endedAt?: number;
}

export interface StateChangedPayload {
  from: RunStatus;
  to: RunStatus;
  reason: string;
  confidence?: Confidence;
}

export interface TurnStartedPayload {
  turn: number;
  promptPreview?: string;
}

export interface TurnCompletedPayload {
  turn: number;
  durationMs?: number;
}

export interface ToolStartedPayload {
  stepId?: string;
  label: string;
  detail: string;
  tool?: string;
}

export interface ToolCompletedPayload {
  stepId?: string;
  label: string;
  detail?: string;
  durationMs?: number;
  ok?: boolean;
}

export interface MessageCompletedPayload {
  messageId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  preview: string;
}

export interface FileChangedPayload {
  path: string;
  additions: number;
  deletions: number;
}

export interface TodoUpdatedPayload {
  todos: Todo[];
}

export interface AttentionRaisedPayload {
  attention: Attention;
}

export interface AttentionClearedPayload {
  reason?: string;
}

export interface UsageTickPayload {
  sampleKey?: string; // (source, native_id, turn, seq)
  turn?: number;
  tokensInDelta?: number;
  tokensOutDelta?: number;
  tokensReasoningDelta?: number;
  cacheReadDelta?: number;
  cacheWriteDelta?: number;
  costUsdDelta?: number;
  // Or absolute counters when source reports totals per session/turn:
  tokensInTotal?: number;
  tokensOutTotal?: number;
  tokensReasoningTotal?: number;
  cacheReadTotal?: number;
  cacheWriteTotal?: number;
  costUsdTotal?: number;
  costSource: CostSource;
  precision: UsagePrecision;
  activeMsDelta?: number;
  activeMsTotal?: number;
}

export interface ErrorRaisedPayload {
  message: string;
  recoverable: boolean;
  code?: string;
}

export interface HealthChangedPayload {
  adapter: AdapterHealth;
}

export interface Envelope<T = unknown> {
  seq: number;        // monotonic, also the SSE `id:`
  ts: number;
  type: EventType;
  runId?: string;
  payload: T;
}

export type WireFrameItem = [seq: number, type: EventType, runId: string | undefined, payload: unknown, ts?: number];
export type WireFrame = WireFrameItem[];

export interface DeckAggregates {
  todayTokensIn: number;
  todayTokensOut: number;
  todayCostExactUsd: number;
  todayCostEstimatedUsd: number;
  hasExactCost: boolean;
  hasEstimatedCost: boolean;
  activeCount: number;
  waitingCount: number;
  stalledCount: number;
  failedCount: number;
  burnRateTokensPerMin: number;
  burnRateUsdPerMin: number;
  burnRateAlarm: boolean;
}

export interface DeckPrefs {
  defaultView: 'ambient' | 'deck' | 'usage' | 'ledger';
  columns: 2 | 3;
  stallWarnSeconds: number;
  stallAlarmSeconds: number;
  waitingEscalateSeconds: number;
  ambientIdleSeconds: number;
  nightDimStartHour: number;
  nightDimEndHour: number;
  burnRateAlarmUsdPerMin: number;
  enableAgyRemoteControl: boolean;
}

export const DEFAULT_DECK_PREFS: DeckPrefs = {
  defaultView: 'deck',
  columns: 2,
  stallWarnSeconds: 120,
  stallAlarmSeconds: 600,
  waitingEscalateSeconds: 300,
  ambientIdleSeconds: 180,
  nightDimStartHour: 22,
  nightDimEndHour: 7,
  burnRateAlarmUsdPerMin: 0.50,
  enableAgyRemoteControl: false
};

export interface DeckState {
  seq: number;
  runs: Record<string, AgentRun>;
  adapters: Record<Source, AdapterHealth>;
  aggregates: DeckAggregates;
  prefs: DeckPrefs;
}
