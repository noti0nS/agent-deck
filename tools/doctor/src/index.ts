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
  dbPath?: string;
  enabledProviders?: Source[];
  setupError?: string;
  webAvailable?: boolean;
  hookAvailable?: boolean;
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
  if (report.dbPath) lines.push(`Database:   ${report.dbPath}`);
  lines.push(`Providers:  ${report.setupError ? 'Invalid setup' : report.enabledProviders === undefined ? 'Not configured' : report.enabledProviders.join(', ') || 'None selected (PTY only)'}`);
  if (!report.tailscaleUrl) lines.push('Tailscale:  Not detected (optional; local access still works)');
  if (report.webAvailable !== undefined) lines.push(`Web UI:     ${report.webAvailable ? 'Build found' : 'Build missing'}`);
  if (report.hookAvailable !== undefined) lines.push(`Hook shim:  ${report.hookAvailable ? 'Found' : 'Missing (needed for Claude / Antigravity hooks)'}`);
  lines.push('', 'Provider checks', 'Local detection and capabilities, not active collector connections.');
  lines.push('Disabled providers are informational; PTY is an on-demand fallback.', '');
  lines.push('SOURCE     ENABLED    DETECTION   LIVE   USAGE      ATTENTION  SUBAGENTS');
  lines.push('---------  ---------  ----------  -----  ---------  ---------  ---------');

  for (const a of report.adapters) {
    const src = a.source.padEnd(9);
    const st = (a.status === 'connected' ? 'available' : a.status === 'off' ? 'not found' : 'degraded').padEnd(10);
    const enabled = (a.source === 'pty' ? 'on-demand' : report.enabledProviders === undefined ? 'unset' : report.enabledProviders.includes(a.source) ? 'yes' : 'no').padEnd(9);
    const live = (a.capabilities.liveEvents ? 'yes' : 'no').padEnd(5);
    const usage = a.capabilities.usagePrecision.padEnd(9);
    const attn = (a.capabilities.attention ? 'yes' : 'no').padEnd(9);
    const sub = (a.capabilities.subagents ? 'yes' : 'no').padEnd(9);
    const notes = [...a.capabilities.notes, a.lastError ? `ERR: ${a.lastError}` : '']
      .filter(Boolean)
      .join('; ');
    lines.push(`${src}  ${enabled}  ${st}  ${live}  ${usage}  ${attn}  ${sub}`);
    if (notes) lines.push(`  ${notes}`);
  }

  const steps: string[] = [];
  if (report.setupError || report.enabledProviders === undefined) {
    if (report.setupError) steps.push(report.setupError);
    steps.push('Choose providers: agent-deck setup');
  }
  if (report.webAvailable === false) steps.push('Restore the web UI: reinstall agent-deck, or run npm run build in a source checkout.');
  if (report.hookAvailable === false && report.enabledProviders?.some(source => source === 'claude' || source === 'agy')) {
    steps.push('Restore the hook shim: reinstall agent-deck, or run npm run build:hooks in a source checkout.');
  }
  for (const adapter of report.adapters) {
    if (adapter.status !== 'connected' && report.enabledProviders?.includes(adapter.source)) {
      steps.push(`Inspect ${adapter.source}: agent-deck probe --source ${adapter.source}`);
      if (adapter.source === 'claude' || adapter.source === 'agy') steps.push(`Repair ${adapter.source} observer hooks if needed: agent-deck setup ${adapter.source}`);
    }
  }
  if (!report.collectorRunning) steps.push('Start the collector in a separate terminal and keep it open: agent-deck start');
  lines.push('', 'Next steps');
  if (steps.length) steps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  else lines.push('  No setup issues detected. Open the collector URL, or run agent-deck pair for a tablet.');
  lines.push('', 'Missing sessions? Run agent-deck probe --source <provider> --tail 10.', 'More options: agent-deck help doctor');
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
