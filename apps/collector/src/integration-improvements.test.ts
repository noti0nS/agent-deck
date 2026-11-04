import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPriceTable, PRICE_TABLE, setPriceTable, estimateApiCostUsd } from '@agent-deck/pricing';
import { ModelCatalogSync, SYNC_INTERVAL_MS } from './model-catalog.js';
import { CollectorStore } from './store.js';
import { CollectorEngine } from './http.js';
import { handleMcp } from './mcp.js';
import { CodexAdapter, normalizeCodexRolloutLine } from './adapters/codex.js';
import { normalizeClaudeTranscriptLine, normalizeClaudeHookDatagram, setupClaudeHooks, uninstallClaudeHooks } from './adapters/claude.js';

afterEach(() => setPriceTable(PRICE_TABLE));
const catalog = { openai: { models: { 'test-model': { cost: { input: 2, output: 8, cache_read: 0 } } } } };

it('exposes only read-only MCP tools and rejects unsupported actions', async () => {
  const read = vi.fn(async () => []);
  const call = (method: string, params?: unknown) => handleMcp({ jsonrpc: '2.0', id: 1, method, params }, read);
  expect(await call('initialize')).toMatchObject({ result: { capabilities: { tools: {} } } });
  expect(await call('tools/list')).toMatchObject({ result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'execution_tree' })]) } });
  expect(await call('tools/call', { name: 'approve' })).toMatchObject({ error: { code: -32602 } });
  expect(read).not.toHaveBeenCalled();
  expect(await call('tools/call', { name: 'list_sessions' })).toMatchObject({ result: { content: [{ type: 'text', text: '[]' }] } });
});

it('correlates parallel tools by ID and reconstructs child-first hierarchy', () => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
  const start = (id: string, parentId?: string) => engine.ingest({ type: 'run.started', runId: id, payload: { source: 'codex', nativeId: id, parentId, title: id, projectName: 'p', projectPath: '/p', model: 'gpt-5', confidence: 'polled' } });
  start('codex:child', 'codex:parent'); start('codex:parent');
  expect(engine.state.runs['codex:parent'].children).toEqual(['codex:child']);
  for (const id of ['a', 'b']) engine.ingest({ type: 'tool.started', runId: 'codex:child', ts: id === 'a' ? 100 : 200, payload: { stepId: id, label: id, detail: id } });
  engine.ingest({ type: 'tool.completed', runId: 'codex:child', ts: 300, payload: { stepId: 'a', label: 'tool' } });
  expect(engine.state.runs['codex:child'].recentSteps![0]).toMatchObject({ id: 'a', label: 'a', startedAt: 100 });
  expect(engine.state.runs['codex:child'].currentStep?.id).toBe('b');
  expect(store.loadAllRuns()['codex:child'].activeSteps?.map(s => s.id)).toEqual(['b']);
  store.close();
});

it('starts without waiting, persists the catalog in SQLite, and syncs only once daily across restarts', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'deck-catalog-')), 'cache.db');
  let store = new CollectorStore(path);
  let now = 1000;
  let resolve!: (r: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r; }));
  let sync = new ModelCatalogSync(store, fetcher, () => now);
  expect(sync.start()).toBeUndefined();
  expect(getPriceTable()).toBe(PRICE_TABLE);
  resolve(new Response(JSON.stringify(catalog)));
  await sync.sync();
  expect(estimateApiCostUsd('test-model', { tokensIn: 1_000_000, tokensOut: 0 })).toBe(2);
  await sync.stop(); store.close();
  store = new CollectorStore(path);
  sync = new ModelCatalogSync(store, fetcher, () => now);
  await sync.sync(); expect(fetcher).toHaveBeenCalledTimes(1);
  now += SYNC_INTERVAL_MS;
  const pending = sync.sync();
  expect(sync.sync()).toBe(pending);
  resolve(new Response('{}'));
  await pending;
  expect(getPriceTable().rates[0].inputPer1M).toBe(2);
  expect(store.getSetting('models_dev_last_error')).toBeTruthy();
  await sync.stop(); store.close();
});

it('does not invent prices or successful tool results', () => {
  expect(estimateApiCostUsd('unknown-model', { tokensIn: 100, tokensOut: 10 })).toBeUndefined();
  for (const [output, ok] of [[{ exit_code: 1 }, false], [{ exit_code: 0 }, true], ['unstructured', undefined]] as const) {
    const result = normalizeCodexRolloutLine('session', { type: 'response_item', payload: { id: 'item', type: 'function_call_output', call_id: 'call', output } }, 1);
    expect(result.nativeId).toBe('session');
    expect(result.events[0].payload).toMatchObject({ stepId: 'call', ok });
  }
});

it('correlates Claude requests/results and duplicate hooks without marking requests complete', () => {
  const store = new CollectorStore(':memory:');
  const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
  const events = normalizeClaudeTranscriptLine('s', 'p', '/p', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'test' } }] } }, 0);
  events.forEach(e => engine.ingest(e));
  expect(engine.state.runs['claude:s'].recentSteps).toHaveLength(0);
  normalizeClaudeHookDatagram({ session_id: 's', hook_event_name: 'PreToolUse', tool_use_id: 'tool-1', tool_name: 'Bash' }).forEach(e => engine.ingest(e));
  expect(engine.state.runs['claude:s'].usage.toolCalls).toBe(1);
  normalizeClaudeTranscriptLine('s', 'p', '/p', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: true }] } }, 1).forEach(e => engine.ingest(e));
  normalizeClaudeHookDatagram({ session_id: 's', hook_event_name: 'PostToolUse', tool_use_id: 'tool-1', error: true }).forEach(e => engine.ingest(e));
  expect(engine.state.runs['claude:s'].recentSteps).toHaveLength(1);
  expect(engine.state.runs['claude:s'].recentSteps![0].ok).toBe(false);
  store.close();
});

it('preserves post-install user settings when uninstalling hooks', () => {
  const settingsPath = join(mkdtempSync(join(tmpdir(), 'deck-settings-')), 'settings.json');
  writeFileSync(settingsPath, '{"theme":"dark"}');
  setupClaudeHooks({ settingsPath });
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  settings.theme = 'light'; settings.custom = 42;
  writeFileSync(settingsPath, JSON.stringify(settings));
  uninstallClaudeHooks({ settingsPath });
  expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ theme: 'light', custom: 42 });
});

it('keeps Codex fallback usage IDs stable across batches and restores its cursor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-rollout-'));
  const path = join(dir, 'test.jsonl');
  const store = new CollectorStore(':memory:');
  const events: unknown[] = [];
  const ctx = { emit: (e: unknown) => { events.push(e); }, reportHealth: () => {}, getSetting: <T>(k: string) => store.getSetting<T>(k), setSetting: <T>(k: string, v: T) => store.setSetting(k, v) };
  const line = JSON.stringify({ type: 'token_usage_record', payload: { usage: { input_tokens: 1 } } }) + '\n';
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: 's' } }) + '\n' + line);
  const first = new CodexAdapter({ sessionsDir: dir });
  await first.start(ctx); await first.stop();
  appendFileSync(path, line);
  const second = new CodexAdapter({ sessionsDir: dir });
  await second.start(ctx); await second.stop();
  const usage = (events as Array<{ type: string; payload: { sampleKey?: string } }>).filter(e => e.type === 'usage.tick');
  expect(usage).toHaveLength(2);
  expect(new Set(usage.map(e => e.payload.sampleKey)).size).toBe(2);
  expect(second.health().capabilities.liveEvents).toBe(false);
  store.close();
});
