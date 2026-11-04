import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_DECK_PREFS,
  type AdapterHealth,
  type AgentRun,
  type CostSource,
  type DeckPrefs,
  type Envelope,
  type Source,
  type Step,
  type Todo,
  type UsagePrecision
} from '@agent-deck/core';
import { Redactor, defaultRedactor } from '@agent-deck/redact';

export interface UsageSampleRecord {
  sampleKey: string; // idempotent key: `${source}:${nativeId}:${turn}:${seqOrPart}`
  runId: string;
  source: Source;
  project: string;
  model: string;
  ts: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  costSource: CostSource;
  precision: UsagePrecision;
  turns?: number;
  toolCalls?: number;
  activeMs?: number;
  historical?: boolean;
}

export interface UsageSummaryResult {
  from: number;
  to: number;
  tokensIn: number;
  tokensOut: number;
  tokensReasoning: number;
  cacheRead: number;
  cacheWrite: number;
  exactCostUsd: number;
  estimatedCostUsd: number;
  hasExactCost: boolean;
  hasEstimatedCost: boolean;
  runs: number;
  turns: number;
  toolCalls: number;
  activeMs: number;
  recentAvgDailyTokens: number;
  trendVsAvgPct: number;
  burnRateTokensPerMin: number;
  burnRateUsdPerMin: number;
  burnRateAlarm: boolean;
}

export interface TimeseriesBucket {
  bucketTs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costSource: CostSource | 'mixed';
  runs: number;
  turns: number;
  toolCalls: number;
  activeMs: number;
}

export interface BreakdownRow {
  key: string;
  tokensIn: number;
  tokensOut: number;
  exactCostUsd: number;
  estimatedCostUsd: number;
  precision: UsagePrecision | 'mixed';
  runs: number;
  turns: number;
  toolCalls: number;
  activeMs: number;
}

export class CollectorStore {
  public readonly db: Database.Database;
  public readonly dbPath: string;
  private readonly redactor: Redactor;

  constructor(dbPath = ':memory:', redactor: Redactor = defaultRedactor) {
    this.dbPath = dbPath;
    this.redactor = redactor;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = OFF');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        native_id TEXT NOT NULL,
        parent_id TEXT,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        agent_mode TEXT,
        status TEXT NOT NULL,
        confidence TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        ended_at INTEGER,
        active_ms INTEGER NOT NULL DEFAULT 0,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_runs_last_activity ON runs(last_activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source);
      CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_name);

      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        run_id TEXT,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id, seq DESC);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        label TEXT NOT NULL,
        detail TEXT NOT NULL,
        tool TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        ok INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps(run_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS todos (
        run_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (run_id, position)
      );

      CREATE TABLE IF NOT EXISTS attention (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        resource TEXT,
        requested_at INTEGER NOT NULL,
        cleared_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_attention_run_id ON attention(run_id, requested_at DESC);

      -- usage is the long-term asset: small, permanent, heavily indexed, idempotent via sample_key
      CREATE TABLE IF NOT EXISTS usage_samples (
        sample_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        cost_source TEXT NOT NULL,
        precision TEXT NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER NOT NULL DEFAULT 0,
        historical INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_samples_ts ON usage_samples(ts);
      CREATE INDEX IF NOT EXISTS idx_usage_samples_run ON usage_samples(run_id);

      -- pre-aggregated rollups, written on ingest, never computed on read
      CREATE TABLE IF NOT EXISTS agg_hourly (
        bucket_ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        exact_cost_usd REAL NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        runs INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket_ts, source, project, model)
      );

      CREATE TABLE IF NOT EXISTS agg_daily (
        days TEXT NOT NULL,
        source TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        exact_cost_usd REAL NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        runs INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (days, source, project, model)
      );

      CREATE TABLE IF NOT EXISTS adapters (
        source TEXT PRIMARY KEY,
        capabilities_json TEXT NOT NULL,
        health TEXT NOT NULL,
        last_seen_at INTEGER,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `);
  }

  public getLatestSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events').get() as {
      max_seq: number;
    };
    return row?.max_seq ?? 0;
  }

  public appendEvent(type: Envelope['type'], payload: unknown, runId?: string, ts = Date.now()): Envelope {
    const redactedPayload = this.redactor.redactValue(payload);
    const json = JSON.stringify(redactedPayload ?? {});
    const info = this.db
      .prepare('INSERT INTO events (ts, type, run_id, payload_json) VALUES (?, ?, ?, ?)')
      .run(ts, type, runId ?? null, json);
    const seq = Number(info.lastInsertRowid);
    return {
      seq,
      ts,
      type,
      runId,
      payload: redactedPayload
    };
  }

  public upsertRun(run: AgentRun): void {
    const sanitizedRun = this.redactor.redactValue(run);
    const meta = {
      subtitle: sanitizedRun.subtitle,
      previousWorkingStatus: sanitizedRun.previousWorkingStatus,
      lastEventAt: sanitizedRun.lastEventAt,
      doneAt: sanitizedRun.doneAt,
      currentStep: sanitizedRun.currentStep,
      usage: sanitizedRun.usage,
      attention: sanitizedRun.attention,
      children: sanitizedRun.children,
      unread: sanitizedRun.unread,
      historical: sanitizedRun.historical,
      filesChanged: sanitizedRun.filesChanged ?? [],
      recentMessages: sanitizedRun.recentMessages ?? [],
      recentSteps: sanitizedRun.recentSteps ?? [],
      activeSteps: sanitizedRun.activeSteps ?? [],
      activityTimeline: sanitizedRun.activityTimeline ?? []
    };

    this.db
      .prepare(
        `INSERT INTO runs (
          id, source, native_id, parent_id, project_path, project_name, title,
          model, agent_mode, status, confidence, started_at, last_activity_at,
          ended_at, active_ms, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          parent_id = excluded.parent_id,
          project_path = excluded.project_path,
          project_name = excluded.project_name,
          title = excluded.title,
          model = excluded.model,
          agent_mode = excluded.agent_mode,
          status = excluded.status,
          confidence = excluded.confidence,
          last_activity_at = excluded.last_activity_at,
          ended_at = excluded.ended_at,
          active_ms = excluded.active_ms,
          meta_json = excluded.meta_json`
      )
      .run(
        sanitizedRun.id,
        sanitizedRun.source,
        sanitizedRun.nativeId,
        sanitizedRun.parentId ?? null,
        sanitizedRun.projectPath,
        sanitizedRun.projectName,
        sanitizedRun.title,
        sanitizedRun.model,
        sanitizedRun.agentMode ?? null,
        sanitizedRun.status,
        sanitizedRun.confidence,
        sanitizedRun.startedAt,
        sanitizedRun.lastActivityAt,
        sanitizedRun.endedAt ?? null,
        sanitizedRun.usage.activeMs ?? 0,
        JSON.stringify(meta)
      );
  }

  public loadAllRuns(): Record<string, AgentRun> {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY last_activity_at DESC LIMIT 500')
      .all() as Array<Record<string, unknown>>;
    const todosRows = this.db.prepare('SELECT * FROM todos ORDER BY position ASC').all() as Array<{
      run_id: string;
      position: number;
      content: string;
      status: Todo['status'];
    }>;

    const todosByRun = new Map<string, Todo[]>();
    for (const t of todosRows) {
      const list = todosByRun.get(t.run_id) ?? [];
      list.push({ position: t.position, content: t.content, status: t.status });
      todosByRun.set(t.run_id, list);
    }

    const result: Record<string, AgentRun> = {};
    for (const r of rows) {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(String(r.meta_json || '{}'));
      } catch {
        meta = {};
      }
      const id = String(r.id);
      result[id] = {
        id,
        source: r.source as Source,
        nativeId: String(r.native_id),
        parentId: r.parent_id ? String(r.parent_id) : undefined,
        projectPath: String(r.project_path),
        projectName: String(r.project_name),
        title: String(r.title),
        subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : undefined,
        model: String(r.model),
        agentMode: r.agent_mode ? String(r.agent_mode) : undefined,
        status: r.status as AgentRun['status'],
        previousWorkingStatus: meta.previousWorkingStatus as AgentRun['status'] | undefined,
        confidence: r.confidence as AgentRun['confidence'],
        startedAt: Number(r.started_at),
        lastActivityAt: Number(r.last_activity_at),
        lastEventAt: typeof meta.lastEventAt === 'number' ? meta.lastEventAt : Number(r.last_activity_at),
        doneAt: typeof meta.doneAt === 'number' ? meta.doneAt : undefined,
        endedAt: r.ended_at ? Number(r.ended_at) : undefined,
        currentStep: meta.currentStep as Step | undefined,
        todos: todosByRun.get(id) ?? [],
        usage: (meta.usage as AgentRun['usage']) ?? {
          tokensIn: 0,
          tokensOut: 0,
          costSource: 'none',
          precision: 'none',
          turns: 0,
          toolCalls: 0,
          activeMs: Number(r.active_ms || 0)
        },
        attention: meta.attention as AgentRun['attention'],
        children: Array.isArray(meta.children) ? (meta.children as string[]) : [],
        unread: Boolean(meta.unread),
        historical: Boolean(meta.historical),
        filesChanged: Array.isArray(meta.filesChanged) ? (meta.filesChanged as AgentRun['filesChanged']) : [],
        recentMessages: Array.isArray(meta.recentMessages)
          ? (meta.recentMessages as AgentRun['recentMessages'])
          : [],
        recentSteps: Array.isArray(meta.recentSteps) ? (meta.recentSteps as AgentRun['recentSteps']) : [],
        activeSteps: Array.isArray(meta.activeSteps) ? (meta.activeSteps as Step[]) : [],
        activityTimeline: Array.isArray(meta.activityTimeline)
          ? (meta.activityTimeline as AgentRun['activityTimeline'])
          : new Array(60).fill('none')
      };
    }

    return result;
  }

  public recordStep(runId: string, step: Step): void {
    const id = step.id ?? `${runId}:${step.startedAt}:${step.label}`;
    const detail = this.redactor.redactString(step.detail);
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, label, detail, tool, started_at, ended_at, ok)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           detail = excluded.detail,
           ended_at = COALESCE(excluded.ended_at, steps.ended_at),
           ok = COALESCE(excluded.ok, steps.ok)`
      )
      .run(
        id,
        runId,
        step.label,
        detail,
        step.tool ?? null,
        step.startedAt,
        step.endedAt ?? null,
        step.ok === undefined ? null : step.ok ? 1 : 0
      );
  }

  public replaceTodos(runId: string, todos: Todo[]): void {
    const tx = this.db.transaction((items: Todo[]) => {
      this.db.prepare('DELETE FROM todos WHERE run_id = ?').run(runId);
      const stmt = this.db.prepare(
        'INSERT INTO todos (run_id, position, content, status) VALUES (?, ?, ?, ?)'
      );
      for (const t of items) {
        stmt.run(runId, t.position, this.redactor.redactString(t.content), t.status);
      }
    });
    tx(todos);
  }

  public recordAttention(runId: string, id: string, kind: string, summary: string, resource: string | undefined, requestedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO attention (id, run_id, kind, summary, resource, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(id, runId, kind, this.redactor.redactString(summary), resource ? this.redactor.redactString(resource) : null, requestedAt);
  }

  public clearAttention(runId: string, clearedAt: number): void {
    this.db
      .prepare('UPDATE attention SET cleared_at = ? WHERE run_id = ? AND cleared_at IS NULL')
      .run(clearedAt, runId);
  }

  /**
   * Idempotent usage sample ingest + write-time rollup into `agg_hourly` and `agg_daily`.
   * Returns `true` if the sample was newly inserted and rolled up, `false` if duplicate (`sampleKey` already existed).
   */
  public recordUsageSample(sample: UsageSampleRecord): boolean {
    const tx = this.db.transaction((s: UsageSampleRecord) => {
      const existing = this.db
        .prepare('SELECT sample_key FROM usage_samples WHERE sample_key = ?')
        .get(s.sampleKey);
      if (existing) {
        return false;
      }

      this.db
        .prepare(
          `INSERT INTO usage_samples (
            sample_key, run_id, source, project, model, ts,
            tokens_in, tokens_out, tokens_reasoning, cache_read, cache_write,
            cost_usd, cost_source, precision, turns, tool_calls, active_ms, historical
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          s.sampleKey,
          s.runId,
          s.source,
          s.project,
          s.model,
          s.ts,
          s.tokensIn,
          s.tokensOut,
          s.tokensReasoning,
          s.cacheRead,
          s.cacheWrite,
          s.costUsd,
          s.costSource,
          s.precision,
          s.turns ?? 0,
          s.toolCalls ?? 0,
          s.activeMs ?? 0,
          s.historical ? 1 : 0
        );

      const hourBucket = Math.floor(s.ts / 3_600_000) * 3_600_000;
      const dayStr = new Date(s.ts).toISOString().slice(0, 10);
      const exactCost = s.costSource === 'tool' && s.precision === 'exact' ? s.costUsd : 0;
      const estCost = s.costSource === 'estimated' ? s.costUsd : 0;

      // Check if this is the first sample for this run in this hour/day bucket
      const priorInHour = this.db
        .prepare(
          'SELECT COUNT(*) as c FROM usage_samples WHERE run_id = ? AND ts >= ? AND ts < ? AND sample_key != ?'
        )
        .get(s.runId, hourBucket, hourBucket + 3_600_000, s.sampleKey) as { c: number };
      const runIncHour = priorInHour.c === 0 ? 1 : 0;

      const dayStart = new Date(`${dayStr}T00:00:00.000Z`).getTime();
      const priorInDay = this.db
        .prepare(
          'SELECT COUNT(*) as c FROM usage_samples WHERE run_id = ? AND ts >= ? AND ts < ? AND sample_key != ?'
        )
        .get(s.runId, dayStart, dayStart + 86_400_000, s.sampleKey) as { c: number };
      const runIncDay = priorInDay.c === 0 ? 1 : 0;

      this.db
        .prepare(
          `INSERT INTO agg_hourly (
            bucket_ts, source, project, model,
            tokens_in, tokens_out, tokens_reasoning, cache_read, cache_write,
            cost_usd, exact_cost_usd, estimated_cost_usd,
            runs, turns, tool_calls, active_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bucket_ts, source, project, model) DO UPDATE SET
            tokens_in = agg_hourly.tokens_in + excluded.tokens_in,
            tokens_out = agg_hourly.tokens_out + excluded.tokens_out,
            tokens_reasoning = agg_hourly.tokens_reasoning + excluded.tokens_reasoning,
            cache_read = agg_hourly.cache_read + excluded.cache_read,
            cache_write = agg_hourly.cache_write + excluded.cache_write,
            cost_usd = agg_hourly.cost_usd + excluded.cost_usd,
            exact_cost_usd = agg_hourly.exact_cost_usd + excluded.exact_cost_usd,
            estimated_cost_usd = agg_hourly.estimated_cost_usd + excluded.estimated_cost_usd,
            runs = agg_hourly.runs + excluded.runs,
            turns = agg_hourly.turns + excluded.turns,
            tool_calls = agg_hourly.tool_calls + excluded.tool_calls,
            active_ms = agg_hourly.active_ms + excluded.active_ms`
        )
        .run(
          hourBucket,
          s.source,
          s.project,
          s.model,
          s.tokensIn,
          s.tokensOut,
          s.tokensReasoning,
          s.cacheRead,
          s.cacheWrite,
          s.costUsd,
          exactCost,
          estCost,
          runIncHour,
          s.turns ?? 0,
          s.toolCalls ?? 0,
          s.activeMs ?? 0
        );

      this.db
        .prepare(
          `INSERT INTO agg_daily (
            days, source, project, model,
            tokens_in, tokens_out, tokens_reasoning, cache_read, cache_write,
            cost_usd, exact_cost_usd, estimated_cost_usd,
            runs, turns, tool_calls, active_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(days, source, project, model) DO UPDATE SET
            tokens_in = agg_daily.tokens_in + excluded.tokens_in,
            tokens_out = agg_daily.tokens_out + excluded.tokens_out,
            tokens_reasoning = agg_daily.tokens_reasoning + excluded.tokens_reasoning,
            cache_read = agg_daily.cache_read + excluded.cache_read,
            cache_write = agg_daily.cache_write + excluded.cache_write,
            cost_usd = agg_daily.cost_usd + excluded.cost_usd,
            exact_cost_usd = agg_daily.exact_cost_usd + excluded.exact_cost_usd,
            estimated_cost_usd = agg_daily.estimated_cost_usd + excluded.estimated_cost_usd,
            runs = agg_daily.runs + excluded.runs,
            turns = agg_daily.turns + excluded.turns,
            tool_calls = agg_daily.tool_calls + excluded.tool_calls,
            active_ms = agg_daily.active_ms + excluded.active_ms`
        )
        .run(
          dayStr,
          s.source,
          s.project,
          s.model,
          s.tokensIn,
          s.tokensOut,
          s.tokensReasoning,
          s.cacheRead,
          s.cacheWrite,
          s.costUsd,
          exactCost,
          estCost,
          runIncDay,
          s.turns ?? 0,
          s.toolCalls ?? 0,
          s.activeMs ?? 0
        );

      return true;
    });

    return tx(sample);
  }

  public getUsageSummary(fromTs: number, toTs: number, activeRuns: AgentRun[], burnAlarmUsd = 0.5): UsageSummaryResult {
    const startBucket = Math.floor(fromTs / 3_600_000) * 3_600_000;
    const endBucket = Math.floor(toTs / 3_600_000) * 3_600_000;

    const rows = this.db
      .prepare('SELECT * FROM agg_hourly WHERE bucket_ts >= ? AND bucket_ts <= ?')
      .all(startBucket, endBucket) as Array<Record<string, number>>;

    let tokensIn = 0;
    let tokensOut = 0;
    let tokensReasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let exactCostUsd = 0;
    let estimatedCostUsd = 0;
    let runs = 0;
    let turns = 0;
    let toolCalls = 0;
    let activeMs = 0;

    for (const r of rows) {
      tokensIn += Number(r.tokens_in || 0);
      tokensOut += Number(r.tokens_out || 0);
      tokensReasoning += Number(r.tokens_reasoning || 0);
      cacheRead += Number(r.cache_read || 0);
      cacheWrite += Number(r.cache_write || 0);
      exactCostUsd += Number(r.exact_cost_usd || 0);
      estimatedCostUsd += Number(r.estimated_cost_usd || 0);
      runs += Number(r.runs || 0);
      turns += Number(r.turns || 0);
      toolCalls += Number(r.tool_calls || 0);
      activeMs += Number(r.active_ms || 0);
    }

    // Recent 7-day daily average from agg_daily
    const sevenDaysAgoStr = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const dailyRows = this.db
      .prepare('SELECT days, tokens_in, tokens_out FROM agg_daily WHERE days >= ?')
      .all(sevenDaysAgoStr) as Array<{ days: string; tokens_in: number; tokens_out: number }>;

    const byDay = new Map<string, number>();
    for (const d of dailyRows) {
      byDay.set(d.days, (byDay.get(d.days) ?? 0) + Number(d.tokens_in || 0) + Number(d.tokens_out || 0));
    }
    const dayTotals = Array.from(byDay.values());
    const recentAvgDailyTokens =
      dayTotals.length > 0 ? Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length) : 0;

    const currentTotalTokens = tokensIn + tokensOut;
    const trendVsAvgPct =
      recentAvgDailyTokens > 0
        ? Math.round(((currentTotalTokens - recentAvgDailyTokens) / recentAvgDailyTokens) * 100)
        : 0;

    let burnRateTokensPerMin = 0;
    let burnRateUsdPerMin = 0;
    for (const run of activeRuns) {
      if (!run.historical && (run.status === 'running' || run.status === 'compacting')) {
        const mins = Math.max(1, (run.lastActivityAt - run.startedAt) / 60_000);
        burnRateTokensPerMin += (run.usage.tokensIn + run.usage.tokensOut) / mins;
        if (run.usage.costUsd) {
          burnRateUsdPerMin += run.usage.costUsd / mins;
        }
      }
    }

    return {
      from: fromTs,
      to: toTs,
      tokensIn,
      tokensOut,
      tokensReasoning,
      cacheRead,
      cacheWrite,
      exactCostUsd: Number(exactCostUsd.toFixed(4)),
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      hasExactCost: exactCostUsd > 0,
      hasEstimatedCost: estimatedCostUsd > 0,
      runs,
      turns,
      toolCalls,
      activeMs,
      recentAvgDailyTokens,
      trendVsAvgPct,
      burnRateTokensPerMin: Math.round(burnRateTokensPerMin),
      burnRateUsdPerMin: Number(burnRateUsdPerMin.toFixed(4)),
      burnRateAlarm: burnRateUsdPerMin >= burnAlarmUsd
    };
  }

  public getUsageTimeseries(options: {
    from: number;
    to: number;
    bucket: '1h' | '1d';
    source?: Source;
    project?: string;
    model?: string;
  }): TimeseriesBucket[] {
    if (options.bucket === '1d') {
      const fromDay = new Date(options.from).toISOString().slice(0, 10);
      const toDay = new Date(options.to).toISOString().slice(0, 10);
      const rows = this.db
        .prepare('SELECT * FROM agg_daily WHERE days >= ? AND days <= ? ORDER BY days ASC')
        .all(fromDay, toDay) as Array<Record<string, unknown>>;

      const grouped = new Map<number, TimeseriesBucket>();
      for (const r of rows) {
        if (options.source && r.source !== options.source) continue;
        if (options.project && r.project !== options.project) continue;
        if (options.model && r.model !== options.model) continue;

        const bucketTs = new Date(`${String(r.days)}T00:00:00.000Z`).getTime();
        const prev = grouped.get(bucketTs) ?? {
          bucketTs,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          costSource: 'none',
          runs: 0,
          turns: 0,
          toolCalls: 0,
          activeMs: 0
        };
        prev.tokensIn += Number(r.tokens_in || 0);
        prev.tokensOut += Number(r.tokens_out || 0);
        prev.costUsd = Number((prev.costUsd + Number(r.cost_usd || 0)).toFixed(4));
        const hasExact = Number(r.exact_cost_usd || 0) > 0;
        const hasEst = Number(r.estimated_cost_usd || 0) > 0;
        if (hasExact && hasEst) prev.costSource = 'mixed';
        else if (hasEst) prev.costSource = prev.costSource === 'tool' ? 'mixed' : 'estimated';
        else if (hasExact) prev.costSource = prev.costSource === 'estimated' ? 'mixed' : 'tool';

        prev.runs += Number(r.runs || 0);
        prev.turns += Number(r.turns || 0);
        prev.toolCalls += Number(r.tool_calls || 0);
        prev.activeMs += Number(r.active_ms || 0);
        grouped.set(bucketTs, prev);
      }
      return Array.from(grouped.values()).sort((a, b) => a.bucketTs - b.bucketTs);
    }

    const startBucket = Math.floor(options.from / 3_600_000) * 3_600_000;
    const endBucket = Math.floor(options.to / 3_600_000) * 3_600_000;
    const rows = this.db
      .prepare('SELECT * FROM agg_hourly WHERE bucket_ts >= ? AND bucket_ts <= ? ORDER BY bucket_ts ASC')
      .all(startBucket, endBucket) as Array<Record<string, unknown>>;

    const grouped = new Map<number, TimeseriesBucket>();
    for (const r of rows) {
      if (options.source && r.source !== options.source) continue;
      if (options.project && r.project !== options.project) continue;
      if (options.model && r.model !== options.model) continue;

      const bucketTs = Number(r.bucket_ts);
      const prev = grouped.get(bucketTs) ?? {
        bucketTs,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        costSource: 'none',
        runs: 0,
        turns: 0,
        toolCalls: 0,
        activeMs: 0
      };
      prev.tokensIn += Number(r.tokens_in || 0);
      prev.tokensOut += Number(r.tokens_out || 0);
      prev.costUsd = Number((prev.costUsd + Number(r.cost_usd || 0)).toFixed(4));
      const hasExact = Number(r.exact_cost_usd || 0) > 0;
      const hasEst = Number(r.estimated_cost_usd || 0) > 0;
      if (hasExact && hasEst) prev.costSource = 'mixed';
      else if (hasEst) prev.costSource = prev.costSource === 'tool' ? 'mixed' : 'estimated';
      else if (hasExact) prev.costSource = prev.costSource === 'estimated' ? 'mixed' : 'tool';

      prev.runs += Number(r.runs || 0);
      prev.turns += Number(r.turns || 0);
      prev.toolCalls += Number(r.tool_calls || 0);
      prev.activeMs += Number(r.active_ms || 0);
      grouped.set(bucketTs, prev);
    }

    return Array.from(grouped.values()).sort((a, b) => a.bucketTs - b.bucketTs);
  }

  public getUsageBreakdown(options: {
    by: 'project' | 'model' | 'source' | 'day';
    from: number;
    to: number;
  }): BreakdownRow[] {
    const startBucket = Math.floor(options.from / 3_600_000) * 3_600_000;
    const endBucket = Math.floor(options.to / 3_600_000) * 3_600_000;
    const rows = this.db
      .prepare('SELECT * FROM agg_hourly WHERE bucket_ts >= ? AND bucket_ts <= ?')
      .all(startBucket, endBucket) as Array<Record<string, unknown>>;

    const grouped = new Map<string, BreakdownRow>();
    for (const r of rows) {
      let key = '';
      if (options.by === 'project') key = String(r.project || 'unknown');
      else if (options.by === 'model') key = String(r.model || 'unknown');
      else if (options.by === 'source') key = String(r.source || 'unknown');
      else key = new Date(Number(r.bucket_ts)).toISOString().slice(0, 10);

      const prev = grouped.get(key) ?? {
        key,
        tokensIn: 0,
        tokensOut: 0,
        exactCostUsd: 0,
        estimatedCostUsd: 0,
        precision: 'none',
        runs: 0,
        turns: 0,
        toolCalls: 0,
        activeMs: 0
      };

      prev.tokensIn += Number(r.tokens_in || 0);
      prev.tokensOut += Number(r.tokens_out || 0);
      const exact = Number(r.exact_cost_usd || 0);
      const est = Number(r.estimated_cost_usd || 0);
      prev.exactCostUsd = Number((prev.exactCostUsd + exact).toFixed(4));
      prev.estimatedCostUsd = Number((prev.estimatedCostUsd + est).toFixed(4));

      const rowPrec: UsagePrecision =
        exact > 0 ? 'exact' : est > 0 ? 'derived' : prev.tokensIn + prev.tokensOut > 0 ? 'partial' : 'none';
      if (prev.precision === 'none') prev.precision = rowPrec;
      else if (prev.precision !== rowPrec && rowPrec !== 'none') prev.precision = 'mixed';

      prev.runs += Number(r.runs || 0);
      prev.turns += Number(r.turns || 0);
      prev.toolCalls += Number(r.tool_calls || 0);
      prev.activeMs += Number(r.active_ms || 0);
      grouped.set(key, prev);
    }

    return Array.from(grouped.values()).sort(
      (a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)
    );
  }

  public upsertAdapterHealth(health: AdapterHealth): void {
    this.db
      .prepare(
        `INSERT INTO adapters (source, capabilities_json, health, last_seen_at, last_error)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           capabilities_json = excluded.capabilities_json,
           health = excluded.health,
           last_seen_at = excluded.last_seen_at,
           last_error = excluded.last_error`
      )
      .run(
        health.source,
        JSON.stringify(health.capabilities),
        health.status,
        health.lastSeenAt ?? null,
        health.lastError ?? null
      );
  }

  public getPrefs(): DeckPrefs {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('prefs') as { value_json: string } | undefined;
    if (!row) return { ...DEFAULT_DECK_PREFS };
    try {
      return { ...DEFAULT_DECK_PREFS, ...JSON.parse(row.value_json) };
    } catch {
      return { ...DEFAULT_DECK_PREFS };
    }
  }

  public setPrefs(prefs: Partial<DeckPrefs>): DeckPrefs {
    const merged = { ...this.getPrefs(), ...prefs };
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES ('prefs', ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(JSON.stringify(merged));
    return merged;
  }

  public getSetting<T>(key: string): T | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(key) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  public setSetting<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, JSON.stringify(value));
  }

  public runRetentionCleanup(now = Date.now()): { deletedEvents: number; deletedSteps: number; downsampledSamples: number } {
    const eventsCutoff = now - 14 * 86_400_000; // 14 days
    const stepsCutoff = now - 30 * 86_400_000;  // 30 days
    const downsampleCutoff = now - 24 * 3_600_000; // 24 hours

    const eRes = this.db.prepare('DELETE FROM events WHERE ts < ?').run(eventsCutoff);
    const sRes = this.db.prepare('DELETE FROM steps WHERE started_at < ?').run(stepsCutoff);

    // Downsample usage_samples older than 24h to 1/minute per (run_id, minute_bucket) while keeping rollups untouched (§7.3)
    const oldSamples = this.db
      .prepare('SELECT * FROM usage_samples WHERE ts < ? ORDER BY ts ASC')
      .all(downsampleCutoff) as Array<Record<string, unknown>>;

    let downsampledSamples = 0;
    const byRunMin = new Map<string, Array<Record<string, unknown>>>();
    for (const row of oldSamples) {
      const minBucket = Math.floor(Number(row.ts) / 60_000) * 60_000;
      const key = `${String(row.run_id)}:${minBucket}`;
      const list = byRunMin.get(key) ?? [];
      list.push(row);
      byRunMin.set(key, list);
    }

    const tx = this.db.transaction(() => {
      for (const [, rows] of byRunMin) {
        if (rows.length <= 1) continue;
        const first = rows[0];
        let tokIn = 0;
        let tokOut = 0;
        let tokReason = 0;
        let cRead = 0;
        let cWrite = 0;
        let cost = 0;
        let turns = 0;
        let tools = 0;
        let activeMs = 0;
        for (const r of rows) {
          tokIn += Number(r.tokens_in || 0);
          tokOut += Number(r.tokens_out || 0);
          tokReason += Number(r.tokens_reasoning || 0);
          cRead += Number(r.cache_read || 0);
          cWrite += Number(r.cache_write || 0);
          cost += Number(r.cost_usd || 0);
          turns += Number(r.turns || 0);
          tools += Number(r.tool_calls || 0);
          activeMs += Number(r.active_ms || 0);
        }
        this.db
          .prepare(
            `UPDATE usage_samples SET
              tokens_in = ?, tokens_out = ?, tokens_reasoning = ?,
              cache_read = ?, cache_write = ?, cost_usd = ?,
              turns = ?, tool_calls = ?, active_ms = ?
             WHERE sample_key = ?`
          )
          .run(tokIn, tokOut, tokReason, cRead, cWrite, Number(cost.toFixed(6)), turns, tools, activeMs, first.sample_key);

        for (let i = 1; i < rows.length; i++) {
          this.db.prepare('DELETE FROM usage_samples WHERE sample_key = ?').run(rows[i].sample_key);
          downsampledSamples += 1;
        }
      }
    });
    tx();

    return {
      deletedEvents: Number(eRes.changes),
      deletedSteps: Number(sRes.changes),
      downsampledSamples
    };
  }

  public getDbSizeBytes(): number {
    if (this.dbPath === ':memory:') {
      const pageCount = this.db.pragma('page_count', { simple: true }) as number;
      const pageSize = this.db.pragma('page_size', { simple: true }) as number;
      return (pageCount || 1) * (pageSize || 4096);
    }
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  public close(): void {
    this.db.close();
  }
}
