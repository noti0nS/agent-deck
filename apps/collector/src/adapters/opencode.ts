import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AdapterHealth, Capabilities, Confidence, Todo } from '@agent-deck/core';
import { estimateApiCostUsd } from '@agent-deck/pricing';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';
import { withReadonlySqlite } from './readonly-sqlite.js';

export interface OpenCodeSessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  agent: string | null;
  model: string | null;
  cost: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cache_read: number | null;
  tokens_cache_write: number | null;
  time_created: number | null;
  time_updated: number | null;
  time_compacting: number | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
}

export interface OpenCodeAdapterOptions {
  dbPath?: string;
  serviceUrlOverride?: string;
  reconcileIntervalMs?: number;
}

export function parseOpenCodeModel(rawModel: string | null | undefined): string {
  if (!rawModel) return 'unknown';
  const trimmed = rawModel.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { id?: string; modelID?: string; providerID?: string };
      return parsed.id || parsed.modelID || trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function extractProjectName(dir: string | null | undefined): string {
  if (!dir) return 'workspace';
  const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  return basename(norm) || 'workspace';
}

export function normalizeOpenCodeSseEvent(raw: Record<string, unknown>, ts = Date.now()): EmitEventInput[] {
  const events: EmitEventInput[] = [];
  const type = String(raw.type || '');
  const props = (raw.properties ?? {}) as Record<string, unknown>;

  if (type === 'session.updated' || type === 'session.created') {
    const info = (props.info ?? props) as Record<string, unknown>;
    const nativeId = String(info.id || '');
    if (!nativeId) return events;
    const runId = `opencode:${nativeId}`;
    const dir = String(info.directory || '');
    const modelObj = info.model as { id?: string } | string | undefined;
    const modelStr =
      typeof modelObj === 'string'
        ? parseOpenCodeModel(modelObj)
        : typeof modelObj === 'object' && modelObj?.id
          ? modelObj.id
          : 'unknown';
    const timeObj = (info.time ?? {}) as { created?: number; updated?: number; compacting?: number };

    events.push({
      type: 'run.started',
      runId,
      ts: timeObj.updated ?? ts,
      payload: {
        source: 'opencode',
        nativeId,
        parentId: info.parentID ? `opencode:${String(info.parentID)}` : undefined,
        projectPath: dir,
        projectName: extractProjectName(dir),
        title: String(info.title || extractProjectName(dir)),
        model: modelStr,
        agentMode: info.agent ? String(info.agent) : undefined,
        confidence: 'live',
        startedAt: timeObj.created ?? ts
      }
    });

    // Session metadata (including persisted compaction timestamps) is not liveness.
  } else if (type === 'session.status') {
    const nativeId = String(props.sessionID || '');
    const status = (props.status as { type?: string } | undefined)?.type;
    if (!nativeId || !['busy', 'retry', 'idle'].includes(status ?? '')) return events;
    if (status === 'idle') {
      events.push({ type: 'attention.cleared', runId: `opencode:${nativeId}`, ts, payload: { reason: 'session.status:idle' } });
    }
    events.push({
      type: 'state.changed',
      runId: `opencode:${nativeId}`,
      ts,
      payload: { from: 'idle', to: status === 'idle' ? 'idle' : 'running', reason: `session.status:${status}`, confidence: 'live' }
    });
  } else if (type === 'message.part.updated') {
    const part = (props.part ?? {}) as Record<string, unknown>;
    const nativeId = String(part.sessionID || '');
    if (!nativeId) return events;
    const runId = `opencode:${nativeId}`;
    const partType = String(part.type || '');

    if (partType === 'tool') {
      const toolName = String(part.tool || 'tool');
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = String(state.status || '');
      const input = (state.input ?? {}) as Record<string, unknown>;
      const detail = String(
        input.command || input.filePath || input.path || input.pattern || input.description || toolName
      ).slice(0, 120);

      if (status === 'running' || status === 'pending') {
        events.push({
          type: 'tool.started',
          runId,
          ts,
          payload: {
            stepId: String(part.id || ''),
            label: toolName,
            detail,
            tool: toolName
          }
        });
      } else if (status === 'completed' || status === 'error') {
        const time = (state.time ?? {}) as { start?: number; end?: number };
        const durationMs =
          time.start && time.end && time.end >= time.start ? time.end - time.start : undefined;
        events.push({
          type: 'tool.completed',
          runId,
          ts: time.end ?? ts,
          payload: {
            stepId: String(part.id || ''),
            label: toolName,
            detail,
            durationMs,
            ok: status !== 'error'
          }
        });
      }
    } else if (partType === 'step-finish') {
      const tokens = (part.tokens ?? {}) as {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
      const cost = typeof part.cost === 'number' ? part.cost : 0;
      events.push({
        type: 'usage.tick',
        runId,
        ts,
        payload: {
          sampleKey: `opencode:${nativeId}:part:${String(part.id || ts)}`,
          tokensInDelta: Number(tokens.input || 0),
          tokensOutDelta: Number(tokens.output || 0),
          tokensReasoningDelta: Number(tokens.reasoning || 0),
          cacheReadDelta: Number(tokens.cache?.read || 0),
          cacheWriteDelta: Number(tokens.cache?.write || 0),
          costUsdDelta: cost,
          costSource: 'tool',
          precision: 'exact'
        }
      });
    } else if (partType === 'text') {
      const text = String(part.text || '');
      if (text.length > 0) {
        events.push({
          type: 'message.completed',
          runId,
          ts,
          payload: {
            messageId: String(part.id || ''),
            role: 'assistant',
            preview: text.slice(0, 400)
          }
        });
      }
    }
  } else if (type === 'todo.updated') {
    const nativeId = String(props.sessionID || '');
    if (!nativeId) return events;
    const rawTodos = Array.isArray(props.todos) ? (props.todos as Array<Record<string, unknown>>) : [];
    const todos: Todo[] = rawTodos.map((t, i) => ({
      position: typeof t.position === 'number' ? t.position : i + 1,
      content: String(t.content || ''),
      status: (['pending', 'in_progress', 'completed', 'cancelled'].includes(String(t.status))
        ? String(t.status)
        : 'pending') as Todo['status']
    }));
    events.push({
      type: 'todo.updated',
      runId: `opencode:${nativeId}`,
      ts,
      payload: { todos }
    });
  } else if (type === 'permission.updated' || type === 'permission.asked') {
    const nativeId = String(props.sessionID || '');
    if (!nativeId) return events;
    const meta = (props.metadata ?? {}) as Record<string, unknown>;
    const summary = String(props.title || meta.command || props.action || 'Permission requested');
    events.push({
      type: 'attention.raised',
      runId: `opencode:${nativeId}`,
      ts,
      payload: {
        attention: {
          id: String(props.id || `${nativeId}:${ts}`),
          kind: 'permission',
          summary,
          resource: meta.path ? String(meta.path) : undefined,
          requestedAt: ts
        }
      }
    });
  } else if (type === 'permission.replied') {
    const nativeId = String(props.sessionID || '');
    if (!nativeId) return events;
    events.push({
      type: 'attention.cleared',
      runId: `opencode:${nativeId}`,
      ts,
      payload: { reason: 'permission.replied' }
    });
  } else if (type === 'session.idle') {
    const nativeId = String(props.sessionID || '');
    if (!nativeId) return events;
    events.push({
      type: 'turn.completed',
      runId: `opencode:${nativeId}`,
      ts,
      payload: { turn: 1 }
    });
  } else if (type === 'session.error') {
    const nativeId = String(props.sessionID || '');
    if (!nativeId) return events;
    events.push({
      type: 'error.raised',
      runId: `opencode:${nativeId}`,
      ts,
      payload: {
        message: String(props.error || 'OpenCode session error'),
        recoverable: false
      }
    });
  }

  return events;
}

export class OpenCodeAdapter implements Adapter {
  public readonly source = 'opencode' as const;
  public readonly dbPath: string;
  private serviceUrl?: string;
  private readonly serviceUrlOverride?: string;
  private readonly reconcileIntervalMs: number;
  private ctx?: AdapterContext;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private sseAbort: AbortController | null = null;
  private stopped = false;
  private currentHealth: AdapterHealth;
  private readonly sessionSnapshots = new Map<string, string>();
  private readonly sessionStatuses = new Map<string, { active: boolean; checkedAt: number }>();
  private readonly apiSessions = new Set<string>();
  private readonly apiMessagePreviews = new Map<string, string>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.dbPath = options.dbPath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
    this.serviceUrlOverride = options.serviceUrlOverride;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 30_000;
    this.currentHealth = {
      source: 'opencode',
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

  public async discoverServiceUrl(): Promise<string | undefined> {
    const candidate = this.serviceUrlOverride ?? process.env.OPENCODE_SERVER_URL ?? 'http://127.0.0.1:4096';
    try {
      const response = await fetch(`${candidate.replace(/\/$/, '')}/global/health`, { signal: AbortSignal.timeout(2000) });
      const health = response.ok ? await response.json() as { healthy?: boolean } : undefined;
      if (health?.healthy === true) {
        this.serviceUrl = candidate.replace(/\/$/, '');
        return this.serviceUrl;
      }
    } catch {
      // No reachable existing server. Never start a separate server to infer activity.
    }
    this.serviceUrl = undefined;
    this.sessionStatuses.clear();
    return undefined;
  }

  public sessionAlive(nativeId: string): boolean | undefined {
    const status = this.sessionStatuses.get(nativeId);
    return status && Date.now() - status.checkedAt <= Math.max(10_000, this.reconcileIntervalMs * 2)
      ? (status.active ? true : undefined)
      : undefined;
  }

  public async reconcileSessionStatuses(): Promise<void> {
    if (!this.serviceUrl || !this.ctx) return;
    try {
      const response = await fetch(`${this.serviceUrl}/session/status`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error(`Session status HTTP ${response.status}`);
      const statuses = await response.json() as Record<string, { type?: string }>;
      const now = Date.now();
      const ids = new Set([...this.sessionStatuses.keys(), ...Object.keys(statuses)]);
      for (const id of ids) {
        const type = statuses[id]?.type ?? 'idle';
        if (!['busy', 'retry', 'idle'].includes(type)) continue;
        if (!this.apiSessions.has(id)) {
          // Hydrate the real session identity before status/tool events can create a skeleton.
          const detail = await fetch(`${this.serviceUrl}/session/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(2000) });
          if (detail.ok) {
            const info = await detail.json() as Record<string, unknown>;
            if (info.id === id) {
              for (const event of normalizeOpenCodeSseEvent({ type: 'session.updated', properties: { info } }, now)) this.ctx.emit(event);
              this.apiSessions.add(id);
            }
          }
        }
        if (!this.apiSessions.has(id)) continue;
        await this.refreshLatestMessage(id, now);
        const previous = this.sessionStatuses.get(id);
        this.sessionStatuses.set(id, { active: type !== 'idle', checkedAt: now });
        // Reconcile absent keys too: upstream removes idle entries from this map.
        for (const event of normalizeOpenCodeSseEvent({ type: 'session.status', properties: { sessionID: id, status: { type } } }, now)) {
          // A newly fetched message can temporarily mark the reducer running;
          // reassert idle without manufacturing fresh activity on every poll.
          if (event.type === 'attention.cleared' && previous?.active === false) continue;
          this.ctx.emit(event);
        }
      }
    } catch {
      this.sessionStatuses.clear();
    }
  }

  private async refreshLatestMessage(id: string, now: number): Promise<void> {
    try {
      const response = await fetch(`${this.serviceUrl}/session/${encodeURIComponent(id)}/message?limit=1`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return;
      const messages = await response.json() as Array<{ info?: { id?: string; role?: string; time?: { created?: number } }; parts?: Array<{ type?: string; text?: string }> }>;
      if (!Array.isArray(messages)) return;
      const message = messages.at(-1);
      if (!message?.info || !['assistant', 'user'].includes(message.info.role ?? '')) return;
      const preview = (message.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').slice(0, 400);
      if (!preview) return;
      const fingerprint = JSON.stringify([message.info.id, preview]);
      if (this.apiMessagePreviews.get(id) === fingerprint) return;
      this.apiMessagePreviews.set(id, fingerprint);
      this.ctx?.emit({ type: 'message.completed', runId: `opencode:${id}`, ts: message.info.time?.created ?? now,
        payload: { messageId: message.info.id, role: message.info.role, preview } });
    } catch {
      // Missing message enrichment does not invalidate a successful status read.
    }
  }

  public async probe(): Promise<Capabilities> {
    const url = await this.discoverServiceUrl();
    const hasDb = existsSync(this.dbPath);
    const notes: string[] = [];
    if (url) notes.push(`service=${url}`);
    if (hasDb) notes.push(`db=${this.dbPath} (read-only)`);

    const caps: Capabilities = {
      liveEvents: Boolean(url),
      usagePrecision: hasDb || url ? 'exact' : 'none',
      attention: Boolean(url),
      subagents: hasDb || Boolean(url),
      notes
    };

    this.currentHealth = {
      source: 'opencode',
      status: hasDb || url ? 'connected' : 'off',
      capabilities: caps,
      lastSeenAt: Date.now()
    };

    return caps;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    await this.probe();
    ctx.reportHealth(this.currentHealth);

    // Initial DB reconciliation
    this.reconcileFromDb(25, 'polled');
    await this.reconcileSessionStatuses();

    // Start SSE stream loop if service URL is available
    this.startSseLoop();

    this.reconcileTimer = setInterval(async () => {
      if (this.stopped) return;
      await this.discoverServiceUrl();
      this.reconcileFromDb(15, 'polled');
      await this.reconcileSessionStatuses();
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
  }

  public health(): AdapterHealth {
    return this.currentHealth;
  }

  public reconcileFromDb(limit = 25, confidence: Confidence = 'polled', historical = false): number {
    if (!existsSync(this.dbPath) || !this.ctx) return 0;

    try {
      return withReadonlySqlite(this.dbPath, (db) => {
        const rows = db
          .prepare(
            `SELECT id, parent_id, directory, title, agent, model, cost,
                    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
                    time_created, time_updated, time_compacting,
                    summary_additions, summary_deletions, summary_files
             FROM session
             ORDER BY time_updated DESC
             LIMIT ?`
          )
          .all(limit) as OpenCodeSessionRow[];

        for (const r of rows.reverse()) {
          const fingerprint = JSON.stringify(r);
          if (this.sessionSnapshots.get(r.id) === fingerprint) continue;
          this.emitSessionRow(db, r, confidence, historical);
          this.sessionSnapshots.set(r.id, fingerprint);
        }

        this.currentHealth.lastSeenAt = Date.now();
        this.currentHealth.status = 'connected';
        return rows.length;
      });
    } catch (err) {
      this.currentHealth.status = 'degraded';
      this.currentHealth.lastError = err instanceof Error ? err.message : String(err);
      this.ctx.reportHealth(this.currentHealth);
      return 0;
    }
  }

  public emitSessionRow(
    db: Database.Database | null,
    r: OpenCodeSessionRow,
    confidence: Confidence = 'polled',
    historical = false
  ): void {
    if (!this.ctx) return;
    // Once a live API has identified this session, DB snapshots must not replay
    // tools/messages or overwrite its authoritative status.
    if (this.apiSessions.has(r.id) && !historical) return;
    const runId = `opencode:${r.id}`;
    const projectPath = r.directory ?? '';
    const projectName = extractProjectName(projectPath);
    const model = parseOpenCodeModel(r.model);
    const startedAt = r.time_created ?? Date.now();
    const updatedAt = r.time_updated ?? startedAt;

    this.ctx.emit({
      type: 'run.started',
      runId,
      ts: updatedAt,
      payload: {
        source: 'opencode',
        nativeId: r.id,
        parentId: r.parent_id ? `opencode:${r.parent_id}` : undefined,
        projectPath,
        projectName,
        title: r.title || projectName,
        model,
        agentMode: r.agent ?? undefined,
        confidence,
        startedAt,
        historical
      }
    });

    const tokensIn = Number(r.tokens_input || 0);
    const tokensOut = Number(r.tokens_output || 0);
    const tokensReasoning = Number(r.tokens_reasoning || 0);
    const cacheRead = Number(r.tokens_cache_read || 0);
    const cacheWrite = Number(r.tokens_cache_write || 0);
    const rawCost = Number(r.cost || 0);

    // OpenCode reports exact cost when available; when cost is 0 on flat-rate/custom providers, compute estimated or keep exact 0 if no tokens
    const hasVendorCost = rawCost > 0;
    const costUsd = hasVendorCost
      ? Number(rawCost.toFixed(6))
      : tokensIn + tokensOut > 0
        ? estimateApiCostUsd(model, { tokensIn, tokensOut, tokensReasoning, cacheRead, cacheWrite })
        : 0;

    if (tokensIn > 0 || tokensOut > 0 || rawCost > 0) {
      this.ctx.emit({
        type: 'usage.tick',
        runId,
        ts: updatedAt,
        payload: {
          sampleKey: `opencode:${r.id}:session_total:${tokensIn}:${tokensOut}`,
          tokensInTotal: tokensIn,
          tokensOutTotal: tokensOut,
          tokensReasoningTotal: tokensReasoning,
          cacheReadTotal: cacheRead,
          cacheWriteTotal: cacheWrite,
          costUsdTotal: costUsd,
          costSource: hasVendorCost ? 'tool' : costUsd === undefined ? 'none' : 'estimated',
          precision: hasVendorCost ? 'exact' : 'derived',
          activeMsTotal: Math.max(0, updatedAt - startedAt)
        }
      });
    }

    if (db) {
      try {
        const todoRows = db
          .prepare('SELECT position, content, status FROM todo WHERE session_id = ? ORDER BY position ASC')
          .all(r.id) as Array<{ position: number; content: string; status: string }>;
        if (todoRows.length > 0) {
          this.ctx.emit({
            type: 'todo.updated',
            runId,
            ts: updatedAt,
            payload: {
              todos: todoRows.map((t, idx) => ({
                position: typeof t.position === 'number' ? t.position : idx + 1,
                content: t.content,
                status: (['pending', 'in_progress', 'completed', 'cancelled'].includes(t.status)
                  ? t.status
                  : 'pending') as Todo['status']
              }))
            }
          });
        }

        // Fetch most recent tool part for currentStep / recentSteps
        const lastPart = db
          .prepare('SELECT id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created DESC LIMIT 3')
          .all(r.id) as Array<{ id: string; time_created: number; data: string }>;
        for (const p of lastPart.reverse()) {
          try {
            const parsed = JSON.parse(p.data) as Record<string, unknown>;
            if (parsed.type === 'tool') {
              const state = (parsed.state ?? {}) as Record<string, unknown>;
              const input = (state.input ?? {}) as Record<string, unknown>;
              const toolName = String(parsed.tool || 'tool');
              const detail = String(
                input.command || input.filePath || input.path || input.pattern || toolName
              ).slice(0, 120);
              this.ctx.emit({
                type: 'tool.completed',
                runId,
                ts: p.time_created || updatedAt,
                payload: {
                  stepId: p.id,
                  label: toolName,
                  detail,
                  ok: state.status !== 'error'
                }
              });
            } else if (parsed.type === 'text' && typeof parsed.text === 'string') {
              this.ctx.emit({
                type: 'message.completed',
                runId,
                ts: p.time_created || updatedAt,
                payload: {
                  messageId: p.id,
                  role: 'assistant',
                  preview: parsed.text.slice(0, 400)
                }
              });
            }
          } catch {
            // ignore malformed part JSON
          }
        }
      } catch {
        // ignore enrichment query errors
      }
    }

    if (!this.sessionStatuses.get(r.id)?.active) {
      this.ctx.emit({
        type: 'state.changed',
        runId,
        ts: updatedAt,
        payload: { from: 'starting', to: 'idle', reason: 'persisted_session_snapshot', confidence }
      });
    }
  }

  private async startSseLoop(): Promise<void> {
    let backoffMs = 1000;
    while (!this.stopped) {
      const url = await this.discoverServiceUrl();
      if (!url) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      try {
        this.sseAbort = new AbortController();
        const res = await fetch(`${url}/event`, {
          headers: { Accept: 'text/event-stream' },
          signal: this.sseAbort.signal
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE HTTP ${res.status}`);
        }
        this.currentHealth.status = 'connected';
        this.currentHealth.lastSeenAt = Date.now();
        this.ctx?.reportHealth(this.currentHealth);
        this.reconcileFromDb(15, 'polled');
        await this.reconcileSessionStatuses();

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let buf = '';

        while (!this.stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const jsonStr = line.slice(5).trim();
              if (!jsonStr) continue;
              try {
                const raw = JSON.parse(jsonStr) as Record<string, unknown>;
                backoffMs = 1000;
                const props = raw.properties as { sessionID?: string; status?: { type?: string }; info?: { id?: string }; part?: { sessionID?: string } } | undefined;
                const sessionId = props?.sessionID ?? props?.part?.sessionID;
                if (sessionId && !this.apiSessions.has(sessionId)) {
                  const detail = await fetch(`${url}/session/${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(2000) });
                  if (!detail.ok) continue;
                  const info = await detail.json() as Record<string, unknown>;
                  if (info.id !== sessionId) continue;
                  for (const event of normalizeOpenCodeSseEvent({ type: 'session.updated', properties: { info } })) this.ctx?.emit(event);
                  this.apiSessions.add(sessionId);
                }
                if ((raw.type === 'session.created' || raw.type === 'session.updated') && props?.info?.id) this.apiSessions.add(props.info.id);
                if (props?.sessionID && (raw.type === 'session.status' || raw.type === 'session.idle')) {
                  const type = raw.type === 'session.idle' ? 'idle' : props.status?.type;
                  if (type === 'idle' || type === 'busy' || type === 'retry') {
                    this.sessionStatuses.set(props.sessionID, { active: type !== 'idle', checkedAt: Date.now() });
                  }
                }
                const normalized = normalizeOpenCodeSseEvent(raw, Date.now());
                for (const ev of normalized) {
                  this.ctx?.emit(ev);
                }
              } catch {
                // ignore non-json SSE data
              }
            }
          }
        }
        if (!this.stopped) throw new Error('OpenCode event stream closed');
      } catch (err) {
        if (this.stopped) break;
        this.sessionStatuses.clear();
        this.currentHealth.status = 'degraded';
        this.currentHealth.lastError = err instanceof Error ? err.message : String(err);
        this.ctx?.reportHealth(this.currentHealth);
        await new Promise((r) => setTimeout(r, backoffMs + Math.random() * backoffMs * 0.25));
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }
}
