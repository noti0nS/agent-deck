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

const execFileAsync = promisify(execFile);

export interface CodexAdapterOptions {
  sessionsDir?: string;
  pollIntervalMs?: number;
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
  let nativeId = String(payload.id || payload.thread_id || payload.session_id || fallbackId);
  if (!nativeId) nativeId = fallbackId;
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
      type: 'compact.started',
      runId,
      ts,
      payload: {}
    });
  } else if (type === 'event_msg') {
    const evType = String(payload.type || '');
    if (evType === 'thread_settings_applied') {
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
    } else if (evType === 'task_complete') {
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
        payload: { from: 'done', to: 'idle', reason: 'task_complete' }
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
          stepId: String(payload.id || payload.call_id || `${nativeId}:${lineIndex}`),
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
          ok: true
        }
      });
    } else if (itemType === 'message' && payload.role === 'assistant') {
      const content = Array.isArray(payload.content)
        ? (payload.content as Array<Record<string, unknown>>)
        : [];
      for (const c of content) {
        if (typeof c.text === 'string' && c.text.trim()) {
          events.push({
            type: 'message.completed',
            runId,
            ts,
            payload: {
              messageId: String(payload.id || `${nativeId}:${lineIndex}`),
              role: 'assistant',
              preview: c.text.slice(0, 400)
            }
          });
        }
      }
    }
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
      cacheWrite
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
        costSource: 'estimated',
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
  private offsets: Record<string, { offset: number; model: string; nativeId: string }> = {};
  private currentHealth: AdapterHealth;

  constructor(options: CodexAdapterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? join(homedir(), '.codex', 'sessions');
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
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
      liveEvents: hasDaemonDir && agentsOracleOk,
      usagePrecision: hasSessionsDir ? 'derived' : 'none',
      attention: hasSessionsDir,
      subagents: true,
      notes
    };

    this.currentHealth = {
      source: 'codex',
      status: hasSessionsDir || agentsOracleOk ? 'connected' : 'off',
      capabilities: caps,
      lastSeenAt: Date.now()
    };

    return caps;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.probe();
    ctx.reportHealth(this.currentHealth);

    this.scanRolloutFiles(15);
    this.pollTimer = setInterval(() => {
      this.scanRolloutFiles(10);
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  public async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public health(): AdapterHealth {
    return this.currentHealth;
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
    this.currentHealth.lastSeenAt = Date.now();
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
    const state = this.offsets[filePath] ?? {
      offset: 0,
      model: 'gpt-5',
      nativeId: baseName
    };
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
          i,
          state.model,
          mtimeMs
        );
        state.model = res.model;
        state.nativeId = res.nativeId;
        for (const ev of res.events) {
          this.ctx.emit(ev);
        }
        count += 1;
      } catch {
        // Resilient to malformed JSONL lines
      }
    }

    this.offsets[filePath] = state;
    return count;
  }
}
