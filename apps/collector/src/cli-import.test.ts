import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PRICE_TABLE, setPriceTable } from '@agent-deck/pricing';
import { AgyAdapter } from './adapters/agy.js';
import { runCli } from './cli.js';
import { CollectorStore } from './store.js';

it('uses the persisted price catalog during explicit AGY history imports and reimports idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-import-pricing-'));
  const dbPath = join(dir, 'collector.db');
  const conversation = join(dir, 'conversation.db');
  const db = new Database(conversation);
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, step_payload BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(JSON.stringify({ model: 'agy-import-model', input_tokens: 100_000, output_tokens: 10_000 }));
  db.close();
  const setup = new CollectorStore(dbPath);
  setup.setSetting('provider_setup', { version: 1, providers: ['agy'] });
  setup.setSetting('models_dev_last_attempt', Date.now());
  setup.setSetting('models_dev_catalog', { fetchedAt: Date.now(), catalog: { google: { models: { 'agy-import-model': { cost: { input: 2, output: 10 } } } } } });
  setup.close();
  vi.stubEnv('AGENT_DECK_DB_PATH', dbPath);
  const fetch = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(AgyAdapter.prototype, 'pollConversations').mockImplementation(function (this: AgyAdapter) {
    this.ingestConversationDb('imported', conversation);
    return 1;
  });
  try {
    for (let i = 0; i < 2; i++) expect(await runCli(['import'])).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    const store = new CollectorStore(dbPath);
    try {
      expect(store.loadAllRuns()['agy:imported']).toMatchObject({ historical: true, usage: { tokensIn: 100_000, tokensOut: 10_000, costUsd: 0.3, costSource: 'estimated' } });
      expect(store.getUsageSummary(0, Date.now(), [])).toMatchObject({ tokensIn: 100_000, tokensOut: 10_000, estimatedCostUsd: 0.3 });
    } finally { store.close(); }
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); setPriceTable(PRICE_TABLE);
    rmSync(dir, { recursive: true, force: true });
  }
});
