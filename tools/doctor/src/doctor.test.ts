import { describe, expect, it } from 'vitest';
import { formatDoctorReport } from './index.js';

describe('tools/doctor', () => {
  it('formats capability matrix report clearly', () => {
    const text = formatDoctorReport({
      generatedAt: 1_792_731_653_000,
      nodeVersion: 'v24.13.1',
      platform: 'win32',
      collectorRunning: true,
      collectorUrl: 'http://127.0.0.1:4100',
      tailscaleUrl: 'https://deck.tailnet.ts.net',
      dbSizeBytes: 65536,
      adapters: [
        {
          source: 'opencode',
          status: 'connected',
          capabilities: {
            liveEvents: true,
            usagePrecision: 'exact',
            attention: true,
            subagents: true,
            notes: ['http://127.0.0.1:49374']
          }
        }
      ]
    });
    expect(text).toContain('AGENT DECK DOCTOR');
    expect(text).toContain('opencode');
    expect(text).toContain('exact');
  });
});
