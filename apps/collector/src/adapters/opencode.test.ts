import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Service } from '@opencode/client/service';
import { PRICE_TABLE, setPriceTable } from '@agent-deck/pricing';
import { catalogPriceTable } from '../model-catalog.js';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { OpenCodeAdapter, normalizeOpenCodeSseEvent, type OpenCodeSession } from './opencode.js';

const session = (id = 'ses_one'): OpenCodeSession => ({
  ...JSON.parse(readFileSync('fixtures/opencode/sessions.json', 'utf8'))[0], id
});

function fixture() {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
  const ctx = { emit: (event: Parameters<CollectorEngine['ingest']>[0]) => { engine.ingest(event); },
    reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
  return { store, engine, ctx };
}

afterEach(() => { vi.restoreAllMocks(); setPriceTable(PRICE_TABLE); });

describe('OpenCode V2 adapter', () => {
  it.each([
    ['openai', 'gpt-6-astra-fast', 4.55],
    ['opencode-go', 'deepseek-v4.1-flash', 0.48]
  ])('estimates zero-reported costs using %s/%s catalog prices', (providerID, id, expected) => {
    // A gateway-qualified ID and an ambiguous bare ID both need the provider namespace.
    setPriceTable(catalogPriceTable({
      vercel: { models: { 'openai/gpt-6-astra-fast': { cost: { input: 20, output: 100, cache_read: 2 } } } },
      'opencode-go': { models: { 'deepseek-v4.1-flash': { cost: { input: 2, output: 10, cache_read: 0.4, cache_write: 5 } } } },
      reseller: { models: { 'deepseek-v4.1-flash': { cost: { input: 99, output: 99 } } } }
    }, 1));
    const { store, engine, ctx } = fixture();
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = ctx;
    const info = { ...session(), model: { id, providerID }, cost: 0,
      tokens: { input: 100_000, output: 20_000, reasoning: 3_000, cache: { read: 100_000, write: 2_000 } } };
    try {
      adapter['emitSession'](info, true);
      adapter['emitSession'](info, true);
      expect(engine.state.runs['opencode:ses_one'].usage).toMatchObject({ costUsd: expected, costSource: 'estimated' });
      const summary = store.getUsageSummary(0, Date.now(), []);
      expect(summary.estimatedCostUsd).toBeCloseTo(expected);
      expect(summary.tokensIn).toBe(100_000);
      expect(summary.exactCostUsd).toBe(0);
    } finally { store.close(); }
  });

  it('prices unchanged sessions after catalog sync without duplicating usage, including after restart', () => {
    const { store, engine, ctx } = fixture();
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = ctx;
    const info = { ...session(), model: { id: 'new-model', providerID: 'provider' }, cost: 0,
      tokens: { input: 100_000, output: 20_000, reasoning: 3_000, cache: { read: 10_000, write: 0 } } };
    try {
      adapter['emitSession'](info);
      expect(engine.state.runs['opencode:ses_one'].usage.costSource).toBe('none');
      setPriceTable(catalogPriceTable({ provider: { models: { 'new-model': { cost: { input: 2, output: 10, cache_read: 0.5 } } } } }, 1));
      adapter['emitSession'](info);
      expect(engine.state.runs['opencode:ses_one'].usage).toMatchObject({ costUsd: 0.435, costSource: 'estimated' });
      adapter['emitSession'](info);
      const restarted = new OpenCodeAdapter();
      restarted['ctx'] = ctx;
      restarted['emitSession'](info, true);
      expect(store.getUsageSummary(0, Date.now(), [])).toMatchObject({ tokensIn: 100_000, tokensOut: 20_000, estimatedCostUsd: 0.435 });
    } finally { store.close(); }
  });

  it('preserves tool-reported costs and falls back to unqualified model rates', () => {
    const { store, engine, ctx } = fixture();
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = ctx;
    setPriceTable(catalogPriceTable({ openai: { models: { 'gpt-4o': { cost: { input: 2, output: 10, cache_read: 0.5 } } } } }, 1));
    try {
      adapter['emitSession']({ ...session(), model: { id: 'gpt-4o', providerID: 'custom' }, cost: 0 });
      expect(engine.state.runs['opencode:ses_one'].usage).toMatchObject({ costUsd: 0.000435, costSource: 'estimated' });
      adapter['emitSession'](session('ses_paid'));
      expect(engine.state.runs['opencode:ses_paid'].usage).toMatchObject({ costUsd: 0.25, costSource: 'tool', precision: 'exact' });
    } finally { store.close(); }
  });

  it('discovers the registered authenticated service, without starting OpenCode', async () => {
    vi.spyOn(Service, 'discover').mockResolvedValue({ url: 'http://127.0.0.1:49374',
      auth: { type: 'basic', username: 'test', password: 'test-only' } });
    const ensure = vi.spyOn(Service, 'ensure');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"version":"2.2.5"}'));
    const adapter = new OpenCodeAdapter();
    expect((await adapter.probe()).liveEvents).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:49374/api/info', expect.objectContaining({
      headers: { authorization: expect.stringMatching(/^Basic /) }
    }));
    expect(ensure).not.toHaveBeenCalled();
  });

  it('does not fall back to a V1 server or a database when discovery is empty', async () => {
    vi.spyOn(Service, 'discover').mockResolvedValue(undefined);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const adapter = new OpenCodeAdapter();
    expect((await adapter.probe()).liveEvents).toBe(false);
    expect(adapter.health().status).toBe('off');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reconciles identity, usage, busy-to-idle, older active sessions and connection loss', async () => {
    const { store, engine, ctx } = fixture();
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = ctx;
    adapter['serviceUrl'] = 'http://test';
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      fetch.mockResolvedValueOnce(Response.json({ data: [session()] }));
      await adapter.reconcileSessionStatuses();
      expect(engine.state.runs['opencode:ses_one']).toMatchObject({ status: 'running', projectName: 'real-project' });
      expect(adapter.sessionAlive('ses_one')).toBe(true);
      const totals = store.getUsageSummary(0, Date.now(), []);
      expect(totals.tokensIn).toBe(100);
      fetch.mockResolvedValueOnce(Response.json({ data: [] }));
      fetch.mockResolvedValueOnce(Response.json({ data: { ...session(), time: { created: 100, updated: 300, busy: 150, idle: 300 } } }));
      await adapter.reconcileSessionStatuses();
      expect(fetch).toHaveBeenLastCalledWith('http://test/api/session/ses_one', expect.anything());
      expect(engine.state.runs['opencode:ses_one'].status).toBe('idle');
      expect(store.getUsageSummary(0, Date.now(), []).tokensIn).toBe(100);
      fetch.mockRejectedValueOnce(new Error('Disconnected'));
      await adapter.reconcileSessionStatuses();
      expect(adapter.sessionAlive('ses_one')).toBeUndefined();
      expect(adapter.health().status).toBe('degraded');
    } finally { store.close(); }
  });

  it('does not treat recently updated idle metadata as running', async () => {
    const { store, engine, ctx } = fixture();
    const adapter = new OpenCodeAdapter();
    adapter['ctx'] = ctx;
    adapter['serviceUrl'] = 'http://test';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [{ ...session(), time: { created: 100, updated: Date.now() } }] }));
    try {
      await adapter.reconcileSessionStatuses();
      expect(engine.state.runs['opencode:ses_one'].status).toBe('idle');
      expect(adapter.sessionAlive('ses_one')).toBeUndefined();
    } finally { store.close(); }
  });

  it('imports paginated V2 history with a cutoff and idempotent totals', async () => {
    const { store, engine, ctx } = fixture();
    vi.spyOn(Service, 'discover').mockResolvedValue({ url: 'http://test', auth: undefined });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith('/info')) return Response.json({ version: '2.2.5' });
      if (url.includes('cursor=next')) return Response.json({ data: [session('ses_child')], cursor: {} });
      return Response.json({ data: [session()], cursor: { next: 'next' } });
    });
    try {
      for (let i = 0; i < 2; i++) expect(await new OpenCodeAdapter().importHistory(ctx, 100, 0)).toBe(2);
      expect(fetch.mock.calls.some(([url]) => String(url).includes('cursor=next'))).toBe(true);
      expect(engine.state.runs['opencode:ses_one']).toMatchObject({ historical: true, status: 'idle' });
      expect(store.getUsageSummary(0, Date.now(), []).tokensIn).toBe(200);
    } finally { store.close(); }
  });

  it('replays V2 activity, attention and completion envelopes', async () => {
    const { store, engine, ctx } = fixture();
    try {
      const adapter = new OpenCodeAdapter();
      adapter['ctx'] = ctx;
      adapter['emitSession'](session());
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { ...session(), time: { created: 100, updated: 406, busy: 150, idle: 406 } } }));
      for (const line of readFileSync('fixtures/opencode/events.jsonl', 'utf8').trim().split('\n')) {
        const raw = JSON.parse(line);
        await adapter['handleEvent'](raw);
        if (raw.type === 'permission.asked') expect(engine.state.runs['opencode:ses_one'].status).toBe('waiting');
      }
      expect(engine.state.runs['opencode:ses_one'].status).toBe('idle');
      expect(engine.state.runs['opencode:ses_one'].recentMessages?.[0].preview).toBe('Finished');
      expect(normalizeOpenCodeSseEvent({ type: 'session.status', properties: { sessionID: 'ses_one', status: { type: 'busy' } } })).toEqual([]);
    } finally { store.close(); }
  });

  it('consumes split SSE frames, hydrates new sessions, and cancels the stream on stop', async () => {
    const { store, engine, ctx } = fixture();
    const server = createServer((req, res) => {
      if (req.url === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const event = JSON.stringify({ type: 'session.text.ended', data: { sessionID: 'ses_one', assistantMessageID: 'msg_one', ordinal: 0, text: 'Live preview' } });
        res.write(`data: ${event.slice(0, 30)}`);
        res.write(`${event.slice(30)}\r\n\r\n`);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/info' ? { version: '2.2.5' } : { data: req.url === '/api/session/ses_one' ? session() : [] }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const adapter = new OpenCodeAdapter({ serviceUrlOverride: `http://127.0.0.1:${address.port}` });
    try {
      await adapter.start(ctx);
      await vi.waitFor(() => expect(engine.state.runs['opencode:ses_one']?.recentMessages?.[0]?.preview).toBe('Live preview'));
      expect(engine.state.runs['opencode:ses_one'].projectName).toBe('real-project');
    } finally {
      await adapter.stop();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    }
  });
});
