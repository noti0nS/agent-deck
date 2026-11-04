<script lang="ts">
  import type { AgentRun } from '@agent-deck/core';
  import { formatCost, formatElapsed, formatRelativeAgo, formatTokens, STATUS_COLORS } from '#lib/format.js';
  let { run, now, onSelect }: { run: AgentRun; now: number; animatePulse: boolean; waitingEscalateSeconds: number; onSelect: (id: string) => void } = $props();
  const names = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', pty: 'Terminal Agent' };
  const status = $derived(run.status === 'waiting' ? 'Waiting for input' : run.status === 'detached' ? 'No activity signal' : run.status);
  const color = $derived(STATUS_COLORS[run.status]);
  const cost = $derived(formatCost(run.usage.costUsd, run.usage.costSource, run.usage.precision));
  const completed = $derived(run.todos.filter(t => t.status === 'completed').length);
  const message = $derived(run.recentMessages?.[0]);
</script>
<button type="button" class="session-card" style="--rail: {color}" onclick={() => onSelect(run.id)} data-testid="run-card" data-run-id={run.id} data-run-status={run.status}>
  <div class="monitor-channel"><span>{names[run.source]}</span><span class="monitor-signal" style="color: {color}"><i></i>{run.confidence}</span></div>
  <div class="session-heading"><h3>{run.projectName}</h3><span class="session-status" style="color: {color}">{status}</span></div>
  <p class="session-descriptor">{run.title}</p>
  <div class="session-command">
    <div class="session-command-label">{run.status === 'waiting' && run.attention ? 'Attention required' : message ? 'Latest message' : run.currentStep ? 'Current activity' : 'Latest message'}</div>
    <p>{(run.status === 'waiting' ? run.attention?.summary : undefined) ?? message?.preview ?? (run.currentStep ? `${run.currentStep.label}${run.currentStep.detail ? ` · ${run.currentStep.detail}` : ''}` : undefined) ?? run.subtitle ?? 'No message available'}</p>
  </div>
  {#if run.attention}
    <p class="session-directive"><span aria-hidden="true">↗</span> Please answer in the terminal · tap to see context</p>
  {:else if run.todos.length}
    <div class="session-progress"><div><span>Task progress</span><span>{completed} / {run.todos.length}</span></div><progress value={completed} max={run.todos.length} aria-label="Completed tasks"></progress></div>
  {:else}
    <p class="session-note">{run.confidence} · last activity {formatRelativeAgo(run.lastActivityAt, now)}</p>
  {/if}
  <div class="monitor-readings">
    <div><span>{run.attention ? 'Waiting' : 'Duration'}</span><strong>{formatElapsed(run.attention?.requestedAt ?? run.startedAt, now, run.endedAt ?? (['idle', 'done', 'detached'].includes(run.status) ? run.lastActivityAt : undefined))}</strong></div>
    <div><span>Tokens</span><strong>{formatTokens(run.usage.tokensIn + run.usage.tokensOut)}</strong></div>
    <div><span>Cost</span><strong>{cost || '—'}</strong></div>
  </div>
  <div class="monitor-model"><span>{run.model || 'Model unavailable'}</span><span>{run.unread ? 'Unread' : 'Open session ↗'}</span></div>
</button>
