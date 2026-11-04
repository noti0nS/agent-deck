import type { AgentRun } from './types.js';
import { compareRunsByPriority } from './status-engine.js';

/** A project/tool card represents the most recently active top-level conversation. */
export function getDashboardSessions(runs: AgentRun[]): AgentRun[] {
  const latest = new Map<string, AgentRun>();
  for (const run of runs) {
    if (run.historical || run.parentId) continue;
    // Legacy synthetic item records lack session metadata. Keep them in the ledger.
    if (!run.projectPath && !run.recentMessages?.length && run.nativeId.startsWith('cmp_')) continue;
    let path = run.projectPath.replaceAll('\\', '/').replace(/\/+$/, '');
    if (/^[a-z]:\//i.test(path)) path = path.toLowerCase();
    const key = `${run.source}:${path || `session:${run.nativeId}`}`;
    const previous = latest.get(key);
    if (!previous || run.lastActivityAt > previous.lastActivityAt ||
      (run.lastActivityAt === previous.lastActivityAt && run.startedAt > previous.startedAt)) {
      latest.set(key, run);
    }
  }
  return [...latest.values()].sort(compareRunsByPriority);
}
