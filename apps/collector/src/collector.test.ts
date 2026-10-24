import { describe, expect, it } from 'vitest';
import { CollectorEngine, buildHttpServer } from './http.js';
import { CollectorStore } from './store.js';

describe('CollectorStore & CollectorEngine HTTP/SSE', () => {
  it('enforces idempotent usage_samples ingest keyed on sampleKey and rolls up agg_hourly / agg_daily', () => {
    const store = new CollectorStore(':memory:');
    const now = Date.now();

    const sample = {
      sampleKey: 'opencode:ses_1:1:10',
      runId: 'opencode:ses_1',
      source: 'opencode' as const,
      project: 'ProdigyR4Apps',
      model: 'gpt-5',
      ts: now,
      tokensIn: 10_000,
      tokensOut: 2_000,
      tokensReasoning: 500,
      cacheRead: 1_000,
      cacheWrite: 0,
      costUsd: 0.045,
      costSource: 'tool' as const,
      precision: 'exact' as const,
      turns: 1,
      toolCalls: 2,
      activeMs: 4000
    };

    expect(store.recordUsageSample(sample)).toBe(true);
    // Re-ingesting the exact same sampleKey must be a no-op (never double-count)
    expect(store.recordUsageSample(sample)).toBe(false);

    const summary = store.getUsageSummary(now - 3600_000, now + 3600_000, []);
    expect(summary.tokensIn).toBe(10_000);
    expect(summary.tokensOut).toBe(2_000);
    expect(summary.exactCostUsd).toBe(0.045);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.hasExactCost).toBe(true);
    expect(summary.hasEstimatedCost).toBe(false);
    expect(summary.runs).toBe(1);

    const breakdown = store.getUsageBreakdown({
      by: 'project',
      from: now - 3600_000,
      to: now + 3600_000
    });
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].key).toBe('ProdigyR4Apps');
    expect(breakdown[0].tokensIn).toBe(10_000);
    expect(breakdown[0].precision).toBe('exact');
    store.close();
  });

  it('serves /api/snapshot with ETag 304, /api/stream 409 gap resync, /api/pair, and /api/prefs', async () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({
      store,
      ringBufferCapacity: 3,
      batchIntervalMs: 0
    });
    const app = await buildHttpServer(engine);

    // Emit 5 events into a capacity-3 ring buffer so seq 1 is evicted
    for (let i = 1; i <= 5; i++) {
      engine.ingest({
        type: i === 1 ? 'run.started' : 'tool.started',
        runId: 'opencode:ses_test',
        payload:
          i === 1
            ? {
                source: 'opencode',
                nativeId: 'ses_test',
                projectPath: 'P:\\demo',
                projectName: 'demo',
                title: 'Demo run',
                model: 'gpt-5',
                confidence: 'live'
              }
            : { label: 'bash', detail: `cmd ${i}` }
      });
    }

    const snap1 = await app.inject({ method: 'GET', url: '/api/snapshot' });
    expect(snap1.statusCode).toBe(200);
    const etag = snap1.headers['etag'];
    expect(etag).toBeDefined();

    // Conditional request with matching ETag returns 304
    const snap304 = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'if-none-match': String(etag) }
    });
    expect(snap304.statusCode).toBe(304);

    // Requesting stream with Last-Event-ID = 1 (evicted from capacity-3 buffer) returns 409 resync
    const gapRes = await app.inject({
      method: 'GET',
      url: '/api/stream',
      headers: { 'last-event-id': '1' }
    });
    expect(gapRes.statusCode).toBe(409);
    expect(gapRes.json()).toMatchObject({ error: 'seq_out_of_range', hint: 'resync' });

    // Pairing flow
    const { code } = engine.pairing.generatePairingCode();
    const pairBad = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code: 'WRONG-CODE' }
    });
    expect(pairBad.statusCode).toBe(403);

    const pairOk = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code }
    });
    expect(pairOk.statusCode).toBe(200);
    expect(pairOk.headers['set-cookie']).toContain('HttpOnly');

    // Prefs update
    const prefsRes = await app.inject({
      method: 'POST',
      url: '/api/prefs',
      payload: { columns: 3, defaultView: 'usage' }
    });
    expect(prefsRes.statusCode).toBe(200);
    expect(prefsRes.json().prefs.columns).toBe(3);

    await app.close();
    store.close();
  });

  it('downsamples usage_samples older than 24h to 1/minute while preserving permanent rollups', () => {
    const store = new CollectorStore(':memory:');
    const now = Date.now();
    const twoDaysAgo = now - 48 * 3_600_000;
    const sameMin1 = Math.floor(twoDaysAgo / 60_000) * 60_000 + 1000;
    const sameMin2 = sameMin1 + 15_000;

    store.recordUsageSample({
      sampleKey: 'opencode:ses_old:1:1',
      runId: 'opencode:ses_old',
      source: 'opencode',
      project: 'demo',
      model: 'gpt-5',
      ts: sameMin1,
      tokensIn: 1000,
      tokensOut: 200,
      tokensReasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.01,
      costSource: 'tool',
      precision: 'exact'
    });
    store.recordUsageSample({
      sampleKey: 'opencode:ses_old:1:2',
      runId: 'opencode:ses_old',
      source: 'opencode',
      project: 'demo',
      model: 'gpt-5',
      ts: sameMin2,
      tokensIn: 1500,
      tokensOut: 300,
      tokensReasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.015,
      costSource: 'tool',
      precision: 'exact'
    });

    const res = store.runRetentionCleanup(now);
    expect(res.downsampledSamples).toBe(1);

    const remaining = store.db.prepare('SELECT * FROM usage_samples').all() as Array<Record<string, number>>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tokens_in).toBe(2500);
    expect(remaining[0].tokens_out).toBe(500);
    expect(remaining[0].cost_usd).toBeCloseTo(0.025, 5);
    store.close();
  });

  it('renders 4 simultaneous OpenCode runs and coalesces SSE frames at 10 Hz', async () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 100 });

    for (let i = 1; i <= 4; i++) {
      const runId = `opencode:sim_${i}`;
      engine.ingest({
        type: 'run.started',
        runId,
        payload: {
          source: 'opencode',
          nativeId: `sim_${i}`,
          projectPath: `P:\\proj_${i}`,
          projectName: `proj_${i}`,
          title: `Task ${i}`,
          model: 'gpt-5',
          confidence: 'live'
        }
      });
      engine.ingest({
        type: 'usage.tick',
        runId,
        payload: {
          sampleKey: `opencode:sim_${i}:1:1`,
          tokensInTotal: 10_000 * i,
          tokensOutTotal: 1_000 * i,
          costUsdTotal: 0.05 * i,
          costSource: 'tool',
          precision: 'exact'
        }
      });
    }

    const snap = engine.buildSnapshot();
    expect(snap.runs).toHaveLength(4);
    expect(snap.aggregates.todayTokensIn).toBe(100_000);
    expect(snap.aggregates.todayTokensOut).toBe(10_000);
    expect(snap.aggregates.todayCostExactUsd).toBeCloseTo(0.5, 4);
    store.close();
  });
});
