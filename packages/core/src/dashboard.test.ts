import { describe, expect, it } from 'vitest';
import { computeDeckAggregates, createInitialRun, getDashboardSessions } from './index.js';

const session = (id: string, ts: number, path = 'P:\\projects\\demo') => createInitialRun(`codex:${id}`, {
  source: 'codex', nativeId: id, projectPath: path, projectName: 'demo', title: id,
  model: 'test', confidence: 'polled'
}, ts);

describe('dashboard conversation selection', () => {
  it('chooses latest conversation per tool and normalized project, not an old running session', () => {
    const old = session('old', 100);
    old.status = 'running';
    const latest = session('new', 200, 'p:/PROJECTS/demo/');
    latest.status = 'idle';
    const otherTool = { ...session('agy', 150), source: 'agy' as const };
    expect(getDashboardSessions([old, latest, otherTool]).map(r => r.nativeId).sort()).toEqual(['agy', 'new']);
  });
  it('keeps subagents, history and legacy compaction items out of project cards', () => {
    const parent = session('parent', 100);
    const child = { ...session('child', 200), parentId: parent.id };
    const historical = { ...session('history', 300), historical: true };
    const artifact = session('cmp_item', 400, '');
    expect(getDashboardSessions([child, historical, artifact, parent])).toEqual([parent]);
    expect(computeDeckAggregates({ historical }).activeCount).toBe(0);
  });
});
