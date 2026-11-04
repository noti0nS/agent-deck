import { execFile } from 'node:child_process';
import { createSocket, type Socket } from 'node:dgram';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { AdapterHealth, Capabilities, Confidence, RunStatus } from '@agent-deck/core';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';
import { withReadonlySqlite } from './readonly-sqlite.js';
import { AGY_HOOKS_PATH, AgyHookNormalizer, agyHooksInstalled } from './agy-hooks.js';

const execFileAsync = promisify(execFile);

export interface AgySummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  step_count: number | null;
  last_modified_time: string | null;
  workspace_uris: string | null;
  status: string | null;
  agent_name: string | null;
  parent_conversation_id: string | null;
}

export interface AgyStepRow {
  idx: number;
  step_type: number;
  status: number;
  has_subtrajectory: number;
  metadata: Buffer | string | null;
  error_details: Buffer | string | null;
  permissions: Buffer | string | null;
  task_details: Buffer | string | null;
  step_payload: Buffer | string | null;
}

export function parseAgyWorkspacePath(workspaceUris: string | null | undefined): string {
  if (!workspaceUris) return '';
  try {
    const arr = JSON.parse(workspaceUris) as string[];
    if (Array.isArray(arr) && arr.length > 0) {
      const uri = decodeURIComponent(arr[0]);
      return uri.replace(/^file:\/\/\/?/, '').replace(/\//g, '\\');
    }
  } catch {
    // ignore
  }
  return '';
}

export function mapAgyStepStatus(statusNum: number, summaryStatus?: string | null): RunStatus {
  // In agy steps: 1 = pending/starting, 2 = running, 3 = completed/done, 4 = failed, 5 = waiting/cancelled
  if (summaryStatus === 'CASCADE_RUN_STATUS_IDLE') return 'idle';
  if (statusNum === 2) return 'running';
  if (statusNum === 4) return 'failed';
  if (statusNum === 5) return 'waiting';
  if (summaryStatus && summaryStatus.includes('RUNNING')) return 'running';
  if (statusNum === 3) return 'idle';
  return 'idle';
}

export function decodeAgyStepMetadata(blob: Buffer | string | null | undefined): {
  toolName?: string;
  detail?: string;
} {
  if (!blob) return {};
  const text = Buffer.isBuffer(blob)
    ? blob.toString('utf8')
    : String(blob);

  // Extract embedded tool call identifier & JSON argument payload (e.g. call_1234  run_command  {"CommandLine":"..."})
  const toolMatch = text.match(/call_[0-9a-zA-Z_]+[\s\x00-\x1f]+([a-z_]+)[\s\x00-\x1f]*(\{[^\x00-\x1f]+\})?/i);
  if (toolMatch) {
    const toolName = toolMatch[1];
    let detail = toolName;
    if (toolMatch[2]) {
      try {
        const parsed = JSON.parse(toolMatch[2]) as Record<string, unknown>;
        detail = String(
          parsed.CommandLine || parsed.Path || parsed.TargetFile || parsed.Query || toolMatch[2]
        ).slice(0, 120);
      } catch {
        detail = toolMatch[2].slice(0, 120);
      }
    }
    return { toolName, detail };
  }

  return {};
}

export function decodeAgyPermissions(blob: Buffer | string | null | undefined): string | null {
  if (!blob) return null;
  const text = (Buffer.isBuffer(blob) ? blob.toString('utf8') : String(blob))
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim();
  if (text.length < 3) return null;
  return text.slice(0, 140);
}

/**
 * Attempts to decode token usage from agy `gen_metadata` or `executor_metadata` blobs.
 * If no trustworthy token counter is present, returns `null` so the adapter honestly
 * reports `none` rather than fabricating `0` (§5.5, §7.1, M5 exit criterion).
 */
export function decodeAgyUsageBlob(blob: Buffer | string | null | undefined): {
  tokensIn: number;
  tokensOut: number;
} | null {
  if (!blob) return null;
  const text = Buffer.isBuffer(blob) ? blob.toString('utf8') : String(blob);
  const jsonMatch = text.match(/\{[^{}]*"input_tokens"\s*:\s*(\d+)[^{}]*"output_tokens"\s*:\s*(\d+)[^{}]*\}/);
  if (jsonMatch) {
    const tokensIn = Number(jsonMatch[1] || 0);
    const tokensOut = Number(jsonMatch[2] || 0);
    if (tokensIn > 0 || tokensOut > 0) {
      return { tokensIn, tokensOut };
    }
  }
  return null;
}

export interface AgyAdapterOptions {
  baseDir?: string;
  pollIntervalMs?: number;
  enableRemoteControl?: boolean;
  udpPort?: number;
  hooksPath?: string;
}

/** Read only the latest assistant text, never tool-call arguments or internal steps. */
export function readAgyLatestMessage(transcriptPath: string): { id: string; preview: string; ts: number } | undefined {
  let fd: number | undefined;
  try {
    const stat = statSync(transcriptPath);
    const size = Math.min(stat.size, 128 * 1024);
    const start = stat.size - size;
    const buffer = Buffer.alloc(size);
    fd = openSync(transcriptPath, 'r');
    const length = readSync(fd, buffer, 0, size, start);
    const lines = buffer.subarray(0, length).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (const line of lines.reverse()) {
      try {
        const item = JSON.parse(line) as Record<string, unknown>;
        if (item.type !== 'PLANNER_RESPONSE' || typeof item.content !== 'string' || !item.content.trim()) continue;
        const ts = typeof item.created_at === 'string' ? Date.parse(item.created_at) : NaN;
        return { id: String(item.step_index), preview: item.content.slice(0, 400), ts: Number.isFinite(ts) ? ts : stat.mtimeMs };
      } catch { /* A writer may not have finished the final record yet. */ }
    }
  } catch { /* Transcripts are optional on older CLI versions. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

export class AgyAdapter implements Adapter {
  public readonly source = 'agy' as const;
  public readonly baseDir: string;
  private readonly pollIntervalMs: number;
  private readonly enableRemoteControl: boolean;
  private readonly udpPort: number;
  private readonly hooksPath: string;
  private udpSocket: Socket | null = null;
  private hookNormalizer = new AgyHookNormalizer();
  private hookActivity = new Map<string, { ts: number; working: boolean }>();
  private ctx?: AdapterContext;
  private pollTimer: NodeJS.Timeout | null = null;
  private dbMtimes = new Map<string, { mtimeMs: number; lastStepIdx: number; summary?: string; transcriptMtime?: number }>();
  private latestMessages = new Map<string, string>();
  private currentHealth: AdapterHealth;

  constructor(options: AgyAdapterOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.gemini', 'antigravity-cli');
    this.pollIntervalMs = options.pollIntervalMs ?? 2000; // 2s mtime polling (§5.5)
    this.enableRemoteControl = options.enableRemoteControl ?? false;
    this.udpPort = options.udpPort ?? 4102;
    this.hooksPath = options.hooksPath ?? AGY_HOOKS_PATH;
    this.currentHealth = {
      source: 'agy',
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
    const convDir = join(this.baseDir, 'conversations');
    const sumDb = join(this.baseDir, 'conversation_summaries.db');
    const hasDb = existsSync(convDir) || existsSync(sumDb);
    const hooksInstalled = agyHooksInstalled(this.hooksPath);
    let remoteControlActive = false;

    if (this.enableRemoteControl) {
      try {
        const { stdout } = await execFileAsync('agy', ['remote-control', 'status'], { timeout: 2500 });
        remoteControlActive = /^Daemon status:\s*registered\s*$/im.test(stdout);
      } catch {
        remoteControlActive = false;
      }
    }

    const notes: string[] = [];
    notes.push(hooksInstalled ? `hooks=installed (udp:${this.udpPort})` : 'hooks=not installed (run `agent-deck setup agy`)');
    if (hasDb) notes.push(`db=${this.baseDir} (read-only, presence/*.lock ignored)`);
    if (this.enableRemoteControl) {
      notes.push(`remote-control=${remoteControlActive ? 'active (enabled by Agent Deck)' : 'off'}`);
    }

    const caps: Capabilities = {
      // Daemon registration is global and does not provide session events.
      liveEvents: hooksInstalled && this.udpSocket !== null,
      // Per §5.5 & M5: gen_metadata blobs do not contain reliable token counters unless JSON metadata is present;
      // report 'none' by default so UI honestly omits cost footer instead of printing $0.00.
      usagePrecision: 'none',
      attention: hasDb,
      subagents: hasDb,
      notes
    };

    this.currentHealth = {
      source: 'agy',
      status: hasDb || hooksInstalled ? 'connected' : 'off',
      capabilities: caps,
      configured: hooksInstalled,
      transport: hooksInstalled ? 'udp' : 'poll'
    };

    return caps;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.probe();
    ctx.reportHealth(this.currentHealth);

    if (this.udpPort > 0) {
      await new Promise<void>(resolve => {
        const socket = createSocket('udp4');
        socket.on('message', (message, remote) => {
          if (remote.address !== '127.0.0.1') return;
          try { this.ingestHookDatagram(JSON.parse(message.toString('utf8'))); }
          catch { this.currentHealth.parseErrors = (this.currentHealth.parseErrors ?? 0) + 1; }
        });
        socket.on('error', error => {
          this.currentHealth.status = 'degraded';
          this.currentHealth.capabilities.liveEvents = false;
          this.currentHealth.lastError = error.message;
          this.ctx?.reportHealth(this.currentHealth);
          try { socket.close(); } catch { /* already closed */ }
          this.udpSocket = null;
          resolve();
        });
        socket.bind(this.udpPort, '127.0.0.1', () => {
          this.udpSocket = socket;
          socket.unref();
          this.currentHealth.capabilities.liveEvents = agyHooksInstalled(this.hooksPath);
          this.ctx?.reportHealth(this.currentHealth);
          resolve();
        });
      });
    }

    this.pollConversations();
    this.pollTimer = setInterval(() => {
      this.pollConversations();
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  public async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.udpSocket) {
      const socket = this.udpSocket;
      this.udpSocket = null;
      await new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } });
    }
  }

  public sessionAlive(nativeId: string): boolean | undefined {
    const evidence = this.hookActivity.get(nativeId);
    return evidence?.working && Date.now() - evidence.ts <= 120_000 ? true : undefined;
  }

  public ingestHookDatagram(raw: Record<string, unknown>, ts = Date.now()): number {
    if (!this.ctx || !raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
    const events = this.hookNormalizer.normalize(raw, ts);
    if (!events.length) return 0;
    const nativeId = String(raw.conversationId);
    const eventTs = events[0].ts ?? ts;
    this.hookActivity.set(nativeId, { ts: eventTs, working: raw.hook_event_name !== 'SessionStart' && !(raw.hook_event_name === 'Stop' && (raw.fullyIdle === true || !!raw.error)) });
    // Read a known conversation path, never an arbitrary filename from a local datagram.
    if (raw.hook_event_name === 'PostInvocation' || raw.hook_event_name === 'Stop') {
      const message = readAgyLatestMessage(join(this.baseDir, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl'));
      if (message && this.latestMessages.get(nativeId) !== JSON.stringify(message)) {
        this.ctx.emit({ type: 'message.completed', runId: `agy:${nativeId}`, ts: message.ts,
          payload: { messageId: `${nativeId}:message:${message.id}`, role: 'assistant', preview: message.preview } });
        this.latestMessages.set(nativeId, JSON.stringify(message));
      }
    }
    for (const event of events) this.ctx.emit(event);
    this.currentHealth.lastEventAt = eventTs;
    this.currentHealth.lastSeenAt = eventTs;
    this.ctx.reportHealth(this.currentHealth);
    return events.length;
  }

  private emitPolled(event: EmitEventInput): boolean {
    const nativeId = event.runId?.slice('agy:'.length) ?? '';
    const hook = this.hookActivity.get(nativeId);
    // Native lifecycle events take precedence over delayed SQLite snapshots.
    if (hook && event.type !== 'usage.tick' && ((event.ts ?? 0) <= hook.ts || Date.now() - hook.ts <= 120_000)) return false;
    this.ctx?.emit(event);
    return !!this.ctx;
  }

  public health(): AdapterHealth {
    return this.currentHealth;
  }

  /**
   * Polls `conversation_summaries.db` and `conversations/<id>.db` mtimes every 2s.
   * Explicitly ignores `presence/*.lock` files (§5.5, M5 exit criterion).
   */
  public pollConversations(maxConversations = 15): number {
    if (!this.ctx) return 0;
    const sumDbPath = join(this.baseDir, 'conversation_summaries.db');
    const convDir = join(this.baseDir, 'conversations');

    const summaries = new Map<string, AgySummaryRow>();
    if (existsSync(sumDbPath)) {
      try {
        withReadonlySqlite(sumDbPath, (db) => {
          const rows = db
            .prepare(
              `SELECT conversation_id, title, preview, step_count, last_modified_time,
                      workspace_uris, status, agent_name, parent_conversation_id
               FROM conversation_summaries
               ORDER BY last_modified_time DESC
               LIMIT ?`
            )
            .all(maxConversations) as AgySummaryRow[];
          for (const r of rows) {
            summaries.set(r.conversation_id, r);
          }
        });
      } catch {
        // ignore
      }
    }

    if (!existsSync(convDir)) return 0;

    const dbFiles: Array<{ id: string; path: string; mtimeMs: number }> = [];
    try {
      for (const entry of readdirSync(convDir, { withFileTypes: true })) {
        // Strictly only .db files inside conversations/, NEVER presence/*.lock
        if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
        const id = entry.name.replace(/\.db$/, '');
        const fullPath = join(convDir, entry.name);
        try {
          const st = statSync(fullPath);
          dbFiles.push({ id, path: fullPath, mtimeMs: Math.max(st.mtimeMs, existsSync(fullPath + '-wal') ? statSync(fullPath + '-wal').mtimeMs : 0) });
        } catch {
          // ignore
        }
      }
    } catch {
      return 0;
    }

    dbFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let updatedCount = 0;

    for (const file of dbFiles.slice(0, maxConversations).reverse()) {
      const prev = this.dbMtimes.get(file.path);
      const summaryKey = JSON.stringify(summaries.get(file.id));
      const transcriptPath = join(this.baseDir, 'brain', file.id, '.system_generated', 'logs', 'transcript.jsonl');
      let transcriptMtime = 0;
      try { transcriptMtime = statSync(transcriptPath).mtimeMs; } catch { /* optional */ }
      if (prev && prev.mtimeMs === file.mtimeMs && prev.summary === summaryKey && prev.transcriptMtime === transcriptMtime) {
        continue;
      }
      const lastStepIdx = this.ingestConversationDb(
        file.id,
        file.path,
        summaries.get(file.id),
        prev?.lastStepIdx ?? -1,
        file.mtimeMs
      );
      this.dbMtimes.set(file.path, { mtimeMs: file.mtimeMs, lastStepIdx, summary: summaryKey, transcriptMtime });
      updatedCount += 1;
    }

    this.currentHealth.lastPolledAt = Date.now();
    this.ctx.reportHealth(this.currentHealth);
    return updatedCount;
  }

  public ingestConversationDb(
    convId: string,
    dbPath: string,
    summary?: AgySummaryRow,
    afterStepIdx = -1,
    mtimeMs = Date.now(),
    confidence: Confidence = 'polled'
  ): number {
    if (!this.ctx || !existsSync(dbPath)) return afterStepIdx;
    const runId = `agy:${convId}`;
    let maxStepIdx = afterStepIdx;

    try {
      withReadonlySqlite(dbPath, (db) => {
        if (afterStepIdx === -1) {
          const workspacePath = parseAgyWorkspacePath(summary?.workspace_uris);
          const projectName = workspacePath
            ? basename(workspacePath.replace(/\\/g, '/'))
            : 'agy-workspace';
          const title =
            (summary?.title && summary.title.trim()) ||
            (summary?.preview && summary.preview.trim().slice(0, 100)) ||
            `Conversation ${convId.slice(0, 8)}`;

          let parentId =
            summary?.parent_conversation_id && summary.parent_conversation_id.trim()
              ? `agy:${summary.parent_conversation_id.trim()}`
              : undefined;

          // Also check parent_references table if present
          if (!parentId) {
            try {
              const pRows = db.prepare('SELECT data FROM parent_references LIMIT 1').all() as Array<{
                data: Buffer | string;
              }>;
              if (pRows.length > 0 && pRows[0].data) {
                const str = Buffer.isBuffer(pRows[0].data)
                  ? pRows[0].data.toString('utf8')
                  : String(pRows[0].data);
                const uuidMatch = str.match(
                  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
                );
                if (uuidMatch && uuidMatch[0] !== convId) {
                  parentId = `agy:${uuidMatch[0]}`;
                }
              }
            } catch {
              // ignore
            }
          }

          this.emitPolled({
            type: 'run.started',
            runId,
            ts: mtimeMs,
            payload: {
              source: 'agy',
              nativeId: convId,
              parentId,
              projectPath: workspacePath,
              projectName,
              title,
              subtitle: summary?.preview?.trim() || undefined,
              model: summary?.agent_name || 'gemini-2.5-pro',
              confidence,
              startedAt: mtimeMs
            }
          });
        }

        const steps = db
          .prepare(
            `SELECT idx, step_type, status, has_subtrajectory, metadata, error_details, permissions, task_details, step_payload
             FROM steps
             WHERE idx >= ?
             ORDER BY idx ASC`
          )
          .all(afterStepIdx) as AgyStepRow[];

        const latest = db.prepare('SELECT idx, status, permissions FROM steps ORDER BY idx DESC LIMIT 1').get() as AgyStepRow | undefined;
        const pending = latest?.status === 5 && summary?.status !== 'CASCADE_RUN_STATUS_IDLE' && decodeAgyPermissions(latest.permissions);
        if (!pending) this.emitPolled({ type: 'attention.cleared', runId, ts: mtimeMs, payload: { reason: 'agy_reconciled' } });

        for (const step of steps) {
          maxStepIdx = Math.max(maxStepIdx, step.idx);
          const decoded = decodeAgyStepMetadata(step.metadata ?? step.step_payload);
          const permSummary = decodeAgyPermissions(step.permissions);

          if (pending && step.idx === latest?.idx && permSummary) {
            this.emitPolled({
              type: 'attention.raised',
              runId,
              ts: mtimeMs,
              payload: {
                attention: {
                  id: `${convId}:step:${step.idx}`,
                  kind: 'permission',
                  summary: permSummary,
                  requestedAt: mtimeMs
                }
              }
            });
          } else if (decoded.toolName) {
            if (step.status === 2) {
              this.emitPolled({
                type: 'tool.started',
                runId,
                ts: mtimeMs,
                payload: {
                  stepId: `${convId}:step:${step.idx}`,
                  label: decoded.toolName,
                  detail: decoded.detail ?? decoded.toolName,
                  tool: decoded.toolName
                }
              });
            } else {
              this.emitPolled({
                type: 'tool.completed',
                runId,
                ts: mtimeMs,
                payload: {
                  stepId: `${convId}:step:${step.idx}`,
                  label: decoded.toolName,
                  detail: decoded.detail ?? decoded.toolName,
                  ok: step.status === 3 ? true : step.status === 4 ? false : undefined
                }
              });
            }
          }
        }

        // Check gen_metadata for decodable token usage; if none, keep precision 'none'
        try {
          const genRows = db
            .prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC')
            .all(afterStepIdx) as Array<{ idx: number; data: Buffer | string }>;
          for (const g of genRows) {
            const usage = decodeAgyUsageBlob(g.data);
            if (usage) {
              this.emitPolled({
                type: 'usage.tick',
                runId,
                ts: mtimeMs,
                payload: {
                  sampleKey: `agy:${convId}:gen:${g.idx}`,
                  tokensInDelta: usage.tokensIn,
                  tokensOutDelta: usage.tokensOut,
                  costSource: 'none',
                  precision: 'partial'
                }
              });
            }
          }
        } catch {
          // ignore
        }

        const message = readAgyLatestMessage(join(this.baseDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl'));
        if (message) {
          const signature = JSON.stringify(message);
          if (this.latestMessages.get(convId) !== signature) {
            if (this.emitPolled({ type: 'message.completed', runId, ts: message.ts,
              payload: { messageId: `${convId}:message:${message.id}`, role: 'assistant', preview: message.preview } })) {
              this.latestMessages.set(convId, signature);
            }
          }
        }

        // Empty database files are created even for abandoned conversations.
        // Neither file existence nor a remote-control daemon proves session liveness.
        {
          const finalStatus = latest ? mapAgyStepStatus(latest.status, summary?.status)
            : summary?.status === 'CASCADE_RUN_STATUS_IDLE' ? 'idle' : 'detached';
          if (!pending) {
            this.emitPolled({
              type: 'state.changed',
              runId,
              ts: mtimeMs,
              payload: {
                from: 'starting',
                to: finalStatus,
                reason: latest ? `step_${latest.idx}_status_${latest.status}` : 'no_conversation_activity',
                confidence
              }
            });
          }
        }
      });
    } catch {
      // resilient to locked or corrupted DB
    }

    return maxStepIdx;
  }
}
