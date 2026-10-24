import type { AdapterHealth, Capabilities, Source } from '@agent-deck/core';

export interface DoctorSourceReport {
  source: Source;
  status: 'connected' | 'degraded' | 'off';
  capabilities: Capabilities;
  lastSeenAt?: number;
  lastError?: string;
  lagMs?: number;
}

export interface DoctorSystemReport {
  generatedAt: number;
  nodeVersion: string;
  platform: string;
  collectorRunning: boolean;
  collectorUrl: string;
  tailscaleUrl?: string;
  dbSizeBytes: number;
  adapters: DoctorSourceReport[];
}

export function formatDoctorReport(report: DoctorSystemReport): string {
  const lines: string[] = [];
  lines.push('=== AGENT DECK DOCTOR ===');
  lines.push(`Time:       ${new Date(report.generatedAt).toISOString()}`);
  lines.push(`Runtime:    Node ${report.nodeVersion} (${report.platform})`);
  lines.push(`Collector:  ${report.collectorRunning ? 'ONLINE' : 'OFFLINE'} (${report.collectorUrl})`);
  if (report.tailscaleUrl) {
    lines.push(`Tailscale:  ${report.tailscaleUrl} (HTTPS secure context)`);
  }
  lines.push(`Storage:    ${(report.dbSizeBytes / 1024).toFixed(1)} KB`);
  lines.push('');
  lines.push('SOURCE     STATUS      LIVE   USAGE      ATTENTION  SUBAGENTS  NOTES');
  lines.push('---------  ----------  -----  ---------  ---------  ---------  -----');

  for (const a of report.adapters) {
    const src = a.source.padEnd(9);
    const st = a.status.padEnd(10);
    const live = (a.capabilities.liveEvents ? 'yes' : 'no').padEnd(5);
    const usage = a.capabilities.usagePrecision.padEnd(9);
    const attn = (a.capabilities.attention ? 'yes' : 'no').padEnd(9);
    const sub = (a.capabilities.subagents ? 'yes' : 'no').padEnd(9);
    const notes = [...a.capabilities.notes, a.lastError ? `ERR: ${a.lastError}` : '']
      .filter(Boolean)
      .join('; ');
    lines.push(`${src}  ${st}  ${live}  ${usage}  ${attn}  ${sub}  ${notes}`);
  }

  return lines.join('\n');
}

export function adapterHealthToDoctor(health: AdapterHealth): DoctorSourceReport {
  return {
    source: health.source,
    status: health.status,
    capabilities: health.capabilities,
    lastSeenAt: health.lastSeenAt,
    lastError: health.lastError,
    lagMs: health.lagMs
  };
}
