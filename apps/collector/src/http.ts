import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import {
  computeDeckAggregates,
  createInitialDeckState,
  evaluateLivenessAndTimers,
  getSortedDeckRuns,
  reduceEnvelope,
  type AdapterHealth,
  type AgentRun,
  type DeckState,
  type Envelope,
  type Source,
  type TodoUpdatedPayload,
  type ToolCompletedPayload,
  type ToolStartedPayload,
  type UsageTickPayload,
  type WireFrame
} from '@agent-deck/core';
import { getPriceTable } from '@agent-deck/pricing';
import { DeckPrefsSchema, PairRequestSchema, UsageQuerySchema } from '@agent-deck/protocol';
import { defaultRedactor } from '@agent-deck/redact';
import type { Adapter, EmitEventInput } from './adapter-spi.js';
import { PairingManager, getTailscaleMagicDnsUrl } from './pair.js';
import { RingBuffer } from './ring-buffer.js';
import { CollectorStore } from './store.js';
import { collectorPort } from './config.js';

export interface CollectorEngineOptions {
  store?: CollectorStore;
  ringBufferCapacity?: number;
  batchIntervalMs?: number; // default 100ms (10 Hz max)
  staticDir?: string;
  requireAuthForNonLoopback?: boolean;
  transcriptProvider?: (run: AgentRun, cursor: number, limit: number) => Promise<{ lines: Array<{ role: string; text: string; ts?: number }>; nextCursor: number | null }>;
  diffProvider?: (run: AgentRun, file?: string) => Promise<{ files: Array<{ path: string; additions: number; deletions: number; patch?: string }> }>;
}

interface SseClient {
  id: string;
  reply: FastifyReply;
  lastSentSeq: number;
}

export class CollectorEngine {
  public readonly store: CollectorStore;
  public readonly ringBuffer: RingBuffer;
  public readonly pairing: PairingManager;
  public state: DeckState;

  private readonly adapters = new Map<Source, Adapter>();
  private readonly sseClients = new Map<string, SseClient>();
  private pendingFrame: WireFrame = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private readonly batchIntervalMs: number;
  private readonly staticDir?: string;
  private readonly requireAuthForNonLoopback: boolean;
  private tailscaleUrl?: string;

  // Self-metrics for /api/health
  private eventsIngestedCount = 0;
  private droppedFramesCount = 0;
  private startedAtMs = Date.now();
  private recentEventTimestamps: number[] = [];

  private transcriptProvider?: CollectorEngineOptions['transcriptProvider'];
  private diffProvider?: CollectorEngineOptions['diffProvider'];

  constructor(options: CollectorEngineOptions = {}) {
    this.store = options.store ?? new CollectorStore(':memory:');
    this.ringBuffer = new RingBuffer(options.ringBufferCapacity ?? 5000);
    this.pairing = new PairingManager(this.store);
    this.batchIntervalMs = options.batchIntervalMs ?? 100;
    this.staticDir = options.staticDir;
    this.requireAuthForNonLoopback = options.requireAuthForNonLoopback ?? true;
    this.transcriptProvider = options.transcriptProvider;
    this.diffProvider = options.diffProvider;

    this.state = createInitialDeckState();
    this.state.seq = this.store.getLatestSeq();
    this.state.prefs = this.store.getPrefs();
    this.state.runs = this.store.loadAllRuns();
    this.state.aggregates = computeDeckAggregates(
      this.state.runs,
      this.state.prefs.burnRateAlarmUsdPerMin
    );
    this.tickTimers();
  }

  public setDetailProviders(
    transcriptProvider: CollectorEngineOptions['transcriptProvider'],
    diffProvider: CollectorEngineOptions['diffProvider']
  ): void {
    this.transcriptProvider = transcriptProvider;
    this.diffProvider = diffProvider;
  }

  public registerAdapter(adapter: Adapter): void {
    this.adapters.set(adapter.source, adapter);
  }

  public async startAdapters(): Promise<void> {
    this.tailscaleUrl = await getTailscaleMagicDnsUrl(collectorPort());
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.probe();
        this.reportAdapterHealth(adapter.health());
        await adapter.start({
          emit: (ev) => this.ingest(ev),
          reportHealth: (h) => this.reportAdapterHealth(h),
          getSetting: (k) => this.store.getSetting(k),
          setSetting: (k, v) => this.store.setSetting(k, v)
        });
      } catch (err) {
        this.reportAdapterHealth({
          source: adapter.source,
          status: 'degraded',
          capabilities: {
            liveEvents: false,
            usagePrecision: 'none',
            attention: false,
            subagents: false,
            notes: []
          },
          lastError: err instanceof Error ? err.message : String(err)
        });
      }
    }

    this.tickTimers();
    this.livenessTimer = setInterval(() => {
      this.tickTimers();
    }, 5_000);
    this.livenessTimer.unref();
  }

  public async stopAdapters(): Promise<void> {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    for (const client of this.sseClients.values()) {
      try {
        client.reply.raw.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();

    for (const adapter of this.adapters.values()) {
      try {
        await adapter.stop();
      } catch {
        // fail-open
      }
    }
  }

  public reportAdapterHealth(health: AdapterHealth): void {
    this.store.upsertAdapterHealth(health);
    this.ingest({
      type: 'health.changed',
      payload: { adapter: health }
    });
  }

  /**
   * Central event ingestion pipeline:
   * Redacts -> Persists to SQLite -> Applies StatusEngine & Reducer -> Updates Rollups -> Enqueues into RingBuffer & 10Hz SSE batcher.
   */
  public ingest(input: EmitEventInput): Envelope {
    const ts = input.ts ?? Date.now();
    const redactedPayload = defaultRedactor.redactValue(input.payload);
    const envelope = this.store.appendEvent(input.type, redactedPayload, input.runId, ts);

    this.eventsIngestedCount += 1;
    this.recentEventTimestamps.push(ts);
    while (this.recentEventTimestamps.length > 0 && this.recentEventTimestamps[0] < ts - 10_000) {
      this.recentEventTimestamps.shift();
    }

    const prevRun = input.runId ? this.state.runs[input.runId] : undefined;
    this.state = reduceEnvelope(this.state, envelope);
    const nextRun = input.runId ? this.state.runs[input.runId] : undefined;

    if (nextRun && input.runId) {
      this.store.upsertRun(nextRun);

      if (input.type === 'tool.started') {
        const p = redactedPayload as ToolStartedPayload;
        this.store.recordStep(input.runId, {
          id: p.stepId ?? `${envelope.seq}`,
          label: p.label,
          detail: p.detail,
          tool: p.tool ?? p.label,
          startedAt: ts
        });
      } else if (input.type === 'tool.completed') {
        const p = redactedPayload as ToolCompletedPayload;
        this.store.recordStep(input.runId, {
          id: p.stepId ?? `${envelope.seq}`,
          label: p.label || 'tool',
          detail: p.detail ?? '',
          startedAt: Math.max(0, ts - (p.durationMs ?? 0)),
          endedAt: ts,
          ok: p.ok
        });
      } else if (input.type === 'todo.updated') {
        const p = redactedPayload as TodoUpdatedPayload;
        this.store.replaceTodos(input.runId, p.todos ?? []);
      } else if (input.type === 'attention.raised' && nextRun.attention) {
        this.store.recordAttention(
          input.runId,
          nextRun.attention.id ?? `${input.runId}:${ts}`,
          nextRun.attention.kind,
          nextRun.attention.summary,
          nextRun.attention.resource,
          nextRun.attention.requestedAt
        );
      } else if (input.type === 'attention.cleared') {
        this.store.clearAttention(input.runId, ts);
      } else if (input.type === 'usage.tick') {
        const p = redactedPayload as UsageTickPayload;
        const deltaIn =
          typeof p.tokensInDelta === 'number'
            ? p.tokensInDelta
            : typeof p.tokensInTotal === 'number'
              ? Math.max(0, p.tokensInTotal - (prevRun?.usage.tokensIn ?? 0))
              : 0;
        const deltaOut =
          typeof p.tokensOutDelta === 'number'
            ? p.tokensOutDelta
            : typeof p.tokensOutTotal === 'number'
              ? Math.max(0, p.tokensOutTotal - (prevRun?.usage.tokensOut ?? 0))
              : 0;
        const deltaReasoning =
          typeof p.tokensReasoningDelta === 'number'
            ? p.tokensReasoningDelta
            : typeof p.tokensReasoningTotal === 'number'
              ? Math.max(0, p.tokensReasoningTotal - (prevRun?.usage.tokensReasoning ?? 0))
              : 0;
        const deltaCacheRead =
          typeof p.cacheReadDelta === 'number'
            ? p.cacheReadDelta
            : typeof p.cacheReadTotal === 'number'
              ? Math.max(0, p.cacheReadTotal - (prevRun?.usage.cacheRead ?? 0))
              : 0;
        const deltaCacheWrite =
          typeof p.cacheWriteDelta === 'number'
            ? p.cacheWriteDelta
            : typeof p.cacheWriteTotal === 'number'
              ? Math.max(0, p.cacheWriteTotal - (prevRun?.usage.cacheWrite ?? 0))
              : 0;
        const deltaCost =
          typeof p.costUsdDelta === 'number'
            ? p.costUsdDelta
            : typeof p.costUsdTotal === 'number'
              ? Math.max(0, Number((p.costUsdTotal - (prevRun?.usage.costUsd ?? 0)).toFixed(6)))
              : 0;
        const deltaActiveMs =
          typeof p.activeMsDelta === 'number'
            ? p.activeMsDelta
            : typeof p.activeMsTotal === 'number'
              ? Math.max(0, p.activeMsTotal - (prevRun?.usage.activeMs ?? 0))
              : 0;

        const sampleKey =
          p.sampleKey ?? `${nextRun.source}:${nextRun.nativeId}:${p.turn ?? nextRun.usage.turns}:${envelope.seq}`;

        if (deltaIn > 0 || deltaOut > 0 || deltaCost > 0 || p.sampleKey) {
          this.store.recordUsageSample({
            sampleKey,
            runId: nextRun.id,
            source: nextRun.source,
            project: nextRun.projectName || 'unknown',
            model: nextRun.model || 'unknown',
            ts,
            tokensIn: deltaIn,
            tokensOut: deltaOut,
            tokensReasoning: deltaReasoning,
            cacheRead: deltaCacheRead,
            cacheWrite: deltaCacheWrite,
            costUsd: deltaCost,
            costSource: p.costSource,
            precision: p.precision,
            turns: typeof p.turn === 'number' ? 1 : 0,
            toolCalls: 0,
            activeMs: deltaActiveMs,
            historical: nextRun.historical
          });
        }
      }
    }

    this.ringBuffer.push(envelope);
    this.enqueueSseItem([envelope.seq, envelope.type, envelope.runId, envelope.payload, envelope.ts]);

    return envelope;
  }

  public tickTimers(now = Date.now()): void {
    const stallThresholdMs = (this.state.prefs.stallWarnSeconds ?? 120) * 1000;
    for (const run of Object.values(this.state.runs)) {
      if (!run.historical) {
        const alive = this.adapters.get(run.source)?.sessionAlive?.(run.nativeId);
        const res = evaluateLivenessAndTimers(run, {
          alive,
          now,
          // An authoritative busy/retry status remains valid even during a long silent tool.
          stallThresholdMs: alive === true ? Infinity : stallThresholdMs
        });
        if (res.changed) {
          this.ingest({
            type: 'state.changed',
            runId: run.id,
            ts: now,
            payload: {
              from: res.from,
              to: res.to,
              reason: res.reason,
              confidence: res.run.confidence
            }
          });
        }
      }
    }
  }

  private enqueueSseItem(item: WireFrame[number]): void {
    if (this.sseClients.size === 0) return;
    this.pendingFrame.push(item);

    if (this.batchIntervalMs <= 0) {
      this.flushSseFrame();
      return;
    }

    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        this.flushSseFrame();
      }, this.batchIntervalMs);
      this.batchTimer.unref();
    }
  }

  public flushSseFrame(): void {
    if (this.pendingFrame.length === 0) return;
    const frame = this.pendingFrame;
    this.pendingFrame = [];
    const lastSeq = frame[frame.length - 1][0];
    const data = `id: ${lastSeq}\ndata: ${JSON.stringify(frame)}\n\n`;

    for (const [id, client] of this.sseClients.entries()) {
      try {
        const ok = client.reply.raw.write(data);
        client.lastSentSeq = lastSeq;
        if (!ok) {
          this.droppedFramesCount += 1;
        }
      } catch {
        this.sseClients.delete(id);
      }
    }
  }

  public buildSnapshot() {
    const runs = getSortedDeckRuns(this.state.runs);
    const adapters = Object.values(this.state.adapters);
    const aggregates = computeDeckAggregates(
      this.state.runs,
      this.state.prefs.burnRateAlarmUsdPerMin
    );
    return {
      seq: this.state.seq,
      runs,
      aggregates,
      adapters,
      config: {
        prefs: this.state.prefs,
        pricingVersion: getPriceTable().version,
        pricingUpdatedAt: getPriceTable().updatedAt,
        tailscaleUrl: this.tailscaleUrl
      }
    };
  }

  public getEventsPerSecond(now = Date.now()): number {
    const recent = this.recentEventTimestamps.filter((t) => t >= now - 10_000);
    return Number((recent.length / 10).toFixed(2));
  }

  public getSseClientCount(): number {
    return this.sseClients.size;
  }

  public getDroppedFramesCount(): number {
    return this.droppedFramesCount;
  }

  public getEventsIngestedCount(): number {
    return this.eventsIngestedCount;
  }

  public getUptimeMs(now = Date.now()): number {
    return now - this.startedAtMs;
  }

  public registerClient(id: string, reply: FastifyReply, initialSeq: number): void {
    this.sseClients.set(id, { id, reply, lastSentSeq: initialSeq });
  }

  public removeClient(id: string): void {
    this.sseClients.delete(id);
  }

  public isAuthorized(req: FastifyRequest): boolean {
    if (req.cookies?.['agent_deck_logged_out'] === '1') return false;
    const ip = req.ip || req.socket.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      return true;
    }
    if (!this.requireAuthForNonLoopback) {
      return true;
    }
    const cookieToken = req.cookies?.['agent_deck_session'];
    return this.pairing.verifyCookieToken(cookieToken);
  }
}

export async function buildHttpServer(engine: CollectorEngine, options?: { staticDir?: string }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);

  // Auth guard for non-loopback requests (except /api/pair and /api/health)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/pair') && !req.url.startsWith('/api/health') && req.url !== '/api/logout') {
      if (!engine.isAuthorized(req)) {
        return reply.code(401).send({ error: 'Unauthorized: pairing required' });
      }
    }
  });

  // GET /api/health — adapters + collector + storage + self-metrics (§13)
  app.get('/api/health', async (req) => {
    if (!engine.isAuthorized(req)) return { status: 'ok' };
    const now = Date.now();
    const adapters = Object.values(engine.state.adapters);
    const maxLagMs = adapters.reduce((max, a) => Math.max(max, a.lagMs ?? 0), 0);
    return {
      status: 'ok',
      ts: now,
      uptimeMs: engine.getUptimeMs(now),
      seq: engine.state.seq,
      adapters,
      storage: {
        dbPath: engine.store.dbPath,
        dbSizeBytes: engine.store.getDbSizeBytes(),
        ringBufferSize: engine.ringBuffer.size()
      },
      metrics: {
        eventsPerSec: engine.getEventsPerSecond(now),
        totalEventsIngested: engine.getEventsIngestedCount(),
        adapterLagMs: maxLagMs,
        sseClientCount: engine.getSseClientCount(),
        droppedFrames: engine.getDroppedFramesCount()
      }
    };
  });

  // GET /api/snapshot — full state with ETag + If-None-Match -> 304 (§6.2)
  app.get('/api/snapshot', async (req, reply) => {
    const snapshot = engine.buildSnapshot();
    const bodyJson = JSON.stringify(snapshot);
    const hash = createHash('sha1').update(bodyJson).digest('hex').slice(0, 16);
    const etag = `W/"${snapshot.seq}-${hash}"`;

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      return reply.code(304).send();
    }

    reply.header('ETag', etag);
    reply.header('Cache-Control', 'no-cache');
    return reply.type('application/json').send(bodyJson);
  });

  // GET /api/stream — SSE with Last-Event-ID replay and 409 resync gap handling (§6.2, §6.3)
  app.get('/api/stream', async (req, reply) => {
    const lastEventIdHeader = req.headers['last-event-id'] ?? (req.query as Record<string, string>)?.lastEventId;
    let lastEventId: number | undefined;
    if (typeof lastEventIdHeader === 'string' && lastEventIdHeader.trim() !== '') {
      const parsed = Number(lastEventIdHeader);
      if (!Number.isNaN(parsed)) {
        lastEventId = parsed;
      }
    }

    let replayEnvelopes: Envelope[] = [];
    if (lastEventId !== undefined) {
      const replay = engine.ringBuffer.getReplaySince(lastEventId);
      if (replay.status === 'gap') {
        return reply.code(409).send({
          error: 'seq_out_of_range',
          hint: 'resync',
          oldestSeq: engine.ringBuffer.getOldestSeq(),
          latestSeq: engine.ringBuffer.getLatestSeq()
        });
      }
      replayEnvelopes = replay.envelopes;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    engine.registerClient(clientId, reply, engine.state.seq);

    // Send initial comment to establish stream
    reply.raw.write(`: connected seq=${engine.state.seq}\n\n`);

    if (replayEnvelopes.length > 0) {
      const frame: WireFrame = replayEnvelopes.map((e) => [e.seq, e.type, e.runId, e.payload, e.ts]);
      const lastSeq = replayEnvelopes[replayEnvelopes.length - 1].seq;
      reply.raw.write(`id: ${lastSeq}\ndata: ${JSON.stringify(frame)}\n\n`);
    }

    const authTimer = setInterval(() => {
      if (!engine.isAuthorized(req)) reply.raw.end();
    }, 5000);
    authTimer.unref();
    reply.raw.on('close', () => {
      clearInterval(authTimer);
      engine.removeClient(clientId);
    });

    return reply;
  });

  // GET /api/runs/:id — detail (todos, steps, children, usage)
  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const decodedId = decodeURIComponent(id);
    const run = engine.state.runs[decodedId];
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    const childRuns = run.children
      .map((cid) => engine.state.runs[cid])
      .filter((c): c is AgentRun => Boolean(c));

    // Mark as read on detail view fetch
    if (run.unread) {
      run.unread = false;
      engine.store.upsertRun(run);
    }

    return {
      run,
      children: childRuns
    };
  });

  // GET /api/runs/:id/transcript — ?cursor=&limit= (lazy, paginated)
  app.get('/api/runs/:id/transcript', async (req, reply) => {
    const { id } = req.params as { id: string };
    const decodedId = decodeURIComponent(id);
    const run = engine.state.runs[decodedId];
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    const q = req.query as { cursor?: string; limit?: string };
    const cursor = Math.max(0, Number(q.cursor ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));

    if (engine['transcriptProvider']) {
      const res = await engine['transcriptProvider'](run, cursor, limit);
      return {
        runId: run.id,
        lines: res.lines.map((l) => ({
          ...l,
          text: defaultRedactor.redactString(l.text)
        })),
        nextCursor: res.nextCursor
      };
    }

    const messages = run.recentMessages ?? [];
    const slice = messages.slice(cursor, cursor + limit).map((m) => ({
      id: m.id,
      role: m.role,
      text: defaultRedactor.redactString(m.preview),
      ts: m.ts
    }));
    const nextCursor = cursor + limit < messages.length ? cursor + limit : null;
    return {
      runId: run.id,
      lines: slice,
      nextCursor
    };
  });

  // GET /api/runs/:id/diff — ?file=
  app.get('/api/runs/:id/diff', async (req, reply) => {
    const { id } = req.params as { id: string };
    const decodedId = decodeURIComponent(id);
    const run = engine.state.runs[decodedId];
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    const q = req.query as { file?: string };

    if (engine['diffProvider']) {
      const res = await engine['diffProvider'](run, q.file);
      return {
        runId: run.id,
        files: res.files.map((f) => ({
          ...f,
          patch: f.patch ? defaultRedactor.redactFileContent(f.path, f.patch) : undefined
        }))
      };
    }

    const files = (run.filesChanged ?? []).filter((f) => !q.file || f.path === q.file);
    return {
      runId: run.id,
      files
    };
  });

  // GET /api/usage/summary — ?from=&to=
  app.get('/api/usage/summary', async (req) => {
    const q = UsageQuerySchema.parse(req.query);
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const from = q.from ?? startOfToday.getTime();
    const to = q.to ?? now;
    return engine.store.getUsageSummary(
      from,
      to,
      Object.values(engine.state.runs),
      engine.state.prefs.burnRateAlarmUsdPerMin
    );
  });

  // GET /api/usage/timeseries — ?from=&to=&bucket=1h|1d&source=&project=&model=
  app.get('/api/usage/timeseries', async (req) => {
    const q = UsageQuerySchema.parse(req.query);
    const now = Date.now();
    const from = q.from ?? now - 7 * 86_400_000;
    const to = q.to ?? now;
    return {
      from,
      to,
      bucket: q.bucket,
      series: engine.store.getUsageTimeseries({
        from,
        to,
        bucket: q.bucket,
        source: q.source,
        project: q.project,
        model: q.model
      })
    };
  });

  // GET /api/usage/breakdown — ?by=project|model|source|day&from=&to=
  app.get('/api/usage/breakdown', async (req) => {
    const q = UsageQuerySchema.parse(req.query);
    const now = Date.now();
    const from = q.from ?? now - 7 * 86_400_000;
    const to = q.to ?? now;
    return {
      from,
      to,
      by: q.by,
      rows: engine.store.getUsageBreakdown({
        by: q.by,
        from,
        to
      })
    };
  });

  // GET /api/usage/runs — paginated historical runs, sortable by cost/tokens/time/unproductive
  app.get('/api/usage/runs', async (req) => {
    const q = UsageQuerySchema.parse(req.query);
    let runs = Object.values(engine.state.runs);
    if (q.from) runs = runs.filter((r) => r.lastActivityAt >= q.from! || r.startedAt >= q.from!);
    if (q.to) runs = runs.filter((r) => r.startedAt <= q.to!);
    if (q.source) runs = runs.filter((r) => r.source === q.source);
    if (q.project) runs = runs.filter((r) => r.projectName === q.project);
    if (q.model) runs = runs.filter((r) => r.model === q.model);

    if (q.sortBy === 'cost') {
      runs.sort((a, b) => (b.usage.costUsd ?? 0) - (a.usage.costUsd ?? 0));
    } else if (q.sortBy === 'tokens') {
      runs.sort((a, b) => b.usage.tokensIn + b.usage.tokensOut - (a.usage.tokensIn + a.usage.tokensOut));
    } else if (q.sortBy === 'time') {
      runs.sort((a, b) => b.usage.activeMs - a.usage.activeMs);
    } else if (q.sortBy === 'unproductive') {
      // Expensive AND produced little (high tokens/cost, few file changes) (§7.4)
      const score = (r: AgentRun) => {
        const files = Math.max(1, (r.filesChanged?.length ?? 0) + 1);
        const tokens = r.usage.tokensIn + r.usage.tokensOut;
        return tokens / files;
      };
      runs.sort((a, b) => score(b) - score(a));
    } else {
      runs.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    }

    const total = runs.length;
    const items = runs.slice(q.offset, q.offset + q.limit);
    return {
      total,
      offset: q.offset,
      limit: q.limit,
      runs: items
    };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie('agent_deck_session', { path: '/' });
    reply.setCookie('agent_deck_logged_out', '1', {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 365 * 24 * 3600
    });
    return { ok: true };
  });

  // POST /api/pair — { code } -> sets httpOnly; SameSite=Lax cookie (§6.2)
  app.post('/api/pair', async (req, reply) => {
    const parsed = PairRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid pairing code format' });
    }
    const ok = engine.pairing.consumeCode(parsed.data.code);
    if (!ok) {
      return reply.code(403).send({ error: 'Invalid or expired pairing code' });
    }
    reply.clearCookie('agent_deck_logged_out', { path: '/' });
    reply.setCookie('agent_deck_session', engine.pairing.issueSession(req.headers['user-agent'] || 'LAN browser').token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 365 * 24 * 3600
    });
    return { paired: true };
  });

  // POST /api/prefs — layout, columns, theme, ambient schedule, mark-read (§6.2)
  app.post('/api/prefs', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (body && typeof body.markReadRunId === 'string') {
      const run = engine.state.runs[body.markReadRunId];
      if (run) {
        run.unread = false;
        engine.store.upsertRun(run);
        engine.ingest({
          type: 'run.updated',
          runId: run.id,
          payload: { unread: false }
        });
      }
      return { ok: true, prefs: engine.state.prefs };
    }

    const parsed = DeckPrefsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid preferences payload' });
    }
    const updated = engine.store.setPrefs(parsed.data);
    engine.state.prefs = updated;
    return { ok: true, prefs: updated };
  });

  // Serve static SvelteKit PWA build if present
  const staticDir = options?.staticDir ?? engine['staticDir'];
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/'
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'API endpoint not found' });
        return;
      }
      if (existsSync(join(staticDir, 'index.html'))) {
        reply.sendFile('index.html');
      } else {
        reply.code(404).send('Not found');
      }
    });
  }

  return app;
}
