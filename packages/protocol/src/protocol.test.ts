import { describe, expect, it } from 'vitest';
import { DeckPrefsSchema, EnvelopeSchema, PairRequestSchema, UsageQuerySchema } from './index.js';

describe('packages/protocol', () => {
  it('validates Envelope and UsageQuery schemas', () => {
    const env = EnvelopeSchema.parse({
      seq: 42,
      ts: Date.now(),
      type: 'tool.started',
      runId: 'opencode:ses_123',
      payload: { label: 'bash', detail: 'npm test' }
    });
    expect(env.seq).toBe(42);

    const q = UsageQuerySchema.parse({ bucket: '1d', by: 'model', limit: '25' });
    expect(q.bucket).toBe('1d');
    expect(q.by).toBe('model');
    expect(q.limit).toBe(25);

    const p = PairRequestSchema.parse({ code: '7F2K-9QRT' });
    expect(p.code).toBe('7F2K-9QRT');

    const prefs = DeckPrefsSchema.parse({ columns: 3, defaultView: 'usage' });
    expect(prefs.columns).toBe(3);
  });
});
