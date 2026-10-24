import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectorEngine } from '../http.js';
import { CollectorStore } from '../store.js';
import {
  OpenCodeAdapter,
  normalizeOpenCodeSseEvent,
  parseOpenCodeModel,
  type OpenCodeSessionRow
} from './opencode.js';

describe('OpenCodeAdapter & fixture replay', () => {
  it('parses OpenCode model JSON and plain strings', () => {
    expect(parseOpenCodeModel('{"id":"gpt-5.6-luna-fast","providerID":"openai"}')).toBe(
      'gpt-5.6-luna-fast'
    );
    expect(parseOpenCodeModel('claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('replays fixtures/opencode/sessions.json and fixtures/opencode/events.jsonl deterministically', () => {
    const store = new CollectorStore(':memory:');
    const engine = new CollectorEngine({ store, batchIntervalMs: 0 });
    const adapter = new OpenCodeAdapter({ dbPath: 'nonexistent.db' });

    adapter['ctx'] = {
      emit: (ev) => engine.ingest(ev),
      reportHealth: (h) => engine.reportAdapterHealth(h),
      getSetting: (k) => store.getSetting(k),
      setSetting: (k, v) => store.setSetting(k, v)
    };

    const sessionsRaw = readFileSync(
      join(process.cwd(), 'fixtures', 'opencode', 'sessions.json'),
      'utf8'
    );
    const sessions = JSON.parse(sessionsRaw) as OpenCodeSessionRow[];
    for (const s of sessions) {
      adapter.emitSessionRow(null, s, 'polled');
    }

    const parentRun = engine.state.runs['opencode:ses_opencode_fixture_1'];
    const childRun = engine.state.runs['opencode:ses_opencode_fixture_child'];
    expect(parentRun).toBeDefined();
    expect(childRun).toBeDefined();
    expect(parentRun.children).toContain('opencode:ses_opencode_fixture_child');
    expect(parentRun.usage.tokensIn).toBe(412000);
    expect(parentRun.usage.tokensOut).toBe(18000);
    expect(parentRun.usage.costUsd).toBe(0.1425);
    expect(parentRun.usage.precision).toBe('exact');
    expect(parentRun.usage.costSource).toBe('tool');

    // Replay SSE events from fixtures/opencode/events.jsonl
    const eventsLines = readFileSync(
      join(process.cwd(), 'fixtures', 'opencode', 'events.jsonl'),
      'utf8'
    )
      .trim()
      .split(/\r?\n/);

    for (const line of eventsLines) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const normalized = normalizeOpenCodeSseEvent(raw, 1792731210000);
      for (const ev of normalized) {
        engine.ingest(ev);
      }
    }

    const updatedParent = engine.state.runs['opencode:ses_opencode_fixture_1'];
    expect(updatedParent.todos).toHaveLength(2);
    expect(updatedParent.todos[0].status).toBe('completed');
    expect(updatedParent.status).toBe('done');
    store.close();
  });
});
