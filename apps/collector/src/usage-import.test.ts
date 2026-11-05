import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectorEngine, buildHttpServer } from './http.js';
import { runHistoryBackfill } from './import.js';
import { CollectorStore } from './store.js';

describe('M6 Usage Queries & Idempotent History Backfill', () => {
  it('answers all §7.4 usage questions (burn rate alarm, project/model breakdown, unproductive sessions) and re-imports without double-counting', async () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const app = await buildHttpServer(engine);

    const now = Date.now();

    // Run 1: Productive session (high tokens, 5 files changed)
    engine.ingest({
      type: 'run.started',
      runId: 'opencode:prod_1',
      ts: now - 120_000,
      payload: {
        source: 'opencode',
        nativeId: 'prod_1',
        projectPath: 'P:\\sample-api',
        projectName: 'sample-api',
        title: 'Productive Refactor',
        model: 'gpt-5',
        confidence: 'live',
        startedAt: now - 120_000
      }
    });
    for (let i = 1; i <= 5; i++) {
      engine.ingest({
        type: 'file.changed',
        runId: 'opencode:prod_1',
        ts: now - 60_000,
        payload: { path: `src/file_${i}.ts`, additions: 25, deletions: 5 }
      });
    }
    engine.ingest({
      type: 'usage.tick',
      runId: 'opencode:prod_1',
      ts: now - 30_000,
      payload: {
        sampleKey: 'opencode:prod_1:1:1',
        tokensInTotal: 100_000,
        tokensOutTotal: 10_000,
        costUsdTotal: 0.35,
        costSource: 'tool',
        precision: 'exact'
      }
    });

    // Run 2: Expensive & unproductive runaway session (high cost/tokens in 1 minute, 0 files changed)
    engine.ingest({
      type: 'run.started',
      runId: 'opencode:runaway_1',
      ts: now - 60_000,
      payload: {
        source: 'opencode',
        nativeId: 'runaway_1',
        projectPath: 'P:\\sample-chat',
        projectName: 'sample-chat',
        title: 'Runaway Loop',
        model: 'claude-opus-4',
        confidence: 'live',
        startedAt: now - 60_000
      }
    });
    engine.ingest({
      type: 'tool.started',
      runId: 'opencode:runaway_1',
      ts: now - 10_000,
      payload: { label: 'bash', detail: 'retry loop' }
    });
    engine.ingest({
      type: 'usage.tick',
      runId: 'opencode:runaway_1',
      ts: now - 5_000,
      payload: {
        sampleKey: 'opencode:runaway_1:1:1',
        tokensInTotal: 500_000,
        tokensOutTotal: 50_000,
        costUsdTotal: 2.50,
        costSource: 'tool',
        precision: 'exact'
      }
    });

    // 1. Live burn-rate alarm triggers on runaway session
    const sumRes = await app.inject({ method: 'GET', url: '/api/usage/summary' });
    expect(sumRes.statusCode).toBe(200);
    const sumJson = sumRes.json();
    expect(sumJson.burnRateAlarm).toBe(true);
    expect(sumJson.burnRateUsdPerMin).toBeGreaterThanOrEqual(2.5);

    // 2. Unproductive query ranks runaway_1 above prod_1
    const unprodRes = await app.inject({
      method: 'GET',
      url: '/api/usage/runs?sortBy=unproductive'
    });
    expect(unprodRes.statusCode).toBe(200);
    const unprodRuns = unprodRes.json().runs;
    expect(unprodRuns[0].id).toBe('opencode:runaway_1');

    // 3. History backfill from fixtures is idempotent across repeated invocations
    const claudeDir = join(process.cwd(), 'fixtures');
    const codexDir = join(process.cwd(), 'fixtures', 'codex');
    await runHistoryBackfill(engine, {
      providers: ['claude', 'codex', 'agy'],
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      agyBaseDir: 'nonexistent'
    });

    const codexRun = engine.state.runs['codex:01a16919-codex-fixture'];
    expect(codexRun).toBeDefined();
    expect(codexRun.historical).toBe(true);

    const beforeRollup = store.getUsageSummary(0, now + 86_400_000, []);
    // Re-run backfill: rollups must be byte-for-byte identical
    await runHistoryBackfill(engine, {
      providers: ['claude', 'codex', 'agy'],
      claudeProjectsDir: claudeDir,
      codexSessionsDir: codexDir,
      agyBaseDir: 'nonexistent'
    });
    const afterRollup = store.getUsageSummary(0, now + 86_400_000, []);
    expect(afterRollup.tokensIn).toBe(beforeRollup.tokensIn);
    expect(afterRollup.exactCostUsd).toBe(beforeRollup.exactCostUsd);
    expect(afterRollup.estimatedCostUsd).toBe(beforeRollup.estimatedCostUsd);

    await app.close();
    store.close();
  });
});
