import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { AdapterHealth, Capabilities } from '@agent-deck/core';
import { estimateApiCostUsd } from '@agent-deck/pricing';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';
import { CodexAppServerObserver, discoverCodexAppServer, type CodexAppServerOptions } from './codex-app-server.js';

const execFileAsync = promisify(execFile);

export function toolOutcome(output: unknown): boolean | undefined {
  if (typeof output === 'string') {
    try { return toolOutcome(JSON.parse(output)); } catch { return undefined; }
  }
  if (!output || typeof output !== 'object') return undefined;
  const result = output as Record<string, unknown>;
  if (typeof result.exit_code === 'number') return result.exit_code === 0;
  if (typeof result.isError === 'boolean') return !result.isError;
  if (typeof result.ok === 'boolean') return result.ok;
  return undefined;
}

export interface CodexAdapterOptions {
  sessionsDir?: string;
  pollIntervalMs?: number;
  /** Auto-discovers only an already-running managed daemon. false disables it. */
  appServer?: CodexAppServerOptions | false;
  /** Discovery injection for embedded collectors and deterministic transport tests. */
  discoverAppServer?: typeof discoverCodexAppServer;
}

export function normalizeCodexRolloutLine(
  fallbackId: string,
  lineObj: Record<string, unknown>,
  lineIndex: number,
  currentModel = 'gpt-5',
  defaultTs = Date.now()
): { events: EmitEventInput[]; model: string; nativeId: string } {
  const events: EmitEventInput[] = [];
  const type = String(lineObj.type || '');
  const payload = (lineObj.payload ?? {}) as Record<string, unknown>;
  const ts = lineObj.timestamp ? new Date(String(lineObj.timestamp)).getTime() || defaultTs : defaultTs;
  let model = currentModel;
  // A rollout belongs to its session_meta thread. Nested tool/subagent records
  // can reference other threads and must never retarget subsequent events.
  let nativeId = fallbackId;
  const runId = `codex:${nativeId}`;

  if (type === 'session_meta') {
    const id = String(payload.id || payload.session_id || fallbackId);
    nativeId = id;
    const cwd = String(payload.cwd || '');
    const projectName = cwd ? basename(cwd.replace(/\\/g, '/')) : id.slice(0, 8);
    const parentThread = payload.parent_thread_id && payload.parent_thread_id !== id
      ? `codex:${String(payload.parent_thread_id)}`
      : undefined;

    events.push({
      type: 'run.started',
      runId: `codex:${id}`,
      ts,
      payload: {
        source: 'codex',
        nativeId: id,
        parentId: parentThread,
        projectPath: cwd,
        projectName,
        title: projectName,
        model,
        confidence: 'polled',
        startedAt: ts
      }
    });
  } else if (type === 'compacted' || (type === 'response_item' && payload.type === 'compaction')) {
    events.push({
      type: 'compact.completed',
      runId,
      ts,
      payload: {}
    });
  } else if (type === 'event_msg') {
    const evType = String(payload.type || '');
    if (evType === 'item_completed') {
      const item = (payload.item ?? {}) as Record<string, unknown>;
      if (item.type === 'AgentMessage') {
        const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
        const preview = content.map(c => typeof c.text === 'string' ? c.text : '').filter(Boolean).join('\n');
        if (preview.trim()) events.push({
          type: 'message.completed', runId, ts,
          payload: { messageId: String(item.id || `${nativeId}:${lineIndex}`), role: 'assistant', preview: preview.slice(0, 400) }
        });
      } else if (item.type === 'ContextCompaction') {
        events.push({ type: 'compact.completed', runId, ts, payload: {} });
      }
    } else if (evType === 'context_compacted') {
      events.push({ type: 'compact.completed', runId, ts, payload: {} });
    } else if (evType === 'thread_settings_applied') {
      const settings = (payload.thread_settings ?? {}) as Record<string, unknown>;
      if (typeof settings.model === 'string' && settings.model) {
        model = settings.model;
        events.push({
          type: 'run.updated',
          runId,
          ts,
          payload: { model }
        });
      }
    } else if (evType === 'thread_goal_updated') {
      const goal = String(payload.goal || payload.thread_goal || payload.title || '');
      if (goal) {
        events.push({
          type: 'run.updated',
          runId,
          ts,
          payload: {
            title: goal.slice(0, 120),
            subtitle: goal.slice(0, 140)
          }
        });
      }
    } else if (evType === 'task_started') {
      events.push({
        type: 'turn.started',
        runId,
        ts,
        payload: { turn: lineIndex + 1 }
      });
    } else if (evType === 'task_complete' || evType === 'turn_aborted') {
      events.push({ type: 'attention.cleared', runId, ts, payload: { reason: evType } });
      events.push({
        type: 'turn.completed',
        runId,
        ts,
        payload: { turn: lineIndex + 1 }
      });
      // Per M4 exit criterion: Codex card correctly returns to `idle` after a turn completes
      events.push({
        type: 'state.changed',
        runId,
        ts,
        payload: { from: 'done', to: 'idle', reason: evType }
      });
    } else if (evType === 'exec_approval_request' || evType === 'apply_patch_approval_request') {
      const cmd = String(payload.command || payload.reason || 'Approval requested');
      events.push({
        type: 'attention.raised',
        runId,
        ts,
        payload: {
          attention: {
            id: `${nativeId}:approval:${ts}`,
            kind: 'permission',
            summary: cmd,
            requestedAt: ts
          }
        }
      });
    }
  } else if (type === 'response_item') {
    const itemType = String(payload.type || '');
    if (itemType === 'function_call' || itemType === 'local_shell_call' || itemType === 'custom_tool_call') {
      const toolName = String(payload.name || itemType);
      const argsStr = String(payload.arguments || payload.action || '');
      events.push({
        type: 'tool.started',
        runId,
        ts,
        payload: {
          stepId: String(payload.call_id || payload.id || `${nativeId}:${lineIndex}`),
          label: toolName,
          detail: argsStr.slice(0, 120) || toolName,
          tool: toolName
        }
      });
    } else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      events.push({
        type: 'tool.completed',
        runId,
        ts,
        payload: {
          stepId: String(payload.call_id || `${nativeId}:${lineIndex}`),
          label: 'tool',
          ok: toolOutcome(payload.output)
        }
      });
    } else if (itemType === 'message' && payload.role === 'assistant') {
      const content = Array.isArray(payload.content)
        ? (payload.content as Array<Record<string, unknown>>)
        : [];
      const preview = content.map(c => typeof c.text === 'string' ? c.text : '').filter(Boolean).join('\n');
        if (preview.trim()) {
          events.push({
            type: 'message.completed',
            runId,
            ts,
            payload: {
              messageId: String(payload.id || `${nativeId}:${lineIndex}`),
              role: 'assistant',
              preview: preview.slice(0, 400)
            }
          });
        }
    }
  } else if (type === 'turn_context' && typeof payload.model === 'string') {
    model = payload.model;
    events.push({ type: 'run.updated', runId, ts, payload: { model } });
  } else if (type === 'token_usage_record') {
    const usage = (payload.usage ?? payload.turn_token_usage ?? {}) as Record<string, unknown>;
    const tokensIn = Number(usage.input_tokens || 0);
    const tokensOut = Number(usage.output_tokens || 0);
    const tokensReasoning = Number(usage.reasoning_output_tokens || 0);
    const cacheRead = Number(usage.cached_input_tokens || 0);
    const cacheWrite = Number(usage.cache_write_input_tokens || 0);
    const respId = String(payload.response_id || payload.turn_id || lineIndex);

    const estCost = estimateApiCostUsd(model, {
      tokensIn,
      tokensOut,
      tokensReasoning,
      cacheRead,
      cacheWrite,
      inputIncludesCache: true,
      outputIncludesReasoning: true
    });

    events.push({
      type: 'usage.tick',
      runId,
      ts,
      payload: {
        sampleKey: `codex:${nativeId}:resp:${respId}`,
        tokensInDelta: tokensIn,
        tokensOutDelta: tokensOut,
        tokensReasoningDelta: tokensReasoning,
        cacheReadDelta: cacheRead,
        cacheWriteDelta: cacheWrite,
        costUsdDelta: estCost,
        costSource: estCost === undefined ? 'none' : 'estimated',
        precision: 'derived'
      }
    });
  }

  return { events, model, nativeId };
}

export class CodexAdapter implements Adapter {
  public readonly source = 'codex' as const;
  public readonly sessionsDir: string;
  private readonly pollIntervalMs: number;
  private ctx?: AdapterContext;
  private pollTimer: NodeJS.Timeout | null = null;
  private offsets: Record<string, { offset: number; model: string; nativeId: string; identity?: string; line?: number }> = {};
  private validatedIdentities = new Map<string, string>();
  private currentHealth: AdapterHealth;
  private runtime?: CodexAppServerObserver;
  private readonly appServerOptions: CodexAppServerOptions | false;
  private readonly discoverAppServer: typeof discoverCodexAppServer;
  private nextDiscoveryAt = 0;
  private runtimeWork?: Promise<void>;
  private generation = 0;

  constructor(options: CodexAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? join(homedir(), '.codex', 'sessions');
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.appServerOptions = options.appServer ?? (options.sessionsDir ? false : {});
    this.discoverAppServer = options.discoverAppServer ?? discoverCodexAppServer;
    this.currentHealth = {
      source: 'codex',
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

  public async probe(): Promise<Capabilities> {
    const hasSessionsDir = existsSync(this.sessionsDir);
    const daemonControlDir = join(homedir(), '.codex', 'app-server-daemon');
    const hasDaemonDir = existsSync(daemonControlDir);
    let agentsOracleOk = false;

    try {
      await execFileAsync('codex', ['--version'], { timeout: 2000 });
      agentsOracleOk = true;
    } catch {
      agentsOracleOk = false;
    }

    const notes: string[] = [];
    if (hasSessionsDir) notes.push(`rollouts=${this.sessionsDir}`);
    if (hasDaemonDir) notes.push('app-server-daemon=present');
    if (agentsOracleOk) notes.push('cli=codex available');

    const caps: Capabilities = {
      liveEvents: false,
      usagePrecision: hasSessionsDir ? 'derived' : 'none',
      attention: hasSessionsDir,
      subagents: true,
      notes
    };

    this.currentHealth = {
      source: 'codex',
      status: hasSessionsDir ? 'connected' : 'off',
      capabilities: caps,
      configured: hasSessionsDir,
      transport: 'poll'
    };

    return caps;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    const generation = ++this.generation;
    this.ctx = ctx;
    this.offsets = ctx.getSetting<typeof this.offsets>('codex_offsets') ?? {};
    await this.probe();
    if (generation !== this.generation || this.ctx !== ctx) return;
    ctx.reportHealth(this.currentHealth);

    this.scanRolloutFiles(15);
    this.nextDiscoveryAt = 0;
    await this.refreshRuntime();
    if (generation !== this.generation || this.ctx !== ctx) return;
    this.pollTimer = setInterval(() => {
      this.scanRolloutFiles(10);
      void this.refreshRuntime();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  public async stop(): Promise<void> {
    this.generation++;
    this.runtime?.stop();
    this.runtime = undefined;
    this.ctx = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public health(): AdapterHealth {
    return this.currentHealth;
  }

  public sessionAlive(nativeId: string): boolean | undefined {
    return this.runtime?.sessionAlive(nativeId);
  }

  private runtimeHealth(available: boolean, failed = false): void {
    if (!this.ctx) return;
    this.currentHealth.capabilities.liveEvents = available;
    this.currentHealth.transport = available ? 'socket' : 'poll';
    this.currentHealth.status = available ? 'connected' : failed ? 'degraded' : existsSync(this.sessionsDir) ? 'connected' : 'off';
    this.currentHealth.lastError = failed ? 'Codex runtime read unavailable; using rollout evidence' : undefined;
    this.currentHealth.capabilities.notes = this.currentHealth.capabilities.notes.filter(note => !note.startsWith('existing app-server:'));
    if (available) this.currentHealth.capabilities.notes.push('existing app-server: read-only runtime status');
    this.ctx.reportHealth(this.currentHealth);
  }

  private refreshRuntime(now = Date.now()): Promise<void> {
    if (this.runtimeWork) return this.runtimeWork;
    if (!this.ctx || this.appServerOptions === false || (!this.runtime && now < this.nextDiscoveryAt)) return Promise.resolve();
    const ctx = this.ctx;
    const generation = this.generation;
    const current = () => generation === this.generation && this.ctx === ctx;
    const options = this.appServerOptions;
    this.runtimeWork = (async () => {
      try {
        if (!this.runtime) {
          this.nextDiscoveryAt = now + 30_000;
          const endpoint = await this.discoverAppServer(options);
          if (!current()) return;
          if (!endpoint) { this.runtimeHealth(false); return; }
          this.runtime = new CodexAppServerObserver(endpoint, event => {
            if (current()) ctx.emit(event);
          }, () => { if (current()) this.runtimeHealth(false, true); });
        }
        const runtime = this.runtime;
        await runtime.poll();
        if (!current()) { runtime.stop(); return; }
        if (runtime.lastPolledAt) this.runtimeHealth(true);
      } catch {
        if (!current()) return;
        this.runtime?.stop();
        this.runtime = undefined;
        this.nextDiscoveryAt = now + 30_000;
        this.runtimeHealth(false, true);
      }
    })().finally(() => { this.runtimeWork = undefined; });
    return this.runtimeWork;
  }

  public scanRolloutFiles(maxFiles = 15): number {
    if (!existsSync(this.sessionsDir) || !this.ctx) return 0;
    const files: Array<{ path: string; mtimeMs: number }> = [];

    const walk = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            try {
              const st = statSync(full);
              files.push({ path: full, mtimeMs: st.mtimeMs });
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    };

    walk(this.sessionsDir);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let totalLines = 0;
    for (const f of files.slice(0, maxFiles).reverse()) {
      totalLines += this.tailRolloutFile(f.path, f.mtimeMs);
    }
    this.currentHealth.lastPolledAt = Date.now();
    this.ctx.reportHealth(this.currentHealth);
    return totalLines;
  }

  public tailRolloutFile(filePath: string, mtimeMs = Date.now()): number {
    if (!this.ctx) return 0;
    let st;
    try {
      st = statSync(filePath);
    } catch {
      return 0;
    }

    const baseName = basename(filePath).replace(/\.jsonl$/, '');
    const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
    const previous = this.offsets[filePath];
    const state = previous && previous.identity === identity && st.size >= previous.offset ? previous : {
      offset: 0,
      model: 'gpt-5',
      nativeId: baseName,
      identity,
      line: 0
    };
    if (state.offset === 0 || this.validatedIdentities.get(filePath) !== identity) {
      // Old persisted offsets may contain an item ID. Recover the authoritative
      // thread ID without replaying usage or tool calls already ingested.
      const header = Buffer.alloc(Math.min(st.size, 1024 * 1024));
      const headerFd = openSync(filePath, 'r');
      try {
        const bytes = readSync(headerFd, header, 0, header.length, 0);
        const newline = header.indexOf(10, 0);
        if (newline < 0 || newline >= bytes) return 0;
        const meta = JSON.parse(header.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
        if (meta.type !== 'session_meta') return 0;
        const parsed = normalizeCodexRolloutLine(baseName, meta, 0, state.model, mtimeMs);
        state.nativeId = parsed.nativeId;
        if (state.offset > 0) {
          for (const event of parsed.events) {
            this.ctx.emit({ ...event, type: 'run.updated' });
          }
          this.ctx.setSetting('codex_offsets', this.offsets);
        }
        this.validatedIdentities.set(filePath, identity);
      } catch {
        this.currentHealth.parseErrors = (this.currentHealth.parseErrors ?? 0) + 1;
        return 0;
      } finally {
        closeSync(headerFd);
      }
    }
    const startOffset = st.size < state.offset ? 0 : state.offset;
    if (st.size <= startOffset) return 0;

    const lengthToRead = st.size - startOffset;
    const buf = Buffer.alloc(lengthToRead);
    const fd = openSync(filePath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, lengthToRead, startOffset);
    } finally {
      closeSync(fd);
    }

    const text = buf.subarray(0, bytesRead).toString('utf8');
    const lastNewlineIdx = text.lastIndexOf('\n');
    if (lastNewlineIdx === -1) return 0;

    const completeChunk = text.slice(0, lastNewlineIdx + 1);
    state.offset = startOffset + Buffer.byteLength(completeChunk, 'utf8');

    const lines = completeChunk.split(/\r?\n/).filter((l) => l.trim().length > 0);
    let count = 0;

    for (let i = 0; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]) as Record<string, unknown>;
        const res = normalizeCodexRolloutLine(
          state.nativeId,
          obj,
          (state.line ?? 0) + i,
          state.model,
          mtimeMs
        );
        state.model = res.model;
        state.nativeId = res.nativeId;
        for (const ev of res.events) {
          this.ctx.emit(ev);
          if (ev.runId) this.runtime?.restoreStatus(ev.runId.slice('codex:'.length));
          this.currentHealth.lastEventAt = Math.max(this.currentHealth.lastEventAt ?? 0, ev.ts ?? mtimeMs);
          this.currentHealth.lastSeenAt = this.currentHealth.lastEventAt;
        }
        if (!res.events.length) this.currentHealth.ignoredEvents = (this.currentHealth.ignoredEvents ?? 0) + 1;
        count += 1;
      } catch {
        this.currentHealth.parseErrors = (this.currentHealth.parseErrors ?? 0) + 1;
      }
    }

    state.line = (state.line ?? 0) + lines.length;
    this.offsets[filePath] = state;
    this.ctx.setSetting('codex_offsets', this.offsets);
    return count;
  }
}
