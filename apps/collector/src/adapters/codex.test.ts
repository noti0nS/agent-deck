import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateApiCostUsd } from '@agent-deck/pricing';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { CodexAdapter } from './codex.js';

describe('CodexAdapter & Rollout Fixture Replay', () => {
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
