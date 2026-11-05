import { describe, expect, it } from 'vitest';
import { formatDoctorReport, type DoctorSystemReport } from './index.js';

describe('tools/doctor', () => {
  const offline: DoctorSystemReport = {
    generatedAt: 0, nodeVersion: 'v24.0.0', platform: 'win32',
    collectorRunning: false, collectorUrl: 'http://127.0.0.1:4100', dbSizeBytes: 0,
    adapters: ['claude', 'codex'].map(source => ({
      source: source as 'claude' | 'codex', status: 'off',
      capabilities: { liveEvents: false, usagePrecision: 'none', attention: false, subagents: false, notes: [] }
    }))
  };

  it('suggests repairs only for enabled providers and explains offline state', () => {
    const text = formatDoctorReport({ ...offline, enabledProviders: ['claude'], hookAvailable: false });
    expect(text).toContain('agent-deck setup claude');
    expect(text).toContain('agent-deck probe --source claude');
    expect(text).not.toContain('agent-deck probe --source codex');
    expect(text).toContain('npm run build:hooks');
    expect(text).toContain('agent-deck start');
    expect(text).toContain('not active collector connections');
  });

  it('distinguishes missing setup from an intentionally empty provider selection', () => {
    expect(formatDoctorReport(offline)).toContain('Choose providers: agent-deck setup');
    const text = formatDoctorReport({ ...offline, enabledProviders: [] });
    expect(text).toContain('None selected (PTY only)');
    expect(text).not.toContain('Choose providers:');
  });

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
