import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRICE_TABLE, setPriceTable } from '@agent-deck/pricing';
import { catalogPriceTable } from '../model-catalog.js';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { AgyAdapter, readAgyLatestMessage } from './agy.js';
import { decodeAgyUsageBlob, priceAgyUsage } from './agy-usage.js';

// Synthetic protobuf messages using the field layout observed in AGY 1.5.1.
function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
function field(number: number, value: number | bigint | string | Buffer): Buffer {
  if (typeof value === 'number' || typeof value === 'bigint') return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function generation(model: string, id = 'generation-1', counts: Record<number, number> = { 2: 100_000, 3: 40_000, 4: 10_000, 5: 200_000, 9: 10_000, 10: 30_000 }): Buffer {
  return Buffer.concat([
    field(1, Buffer.concat([
      field(4, Buffer.concat([...Object.entries(counts).map(([n, value]) => field(Number(n), value)), field(11, id)])),
      field(19, model), field(9, Buffer.concat([field(4, field(1, 1_793_836_800)), field(7, 0xffffffffffffffffn)]))
    ])),
    field(4, 'shared-execution')
  ]);
}
const usageCatalog = {
  anthropic: { models: { 'claude-opus-5-5': { cost: { input: 2, output: 10, cache_read: 0.5, cache_write: 2.5 } } } },
  google: { models: { 'gemini-3.8-flash': { cost: { input: 1, output: 5, cache_read: 0.25, cache_write: 1.25 } } } }
};
afterEach(() => setPriceTable(PRICE_TABLE));

describe('AGY native usage', () => {
  it('decodes uncached input, cache and inclusive output without charging reasoning twice', () => {
    setPriceTable(catalogPriceTable(usageCatalog, 1));
    const usage = decodeAgyUsageBlob(generation('claude-opus-5-5-medium'))!;
    expect(usage).toMatchObject({ model: 'claude-opus-5-5-medium', responseId: 'generation-1',
      tokensIn: 100_000, tokensOut: 30_000, tokensReasoning: 10_000, cacheRead: 200_000, cacheWrite: 10_000,
      ts: 1_793_836_800_000 });
    expect(priceAgyUsage(usage)).toEqual({ model: 'claude-opus-5-5', cost: 0.725 });
    expect(priceAgyUsage({ ...usage, model: 'gemini-3.8-flash-n' })).toEqual({ model: 'gemini-3.8-flash', cost: 0.3625 });
    expect(priceAgyUsage({ ...usage, model: 'placeholder', modelName: 'Gemini 3.8 Flash (High)' }).model).toBe('gemini-3.8-flash');
    expect(priceAgyUsage({ ...usage, model: 'MODEL_PLACEHOLDER_M999' }).cost).toBeUndefined();
  });

  it('uses total output when the response breakdown is absent or disagrees and accepts cache-only usage', () => {
    expect(decodeAgyUsageBlob(generation('model', 'id', { 2: 1, 3: 50 }))).toMatchObject({ tokensOut: 50, tokensReasoning: 0 });
    expect(decodeAgyUsageBlob(generation('model', 'id', { 3: 50, 9: 20, 10: 99 }))).toMatchObject({ tokensOut: 30, tokensReasoning: 20 });
    expect(decodeAgyUsageBlob(generation('model', 'id', { 9: 20, 10: 30 }))).toMatchObject({ tokensOut: 30, tokensReasoning: 20 });
    expect(decodeAgyUsageBlob(generation('model', 'id', { 5: 100 }))).toMatchObject({ tokensIn: 0, tokensOut: 0, cacheRead: 100 });
    expect(decodeAgyUsageBlob('{"output_tokens":20,"model":"test","input_tokens":100}')).toMatchObject({ tokensIn: 100, tokensOut: 20 });
  });

  it('rejects corrupt, truncated and unsafe counters instead of searching prompt text for token-shaped JSON', () => {
    const valid = generation('claude-opus-5-5-medium');
    for (let length = 0; length < valid.length; length++) {
      // A valid complete root field may survive removal of the optional generation ID.
      if (length === valid.indexOf(field(4, 'shared-execution'))) continue;
      expect(decodeAgyUsageBlob(valid.subarray(0, length))).toBeNull();
    }
    for (const blob of [
      Buffer.from([0]), Buffer.from([0x0a, 0xff]), Buffer.from([0x0f]),
      field(1, field(4, field(2, 2n ** 60n))),
      field(1, field(4, field(2, '100'))),
      field(3, '{"input_tokens":100,"output_tokens":20}'),
      generation('model', 'id', { 3: 1, 9: 2 }),
      '{"input_tokens":-1,"output_tokens":20}',
      '{"input_tokens":1.5,"output_tokens":20}'
    ]) expect(decodeAgyUsageBlob(blob)).toBeNull();
  });

  it('prices every generation across model switches, late writes, history replay and collector restarts', () => {
    setPriceTable(catalogPriceTable(usageCatalog, 1));
    const dir = mkdtempSync(join(tmpdir(), 'deck-agy-usage-'));
    mkdirSync(join(dir, 'conversations'));
    const path = join(dir, 'conversations', 'session.db');
    const db = new Database(path);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, step_payload BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); INSERT INTO steps (idx,status) VALUES (100,3)');
    const insert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
    insert.run(0, generation('claude-opus-5-5-medium'));
    let store = new CollectorStore(join(dir, 'collector.db'));
    let engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const makeAdapter = () => {
      const adapter = new AgyAdapter({ baseDir: dir, udpPort: 0 });
      adapter['ctx'] = { emit: e => { engine.ingest(e); }, reportHealth: () => {},
        getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v) };
      return adapter;
    };
    try {
      const adapter = makeAdapter();
      expect(adapter.ingestConversationDb('session', path)).toBe(100);
      expect(engine.state.runs['agy:session'].usage).toMatchObject({ costUsd: 0.725, precision: 'derived', costSource: 'estimated' });
      insert.run(1, generation('gemini-3.8-flash-n', 'generation-2'));
      // The step cursor is much larger than this newly committed generation index.
      adapter.ingestConversationDb('session', path, undefined, 100);
      expect(engine.state.runs['agy:session']).toMatchObject({ model: 'gemini-3.8-flash', usage: { tokensIn: 200_000, costUsd: 1.0875 } });
      const before = store.getUsageSummary(0, Date.now(), []);
      insert.run(2, generation('gemini-3.8-flash-n', 'generation-2')); // same native generation
      adapter.ingestConversationDb('session', path);
      expect(store.getUsageSummary(0, Date.now(), []).estimatedCostUsd).toBe(before.estimatedCostUsd);
      store.close();
      store = new CollectorStore(join(dir, 'collector.db'));
      engine = new CollectorEngine({ store, batchIntervalMs: 0 });
      const restarted = makeAdapter();
      restarted.ingestConversationDb('session', path);
      restarted.ingestConversationDb('session', path);
      expect(engine.state.runs['agy:session'].usage).toMatchObject({ tokensIn: 200_000, tokensOut: 60_000, tokensReasoning: 20_000, costUsd: 1.0875 });
      expect(store.getUsageSummary(0, Date.now(), [])).toMatchObject({ tokensIn: 200_000, estimatedCostUsd: 1.0875, exactCostUsd: 0 });
      expect(restarted.health().capabilities.usagePrecision).toBe('derived');
    } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('retries unchanged databases after catalog refresh, preserves hook state and marks unknown usage partial', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-agy-refresh-'));
    mkdirSync(join(dir, 'conversations'));
    const path = join(dir, 'conversations', 'session.db');
    const db = new Database(path);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, step_payload BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(generation('claude-opus-5-5-medium'));
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ baseDir: dir, udpPort: 0 });
    adapter['ctx'] = { emit: e => { engine.ingest(e); }, reportHealth: () => {}, getSetting: () => undefined, setSetting: () => {} };
    try {
      adapter.ingestHookDatagram({ _agent_deck_source: 'agy', hook_event_name: 'PreInvocation', conversationId: 'session', modelName: 'Claude Opus 5.5 (Medium)' });
      adapter.pollConversations();
      expect(engine.state.runs['agy:session'].usage).toMatchObject({ costSource: 'none', precision: 'partial', tokensIn: 100_000 });
      expect(adapter.pollConversations()).toBe(0);
      setPriceTable(catalogPriceTable(usageCatalog, 2));
      expect(adapter.pollConversations()).toBe(1);
      expect(engine.state.runs['agy:session']).toMatchObject({ status: 'running', model: 'claude-opus-5-5', usage: { tokensIn: 100_000, costUsd: 0.725, precision: 'derived' } });
      expect(store.getUsageSummary(0, Date.now(), [])).toMatchObject({ tokensIn: 100_000, estimatedCostUsd: 0.725 });
      db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(generation('unpriced-model', 'generation-2'));
      utimesSync(path, new Date(), new Date(Date.now() + 1000));
      adapter.pollConversations();
      expect(engine.state.runs['agy:session'].usage).toMatchObject({ tokensIn: 200_000, costUsd: 0.725, precision: 'partial' });
    } finally { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('AgyAdapter & SQLite Fixture Replay', () => {
  it('does not treat an empty conversation database as an active session, and can observe its later activity', () => {
    const tempBase = join(tmpdir(), `agent-deck-agy-empty-${Date.now()}`);
    const convDir = join(tempBase, 'conversations');
    mkdirSync(convDir, { recursive: true });
    const dbPath = join(convDir, 'empty.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, step_payload BLOB)');
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ baseDir: tempBase });
    adapter['ctx'] = {
      emit: ev => engine.ingest(ev), reportHealth: h => engine.reportAdapterHealth(h),
      getSetting: k => store.getSetting(k), setSetting: (k, v) => store.setSetting(k, v)
    };
    try {
      adapter.ingestConversationDb('empty', dbPath, undefined, -1, Date.now() - 273 * 3_600_000);
      expect(engine.state.runs['agy:empty'].status).toBe('detached');
      expect(engine.state.aggregates.activeCount).toBe(0);
      db.prepare('INSERT INTO steps (idx, status, metadata) VALUES (?, ?, ?)')
        .run(0, 2, 'call_123  run_command  {"CommandLine":"test"}');
      adapter.ingestConversationDb('empty', dbPath);
      expect(engine.state.runs['agy:empty'].status).toBe('running');
      expect(Object.keys(engine.state.runs)).toEqual(['agy:empty']);
    } finally { db.close(); store.close(); rmSync(tempBase, { recursive: true, force: true }); }
  });

  it('reads the latest assistant message instead of a tool call or system step', () => {
    const tempBase = join(tmpdir(), `agent-deck-agy-message-${Date.now()}`);
    mkdirSync(tempBase, { recursive: true });
    const transcript = join(tempBase, 'transcript.jsonl');
    const ts = '2026-11-04T12:00:00Z';
    writeFileSync(transcript, [
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: ts, content: 'First message' },
      { step_index: 2, type: 'PLANNER_RESPONSE', created_at: ts, tool_calls: [{ name: 'run_command' }] },
      { step_index: 3, type: 'PLANNER_RESPONSE', created_at: ts, content: 'Latest assistant message' },
      { step_index: 4, type: 'SYSTEM_MESSAGE', created_at: ts, content: 'Internal system text' }
    ].map(x => JSON.stringify(x)).join('\n') + '\n{"type":');
    try {
      expect(readAgyLatestMessage(transcript)).toEqual({ id: '3', preview: 'Latest assistant message', ts: Date.parse(ts) });
    } finally { rmSync(tempBase, { recursive: true, force: true }); }
  });

  it('tracks agy conversation step-by-step, ignores stale presence/*.lock files, links parent_references, and keeps usage precision none when undecodable', () => {
    const tempBase = join(tmpdir(), `agent-deck-agy-test-${Date.now()}`);
    const convDir = join(tempBase, 'conversations');
    const presenceDir = join(tempBase, 'presence');
    const transcriptDir = join(tempBase, 'brain', 'conv-agy-1', '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(presenceDir, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, 'transcript.jsonl'), JSON.stringify({
      step_index: 0, type: 'PLANNER_RESPONSE', created_at: '2026-10-23T12:00:00Z', content: 'Checking the hash implementation.'
    }) + '\n');

    // Create a stale presence lock from months ago that MUST NOT produce a phantom session (§5.5, M5 exit)
    writeFileSync(join(presenceDir, 'stale-phantom-id.lock'), 'pid=99999', 'utf8');

    // Create conversation_summaries.db
    const sumDb = new Database(join(tempBase, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        workspace_uris TEXT,
        status TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT
      );
      INSERT INTO conversation_summaries VALUES (
        'conv-agy-1',
        'Update sample cache',
        'Updating hash calculation',
        3,
        '2026-10-23 12:00:00+00:00',
        '["file:///t%3A/R3/sample-desktop"]',
        'CASCADE_RUN_STATUS_RUNNING',
        'gemini-2.5-pro',
        ''
      );
    `);
    sumDb.close();

    // Create conversations/conv-agy-1.db
    const cdb = new Database(join(convDir, 'conv-agy-1.db'));
    cdb.exec(`
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER,
        status INTEGER,
        has_subtrajectory INTEGER,
        metadata BLOB,
        error_details BLOB,
        permissions BLOB,
        task_details BLOB,
        render_info BLOB,
        step_payload BLOB,
        step_format INTEGER
      );
      CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
    `);

    const step1Meta = Buffer.from('call_101  read_file  {"Path":"T:\\\\R3\\\\sample-desktop\\\\Hash.cs"}', 'utf8');
    const step2Meta = Buffer.from('call_102  run_command  {"CommandLine":"dotnet test"}', 'utf8');
    const step2Perm = Buffer.from('Allow command execution: dotnet test', 'utf8');

    cdb
      .prepare('INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, permissions) VALUES (?, ?, ?, ?, ?, ?)')
      .run(0, 132, 3, 0, step1Meta, null);
    cdb
      .prepare('INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, permissions) VALUES (?, ?, ?, ?, ?, ?)')
      .run(1, 132, 5, 0, step2Meta, step2Perm);
    // Undecodable binary gen_metadata
    cdb
      .prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(0, Buffer.from([0x12, 0x02, 0x01, 0x02]), 4);
    cdb.close();

    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new AgyAdapter({ baseDir: tempBase });

    adapter['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    const updated = adapter.pollConversations();
    expect(updated).toBe(1);

    // Ensure phantom lock was ignored
    expect(engine.state.runs['agy:stale-phantom-id']).toBeUndefined();

    const run = engine.state.runs['agy:conv-agy-1'];
    expect(run).toBeDefined();
    expect(run.title).toBe('Update sample cache');
    expect(run.projectName).toBe('sample-desktop');
    expect(run.status).toBe('waiting');
    expect(run.attention?.summary).toContain('Allow command execution: dotnet test');
    expect(run.recentMessages?.[0].preview).toBe('Checking the hash implementation.');
    // Honest usage precision: 'none' rather than fabricated $0.00
    expect(run.usage.precision).toBe('none');
    expect(run.usage.costUsd).toBeUndefined();

    // A completed step retains permission metadata; it is no longer a request.
    const changed = new Database(join(convDir, 'conv-agy-1.db'));
    changed.pragma('journal_mode = WAL');
    changed.prepare('UPDATE steps SET status = 3 WHERE idx = 1').run();
    const summaries = new Database(join(tempBase, 'conversation_summaries.db'));
    summaries.prepare("UPDATE conversation_summaries SET status = 'CASCADE_RUN_STATUS_IDLE'").run();
    summaries.close();
    adapter.pollConversations();
    expect(engine.state.runs['agy:conv-agy-1'].status).toBe('idle');
    expect(engine.state.runs['agy:conv-agy-1'].attention).toBeUndefined();
    expect(engine.state.runs['agy:conv-agy-1'].recentMessages).toHaveLength(1);
    // Replaying history must not resurrect the completed permission.
    adapter.ingestConversationDb('conv-agy-1', join(convDir, 'conv-agy-1.db'));
    expect(engine.state.runs['agy:conv-agy-1'].status).toBe('idle');
    expect(engine.state.runs['agy:conv-agy-1'].attention).toBeUndefined();
    changed.close();
    store.close();
    rmSync(tempBase, { recursive: true, force: true });
  });
});
