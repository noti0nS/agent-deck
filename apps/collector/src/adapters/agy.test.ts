import Database from 'better-sqlite3';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import { AgyAdapter } from './agy.js';

describe('AgyAdapter & SQLite Fixture Replay', () => {
  it('tracks agy conversation step-by-step, ignores stale presence/*.lock files, links parent_references, and keeps usage precision none when undecodable', () => {
    const tempBase = join(tmpdir(), `agent-deck-agy-test-${Date.now()}`);
    const convDir = join(tempBase, 'conversations');
    const presenceDir = join(tempBase, 'presence');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(presenceDir, { recursive: true });

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
        'Implement CBenef Hash Update',
        'Updating hash calculation',
        3,
        '2026-10-23 12:00:00+00:00',
        '["file:///t%3A/R3/ProdigyR3Apps"]',
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

    const step1Meta = Buffer.from('call_101  read_file  {"Path":"T:\\\\R3\\\\ProdigyR3Apps\\\\Hash.cs"}', 'utf8');
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
    expect(run.title).toBe('Implement CBenef Hash Update');
    expect(run.projectName).toBe('ProdigyR3Apps');
    expect(run.status).toBe('waiting');
    expect(run.attention?.summary).toContain('Allow command execution: dotnet test');
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
    // Replaying history must not resurrect the completed permission.
    adapter.ingestConversationDb('conv-agy-1', join(convDir, 'conv-agy-1.db'));
    expect(engine.state.runs['agy:conv-agy-1'].status).toBe('idle');
    expect(engine.state.runs['agy:conv-agy-1'].attention).toBeUndefined();
    changed.close();
    store.close();
    rmSync(tempBase, { recursive: true, force: true });
  });
});
