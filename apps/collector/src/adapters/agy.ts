import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { AdapterHealth, Capabilities, Confidence, RunStatus } from '@agent-deck/core';
import type { Adapter, AdapterContext, EmitEventInput } from '../adapter-spi.js';
import { withReadonlySqlite } from './readonly-sqlite.js';

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
}

export class AgyAdapter implements Adapter {
  public readonly source = 'agy' as const;
  public readonly baseDir: string;
  private readonly pollIntervalMs: number;
  private readonly enableRemoteControl: boolean;
  private ctx?: AdapterContext;
  private pollTimer: NodeJS.Timeout | null = null;
  private dbMtimes = new Map<string, { mtimeMs: number; lastStepIdx: number }>();
  private currentHealth: AdapterHealth;

  constructor(options: AgyAdapterOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.gemini', 'antigravity-cli');
    this.pollIntervalMs = options.pollIntervalMs ?? 2000; // 2s mtime polling (§5.5)
    this.enableRemoteControl = options.enableRemoteControl ?? false;
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
    let remoteControlActive = false;

    if (this.enableRemoteControl) {
      try {
        const { stdout } = await execFileAsync('agy', ['remote-control', 'status', '--json'], { timeout: 2500 });
        remoteControlActive = stdout.includes('"registered":true') || stdout.includes('"running":true');
      } catch {
        remoteControlActive = false;
      }
    }

    const notes: string[] = [];
    if (hasDb) notes.push(`db=${this.baseDir} (read-only, presence/*.lock ignored)`);
    if (this.enableRemoteControl) {
      notes.push(`remote-control=${remoteControlActive ? 'active (enabled by Agent Deck)' : 'off'}`);
    }

    const caps: Capabilities = {
      liveEvents: remoteControlActive,
      // Per §5.5 & M5: gen_metadata blobs do not contain reliable token counters unless JSON metadata is present;
      // report 'none' by default so UI honestly omits cost footer instead of printing $0.00.
      usagePrecision: 'none',
      attention: hasDb,
      subagents: hasDb,
      notes
    };

    this.currentHealth = {
      source: 'agy',
      status: hasDb ? 'connected' : 'off',
      capabilities: caps,
      lastSeenAt: Date.now()
    };

    return caps;
  }

  public async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    await this.probe();
    ctx.reportHealth(this.currentHealth);

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
          dbFiles.push({ id, path: fullPath, mtimeMs: st.mtimeMs });
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
      if (prev && prev.mtimeMs === file.mtimeMs) {
        continue;
      }
      const lastStepIdx = this.ingestConversationDb(
        file.id,
        file.path,
        summaries.get(file.id),
        prev?.lastStepIdx ?? -1,
        file.mtimeMs
      );
      this.dbMtimes.set(file.path, { mtimeMs: file.mtimeMs, lastStepIdx });
      updatedCount += 1;
    }

    this.currentHealth.lastSeenAt = Date.now();
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

          this.ctx!.emit({
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
             WHERE idx > ?
             ORDER BY idx ASC`
          )
          .all(afterStepIdx) as AgyStepRow[];

        for (const step of steps) {
          maxStepIdx = Math.max(maxStepIdx, step.idx);
          const decoded = decodeAgyStepMetadata(step.metadata ?? step.step_payload);
          const permSummary = decodeAgyPermissions(step.permissions);

          if (permSummary) {
            this.ctx!.emit({
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
              this.ctx!.emit({
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
              this.ctx!.emit({
                type: 'tool.completed',
                runId,
                ts: mtimeMs,
                payload: {
                  stepId: `${convId}:step:${step.idx}`,
                  label: decoded.toolName,
                  detail: decoded.detail ?? decoded.toolName,
                  ok: step.status !== 4
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
              this.ctx!.emit({
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

        if (steps.length > 0) {
          const lastStep = steps[steps.length - 1];
          const finalStatus = mapAgyStepStatus(lastStep.status, summary?.status);
          if (!decodeAgyPermissions(lastStep.permissions)) {
            this.ctx!.emit({
              type: 'state.changed',
              runId,
              ts: mtimeMs,
              payload: {
                from: 'starting',
                to: finalStatus,
                reason: `step_${lastStep.idx}_status_${lastStep.status}`,
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
