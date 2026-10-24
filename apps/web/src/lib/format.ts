import type { RunStatus, Source } from '@agent-deck/core';

export const SOURCE_COLORS: Record<Source, string> = {
  opencode: '#6BA6FF',
  claude: '#D97757',
  codex: '#E8EBF0',
  agy: '#A78BFA',
  pty: '#38BDF8'
};

export const STATUS_COLORS: Record<RunStatus, string> = {
  waiting: '#FFB020',
  failed: '#FF5E5E',
  stalled: '#7A8496',
  compacting: '#6BA6FF',
  running: '#3DDC97',
  starting: '#3DDC97',
  done: 'rgba(61, 220, 151, 0.4)',
  idle: '#4A5160',
  detached: '#4A5160'
};

export const STATUS_ICONS: Record<RunStatus, string> = {
  waiting: '⚠',
  failed: '✕',
  stalled: '◌',
  compacting: '⇄',
  running: '●',
  starting: '◐',
  done: '✓',
  idle: '○',
  detached: '⊘'
};

export function formatTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCost(costUsd?: number, costSource?: 'tool' | 'estimated' | 'none', precision?: string): string | null {
  if (precision === 'none' || costSource === 'none' || costUsd === undefined || costUsd === null) {
    return null;
  }
  const formatted = costUsd < 0.01 && costUsd > 0 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
  if (costSource === 'tool' && precision === 'exact') {
    return formatted;
  }
  return `${formatted} est.`;
}

export function formatElapsed(startedAt: number, now: number, endedAt?: number): string {
  const end = endedAt ?? now;
  const totalSec = Math.max(0, Math.floor((end - startedAt) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatRelativeAgo(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
