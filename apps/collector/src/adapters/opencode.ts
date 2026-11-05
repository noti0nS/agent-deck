import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Service } from '@opencode/client/service';
import type { AdapterHealth, Capabilities } from '@agent-deck/core';
import { estimateApiCostUsd } from '@agent-deck/pricing';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';

export interface OpenCodeSession {
  id: string;
  parentID?: string;
  location: { directory: string };
  title?: string;
  agent?: string;
  model?: { id: string; providerID?: string };
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  time: { created: number; updated: number; busy?: number; idle?: number };
}

export interface OpenCodeAdapterOptions {
  serviceUrlOverride?: string;
  reconcileIntervalMs?: number;
}

export function extractProjectName(dir: string | undefined): string {
  return dir ? basename(dir.replace(/\\/g, '/').replace(/\/+$/, '')) || 'workspace' : 'workspace';
}

/** Normalize only OpenCode V2 event envelopes. */
export function normalizeOpenCodeSseEvent(raw: Record<string, unknown>, ts = Date.now()): EmitEventInput[] {
  const data = raw.data as Record<string, unknown> | undefined;
  if (!data || typeof data.sessionID !== 'string') return [];
  const runId = `opencode:${data.sessionID}`;
  ts = typeof raw.created === 'number' ? raw.created : ts;
  const type = String(raw.type);
  if (type === 'session.status' || type === 'session.idle' || type.startsWith('session.execution.')) {
    const status = type === 'session.status' ? (data.status as { type?: string } | undefined)?.type
      : type === 'session.execution.started' ? 'busy' : 'idle';
    if (!['busy', 'retry', 'idle'].includes(status ?? '')) return [];
    return [
      ...(status === 'idle' ? [{ type: 'attention.cleared' as const, runId, ts, payload: { reason: type } }] : []),
      { type: 'state.changed', runId, ts, payload: { from: 'idle', to: status === 'idle' ? 'idle' : 'running', reason: type, confidence: 'live' } }
    ];
  }
  if (type === 'session.text.ended') return [{ type: 'message.completed', runId, ts, payload: {
    messageId: `${data.assistantMessageID}:${data.ordinal}`, role: 'assistant', preview: String(data.text ?? '').slice(0, 400)
  } }];
  if (['session.tool.input.started', 'session.tool.called', 'session.tool.success', 'session.tool.failed'].includes(type)) {
    const finished = type === 'session.tool.success' || type === 'session.tool.failed';
    const input = data.input as Record<string, unknown> | undefined;
    return [{ type: finished ? 'tool.completed' : 'tool.started', runId, ts, payload: {
      stepId: String(data.id), label: String(data.name ?? data.id),
      detail: String(input?.command ?? input?.filePath ?? input?.path ?? data.name ?? data.id).slice(0, 120),
      ok: type !== 'session.tool.failed'
    } }];
  }
  if (type === 'session.compaction.started' || type === 'session.compaction.ended' || type === 'session.compaction.failed') {
    return [{ type: type.endsWith('started') ? 'compact.started' : 'compact.completed', runId, ts, payload: {} }];
  }
  if (type === 'permission.asked' || type === 'form.created') return [{ type: 'attention.raised', runId, ts, payload: {
    attention: { id: String(data.id ?? ''), kind: type === 'permission.asked' ? 'permission' : 'question',
      summary: String(data.action ?? 'Input requested'), requestedAt: ts }
  } }];
  if (['permission.replied', 'form.replied', 'form.cancelled'].includes(type)) {
    return [{ type: 'attention.cleared', runId, ts, payload: { reason: type } }];
  }
  return [];
}

export class OpenCodeAdapter implements Adapter {
  public readonly source = 'opencode' as const;
  private readonly serviceUrlOverride?: string;
  private readonly reconcileIntervalMs: number;
  private serviceUrl?: string;
  private serviceHeaders: Record<string, string> = {};
  private ctx?: AdapterContext;
  private abort?: AbortController;
  private loop?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  private readonly snapshots = new Map<string, string>();
  private readonly statuses = new Map<string, { active: boolean; checkedAt: number }>();
  private readonly messages = new Map<string, string>();
  private readonly toolNames = new Map<string, string>();
  private currentHealth: AdapterHealth = { source: 'opencode', status: 'off', capabilities: {
    liveEvents: false, usagePrecision: 'none', attention: false, subagents: false, notes: ['OpenCode V2 API']
  } };

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.serviceUrlOverride = options.serviceUrlOverride;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 30_000;
  }

  public async discoverServiceUrl(): Promise<string | undefined> {
    const explicit = this.serviceUrlOverride ?? process.env.OPENCODE_SERVER_URL;
    try {
      // Discovery authenticates the registered service without starting a process.
      const endpoint = explicit ? undefined : await Service.discover();
      this.serviceUrl = (explicit ?? endpoint?.url)?.replace(/\/$/, '');
      this.serviceHeaders = endpoint ? Service.headers(endpoint) ?? {} : {};
      if (this.serviceUrl) {
        const info = await this.get<{ version?: string }>('/info');
        if (!info.version?.startsWith('2.')) throw new Error('OpenCode V2 required');
        return this.serviceUrl;
      }
    } catch { /* Health reports absence rather than claiming a DB is a live connection. */ }
    this.serviceUrl = undefined;
    this.serviceHeaders = {};
    this.statuses.clear();
    return undefined;
  }

  private async get<T>(path: string): Promise<T> {
    const signal = this.abort ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const response = await fetch(`${this.serviceUrl}/api${path}`, { headers: this.serviceHeaders, signal });
    if (!response.ok) throw new Error(`OpenCode V2 API HTTP ${response.status}`);
    return await response.json() as T;
  }

  public async probe(): Promise<Capabilities> {
    const url = await this.discoverServiceUrl();
    const capabilities: Capabilities = {
      liveEvents: Boolean(url), usagePrecision: url ? 'exact' : 'none', attention: Boolean(url), subagents: Boolean(url),
      notes: ['OpenCode V2 API', ...(url ? [`service=${url}`] : ['No reachable OpenCode V2 service'])]
    };
    this.currentHealth = { source: 'opencode', status: url ? 'connected' : 'off', capabilities, lastSeenAt: Date.now() };
    this.ctx?.reportHealth(this.currentHealth);
    return capabilities;
  }

  public health(): AdapterHealth { return this.currentHealth; }

  public sessionAlive(id: string): boolean | undefined {
    const status = this.statuses.get(id);
    return status?.active && Date.now() - status.checkedAt <= Math.max(10_000, this.reconcileIntervalMs * 2) ? true : undefined;
  }

  private emitSession(info: OpenCodeSession, historical = false): void {
    if (!this.ctx) return;
    const runId = `opencode:${info.id}`;
    const tokens = info.tokens;
    const model = info.model?.id ?? 'unknown';
    const usage = {
      tokensIn: tokens.input, tokensOut: tokens.output, tokensReasoning: tokens.reasoning,
      cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write
    };
    // Catalog entries may require the provider namespace (including gateway model IDs).
    const cost = info.cost > 0 ? info.cost
      : (info.model?.providerID ? estimateApiCostUsd(`${info.model.providerID}/${model}`, usage) : undefined)
        ?? estimateApiCostUsd(model, usage);
    // A catalog refresh can make an unchanged session priceable.
    const fingerprint = JSON.stringify([info, cost]);
    const changed = this.snapshots.get(info.id) !== fingerprint;
    if (changed || historical) {
      this.ctx.emit({ type: 'run.started', runId, ts: info.time.updated, payload: {
        source: 'opencode', nativeId: info.id, parentId: info.parentID ? `opencode:${info.parentID}` : undefined,
        projectPath: info.location.directory, projectName: extractProjectName(info.location.directory),
        title: info.title || extractProjectName(info.location.directory), model: info.model?.id ?? 'unknown',
        agentMode: info.agent, confidence: historical ? 'inferred' : 'live', startedAt: info.time.created, historical
      } });
      this.ctx.emit({ type: 'usage.tick', runId, ts: info.time.updated, payload: {
        sampleKey: `${runId}:session_total:${tokens.input}:${tokens.output}:${tokens.reasoning}:${tokens.cache.read}:${tokens.cache.write}:${info.cost}:${cost ?? 'unpriced'}`,
        tokensInTotal: tokens.input, tokensOutTotal: tokens.output, tokensReasoningTotal: tokens.reasoning,
        cacheReadTotal: tokens.cache.read, cacheWriteTotal: tokens.cache.write, costUsdTotal: cost,
        costSource: info.cost > 0 ? 'tool' : cost === undefined ? 'none' : 'estimated', precision: info.cost > 0 ? 'exact' : 'derived'
      } });
      this.snapshots.set(info.id, fingerprint);
    }
    // Busy/idle are explicit execution transitions in the V2 session projection.
    const active = !historical && (info.time.busy ?? 0) > (info.time.idle ?? 0);
    const previous = this.statuses.get(info.id);
    if (!historical) this.statuses.set(info.id, { active, checkedAt: Date.now() });
    if (changed || !previous || previous.active !== active || active) {
      this.ctx.emit({ type: 'state.changed', runId, ts: historical ? info.time.updated : Date.now(), payload: {
        from: 'starting', to: active ? 'running' : 'idle', reason: 'opencode_v2_session', confidence: historical ? 'inferred' : 'live'
      } });
    }
  }

  public async reconcileSessionStatuses(): Promise<void> {
    if (!this.serviceUrl || !this.ctx || this.reconciling) return;
    this.reconciling = true;
    try {
      const result = await this.get<{ data: OpenCodeSession[] }>('/session?limit=50');
      const sessions = new Map(result.data.map(info => [info.id, info]));
      for (const [id, status] of this.statuses) {
        if (status.active && !sessions.has(id)) {
          const detail = await this.get<{ data: OpenCodeSession }>(`/session/${encodeURIComponent(id)}`);
          sessions.set(id, detail.data);
        }
      }
      for (const info of sessions.values()) {
        this.emitSession(info);
        if (this.statuses.get(info.id)?.active && !this.messages.has(info.id)) await this.refreshLatestMessage(info.id);
      }
      this.currentHealth.status = 'connected';
      this.currentHealth.lastError = undefined;
      this.currentHealth.lastSeenAt = Date.now();
      this.ctx.reportHealth(this.currentHealth);
    } catch {
      this.disconnected('OpenCode V2 session reconciliation failed');
    } finally { this.reconciling = false; }
  }

  private async refreshLatestMessage(id: string): Promise<void> {
    try {
      const page = await this.get<{ data: Array<{ id: string; time: { created: number }; content: Array<{ type: string; text?: string }> }> }>(
        `/session/${encodeURIComponent(id)}/message?limit=1&order=desc&type=assistant`);
      const message = page.data[0];
      if (!message) return;
      const preview = message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').slice(0, 400);
      if (!preview) return;
      const payload = { messageId: message.id, role: 'assistant', preview };
      this.messages.set(id, JSON.stringify(payload));
      this.ctx?.emit({ type: 'message.completed', runId: `opencode:${id}`, ts: message.time.created, payload });
    } catch { /* Optional preview failure does not invalidate session status. */ }
  }

  public async importHistory(ctx: AdapterContext, limit: number, cutoff: number): Promise<number> {
    this.ctx = ctx;
    if (limit <= 0) return 0;
    if (!await this.discoverServiceUrl()) return 0;
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await this.get<{ data: OpenCodeSession[]; cursor: { next?: string | null } }>(
        `/session?limit=${Math.min(50, limit - count)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=desc'}`);
      for (const info of page.data) {
        if (info.time.updated < cutoff) return count;
        this.emitSession(info, true);
        if (++count >= limit) return count;
      }
      cursor = page.data.length ? page.cursor.next ?? undefined : undefined;
    } while (cursor);
    return count;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    this.abort = new AbortController();
    await this.probe();
    await this.reconcileSessionStatuses();
    this.loop = this.streamLoop(this.abort.signal);
    this.timer = setInterval(() => { void this.reconcileSessionStatuses(); }, this.reconcileIntervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    await this.loop;
  }

  private disconnected(message: string): void {
    this.statuses.clear();
    this.currentHealth.status = 'degraded';
    this.currentHealth.lastError = message;
    this.ctx?.reportHealth(this.currentHealth);
  }

  private async handleEvent(raw: Record<string, unknown>): Promise<void> {
    const data = raw.data as { sessionID?: string; id?: string; name?: string } | undefined;
    if (!data?.sessionID) return;
    const id = data.sessionID;
    const toolKey = `${id}:${data.id}`;
    if (raw.type === 'session.tool.input.started' && data.name) this.toolNames.set(toolKey, data.name);
    if (String(raw.type).startsWith('session.tool.')) {
      raw = { ...raw, data: { ...data, name: data.name ?? this.toolNames.get(toolKey) } };
      if (raw.type === 'session.tool.success' || raw.type === 'session.tool.failed') this.toolNames.delete(toolKey);
    }
    // Hydrate identity before any activity can create an anonymous run.
    if (!this.snapshots.has(id) || ['session.created', 'session.renamed', 'session.moved', 'session.usage.updated',
      'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(String(raw.type))) {
      const detail = await this.get<{ data: OpenCodeSession }>(`/session/${encodeURIComponent(id)}`);
      this.emitSession(detail.data);
    }
    for (const event of normalizeOpenCodeSseEvent(raw)) {
      if (event.type === 'state.changed') this.statuses.set(id, {
        active: (event.payload as { to?: string }).to === 'running', checkedAt: Date.now()
      });
      if (event.type === 'message.completed') {
        const fingerprint = JSON.stringify(event.payload);
        if (this.messages.get(id) === fingerprint) continue;
        this.messages.set(id, fingerprint);
      }
      this.ctx?.emit(event);
    }
  }

  private async streamLoop(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        await this.probe();
        if (!this.serviceUrl) throw new Error('No OpenCode V2 service');
        const response = await fetch(`${this.serviceUrl}/api/event`, {
          headers: { ...this.serviceHeaders, Accept: 'text/event-stream' }, signal
        });
        if (!response.ok || !response.body) throw new Error('OpenCode V2 event connection failed');
        await this.reconcileSessionStatuses();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let data: string[] = [];
        try {
          while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
              else if (line === '' && data.length) {
                const text = data.join('\n');
                data = [];
                let raw: Record<string, unknown>;
                try { raw = JSON.parse(text); } catch { continue; }
                await this.handleEvent(raw);
                backoff = 1000;
              }
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (!signal.aborted) throw new Error('OpenCode V2 event stream closed');
      } catch {
        if (signal.aborted) break;
        this.disconnected('OpenCode V2 event stream disconnected; retrying');
        await delay(backoff, undefined, { signal }).catch(() => {});
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }
}
