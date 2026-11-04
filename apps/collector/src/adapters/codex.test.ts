import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateApiCostUsd } from '@agent-deck/pricing';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { CodexAdapter, normalizeCodexRolloutLine } from './codex.js';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('CodexAdapter & Rollout Fixture Replay', () => {
  it('keeps tool calls, child references and compaction items in the owning thread', () => {
    let nativeId = 'thread-owner';
    const events = [];
    const rows = [
      { type: 'response_item', payload: { type: 'function_call', id: 'call_1', name: 'exec', thread_id: 'child-thread' } },
      { type: 'response_item', payload: { type: 'compaction', id: 'cmp_item' } },
      { type: 'compacted', payload: {} },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1' } }
    ];
    for (const [i, row] of rows.entries()) {
      const result = normalizeCodexRolloutLine(nativeId, row, i);
      nativeId = result.nativeId;
      events.push(...result.events);
    }
    expect(new Set(events.map(e => e.runId))).toEqual(new Set(['codex:thread-owner']));
    expect(events.filter(e => e.type === 'compact.completed')).toHaveLength(2);
    expect(events.some(e => e.type === 'compact.started' || e.type === 'run.started')).toBe(false);
  });

  it('reads current AgentMessage items and terminates interrupted turns', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const rows = [
      { type: 'session_meta', payload: { id: 'child', session_id: 'root', parent_thread_id: 'root', cwd: 'P:/project' } },
      { type: 'turn_context', payload: { model: 'fixture-model' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'msg_1', content: [{ text: 'Latest' }, { text: 'message' }] } } },
      { type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }
    ];
    for (const [i, row] of rows.entries()) {
      for (const ev of normalizeCodexRolloutLine('child', row, i).events) engine.ingest(ev);
    }
    const run = engine.state.runs['codex:child'];
    expect(Object.keys(engine.state.runs)).toEqual(['codex:child']);
    expect(run.parentId).toBe('codex:root');
    expect(run.recentMessages?.[0].preview).toBe('Latest\nmessage');
    expect(run.model).toBe('fixture-model');
    expect(run.status).toBe('idle');
    store.close();
  });

  it('repairs persisted item IDs from metadata without replaying usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-codex-'));
    const file = join(dir, 'rollout.jsonl');
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    try {
      writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'real-thread', cwd: 'P:/project' } }) + '\n');
      const st = statSync(file);
      const adapter = new CodexAdapter();
      adapter['offsets'][file] = { offset: st.size, nativeId: 'cmp_old', model: 'fixture', identity: `${st.dev}:${st.ino}:${st.birthtimeMs}`, line: 1 };
      adapter['ctx'] = {
        emit: ev => engine.ingest(ev), reportHealth: h => engine.reportAdapterHealth(h),
        getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v)
      };
      appendFileSync(file, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec', call_id: 'call_1' } }) + '\n');
      expect(adapter.tailRolloutFile(file)).toBe(1);
      expect(Object.keys(engine.state.runs)).toEqual(['codex:real-thread']);
      expect(engine.state.runs['codex:real-thread'].projectName).toBe('project');
      expect(engine.state.runs['codex:real-thread'].usage.toolCalls).toBe(1);
      expect(adapter.tailRolloutFile(file)).toBe(0);
      expect(engine.state.runs['codex:real-thread'].usage.toolCalls).toBe(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('tails fixtures/codex/rollout-fixture-1.jsonl, surfaces thread_goal_updated as subtitle, maps exact tokens + derived cost, and returns to idle after task_complete', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new CodexAdapter();

    adapter['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    const fixturePath = join(process.cwd(), 'fixtures', 'codex', 'rollout-fixture-1.jsonl');
    const count = adapter.tailRolloutFile(fixturePath);
    expect(count).toBe(8);

    const run = engine.state.runs['codex:01a16919-codex-fixture'];
    expect(run).toBeDefined();
    expect(run.projectName).toBe('vega-chat');
    expect(run.subtitle).toBe('Audit and optimize SSE reconnect logic');
    expect(run.model).toBe('gpt-5');
    expect(run.usage.tokensIn).toBe(40_000);
    expect(run.usage.tokensOut).toBe(2_000);
    expect(run.usage.tokensReasoning).toBe(500);
    expect(run.usage.cacheRead).toBe(10_000);
    expect(run.usage.precision).toBe('derived');
    expect(run.usage.costSource).toBe('estimated');

    const expectedCost = estimateApiCostUsd('gpt-5', {
      tokensIn: 40_000,
      tokensOut: 2_000,
      tokensReasoning: 500,
      cacheRead: 10_000,
      cacheWrite: 0,
      inputIncludesCache: true,
      outputIncludesReasoning: true
    });
    expect(run.usage.costUsd).toBeCloseTo(expectedCost!, 5);
    expect(run.status).toBe('idle');

    store.close();
  });
});
