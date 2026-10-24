import { z } from 'zod';

export const SourceSchema = z.enum(['opencode', 'claude', 'codex', 'agy', 'pty']);
export const RunStatusSchema = z.enum([
  'starting',
  'running',
  'waiting',
  'compacting',
  'stalled',
  'idle',
  'done',
  'failed',
  'detached'
]);
export const ConfidenceSchema = z.enum(['live', 'polled', 'inferred']);
export const UsagePrecisionSchema = z.enum(['exact', 'derived', 'partial', 'none']);
export const CostSourceSchema = z.enum(['tool', 'estimated', 'none']);

export const StepSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  detail: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  ok: z.boolean().optional(),
  tool: z.string().optional()
});

export const TodoSchema = z.object({
  position: z.number(),
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
});

export const UsageSchema = z.object({
  tokensIn: z.number(),
  tokensOut: z.number(),
  tokensReasoning: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  costUsd: z.number().optional(),
  costSource: CostSourceSchema,
  precision: UsagePrecisionSchema.optional(),
  turns: z.number(),
  toolCalls: z.number(),
  activeMs: z.number()
});

export const AttentionSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['permission', 'question', 'error', 'idle_prompt']),
  summary: z.string(),
  resource: z.string().optional(),
  projectPath: z.string().optional(),
  requestedAt: z.number()
});

export const AgentRunSchema = z.object({
  id: z.string(),
  source: SourceSchema,
  nativeId: z.string(),
  parentId: z.string().optional(),
  projectPath: z.string(),
  projectName: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  model: z.string(),
  agentMode: z.string().optional(),
  status: RunStatusSchema,
  confidence: ConfidenceSchema,
  startedAt: z.number(),
  lastActivityAt: z.number(),
  endedAt: z.number().optional(),
  currentStep: StepSchema.optional(),
  todos: z.array(TodoSchema),
  usage: UsageSchema,
  attention: AttentionSchema.optional(),
  children: z.array(z.string()),
  unread: z.boolean(),
  historical: z.boolean().optional()
});

export const CapabilitiesSchema = z.object({
  liveEvents: z.boolean(),
  usagePrecision: UsagePrecisionSchema,
  attention: z.boolean(),
  subagents: z.boolean(),
  notes: z.array(z.string())
});

export const AdapterHealthSchema = z.object({
  source: SourceSchema,
  status: z.enum(['connected', 'degraded', 'off']),
  capabilities: CapabilitiesSchema,
  lastSeenAt: z.number().optional(),
  lastError: z.string().optional(),
  lagMs: z.number().optional()
});

export const EventTypeSchema = z.enum([
  'run.started',
  'run.updated',
  'run.ended',
  'state.changed',
  'turn.started',
  'turn.completed',
  'tool.started',
  'tool.completed',
  'message.completed',
  'file.changed',
  'todo.updated',
  'attention.raised',
  'attention.cleared',
  'usage.tick',
  'error.raised',
  'health.changed',
  'compact.started',
  'compact.completed'
]);

export const EnvelopeSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  type: EventTypeSchema,
  runId: z.string().optional(),
  payload: z.unknown()
});

export const DeckPrefsSchema = z.object({
  defaultView: z.enum(['ambient', 'deck', 'usage', 'ledger']).optional(),
  columns: z.union([z.literal(2), z.literal(3)]).optional(),
  stallWarnSeconds: z.number().min(10).max(3600).optional(),
  stallAlarmSeconds: z.number().min(30).max(7200).optional(),
  waitingEscalateSeconds: z.number().min(30).max(3600).optional(),
  ambientIdleSeconds: z.number().min(15).max(3600).optional(),
  nightDimStartHour: z.number().min(0).max(23).optional(),
  nightDimEndHour: z.number().min(0).max(23).optional(),
  burnRateAlarmUsdPerMin: z.number().min(0.01).max(100).optional(),
  enableAgyRemoteControl: z.boolean().optional()
});

export const PairRequestSchema = z.object({
  code: z.string().min(4).max(32)
});

export const UsageQuerySchema = z.object({
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  bucket: z.enum(['1h', '1d']).optional().default('1h'),
  by: z.enum(['project', 'model', 'source', 'day']).optional().default('project'),
  source: SourceSchema.optional(),
  project: z.string().optional(),
  model: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
  sortBy: z.enum(['cost', 'tokens', 'time', 'recent', 'unproductive']).optional().default('recent')
});

export const SnapshotResponseSchema = z.object({
  seq: z.number(),
  runs: z.array(AgentRunSchema),
  aggregates: z.object({
    todayTokensIn: z.number(),
    todayTokensOut: z.number(),
    todayCostExactUsd: z.number(),
    todayCostEstimatedUsd: z.number(),
    hasExactCost: z.boolean(),
    hasEstimatedCost: z.boolean(),
    activeCount: z.number(),
    waitingCount: z.number(),
    stalledCount: z.number(),
    failedCount: z.number(),
    burnRateTokensPerMin: z.number(),
    burnRateUsdPerMin: z.number(),
    burnRateAlarm: z.boolean()
  }),
  adapters: z.array(AdapterHealthSchema),
  config: z.object({
    prefs: DeckPrefsSchema,
    pricingVersion: z.string(),
    pricingUpdatedAt: z.string(),
    tailscaleUrl: z.string().optional()
  })
});

export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
export type UsageQuery = z.infer<typeof UsageQuerySchema>;
