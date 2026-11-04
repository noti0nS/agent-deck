import type { RunStatus } from '@agent-deck/core';

/** Public `claude agents --json --all` contract, not the private jobs files. */
export interface ClaudeSessionInfo {
  sessionId: string;
  cwd: string;
  kind: 'interactive' | 'background';
  startedAt: number;
  name?: string;
  pid?: number;
  status?: 'busy' | 'waiting' | 'idle';
  waitingFor?: string;
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
}

export function parseClaudeSessions(value: unknown): ClaudeSessionInfo[] {
  if (!Array.isArray(value)) throw new Error('Claude session inventory must be an array');
  for (const r of value) {
    if (!r || typeof r !== 'object' || typeof r.cwd !== 'string' ||
      !['interactive', 'background'].includes(r.kind) || !Number.isFinite(r.startedAt) ||
      (r.status !== undefined && !['busy', 'waiting', 'idle'].includes(r.status)) ||
      (r.state !== undefined && !['working', 'blocked', 'done', 'failed', 'stopped'].includes(r.state))) {
      throw new Error('Unsupported Claude session inventory entry');
    }
  }
  // Short background IDs and PIDs are not conversation identities.
  return value.filter((r): r is ClaudeSessionInfo => typeof r.sessionId === 'string' && !!r.sessionId);
}

export function claudeSessionStatus(row: ClaudeSessionInfo): RunStatus {
  if (row.state === 'failed') return 'failed';
  if (row.state === 'stopped') return 'detached';
  if (row.state === 'done') return 'idle';
  // `blocked` can remain in --all after the process exits. It is retained
  // task state, not an open session that can currently receive input.
  if (!row.pid) return 'detached';
  if (row.state === 'blocked' || row.status === 'waiting') return 'waiting';
  if (row.pid && row.status === 'busy') return 'running';
  if (row.pid && row.status === 'idle') return 'idle';
  // Background state=working may persist after its process exits or while
  // waiting between scheduled iterations. It is not evidence of busy execution.
  return 'detached';
}
