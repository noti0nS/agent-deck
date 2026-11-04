<script lang="ts">
  import type { AgentRun } from '@agent-deck/core';
  import { formatCost, formatElapsed, formatRelativeAgo, formatTokens, STATUS_COLORS } from '$lib/format';
  let { run, now, onSelect }: { run: AgentRun; now: number; animatePulse: boolean; waitingEscalateSeconds: number; onSelect: (id: string) => void } = $props();
  const names = { opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', pty: 'Terminal Agent' };
  const status = $derived(run.status === 'waiting' ? 'Waiting for input' : run.status === 'detached' ? 'No activity signal' : run.status);
  const color = $derived(STATUS_COLORS[run.status]);
  const cost = $derived(formatCost(run.usage.costUsd, run.usage.costSource, run.usage.precision));
  const completed = $derived(run.todos.filter(t => t.status === 'completed').length);
  const message = $derived(run.recentMessages?.[0]);
</script>
<button type="button" class="session-card" style="--rail: {color}" onclick={() => onSelect(run.id)} data-testid="run-card" data-run-id={run.id} data-run-status={run.status}>
  <div class="session-heading"><h3>{run.projectName}</h3><span class="session-status" style="color: {color}">{status}</span></div>
  <p class="session-descriptor">Tool: <span>{names[run.source]}</span> · {run.title}</p>
  <div class="session-command">
    <div class="session-command-label">{run.status === 'waiting' && run.attention ? 'Attention required' : 'Latest message'}</div>
    <p>{(run.status === 'waiting' ? run.attention?.summary : undefined) ?? message?.preview ?? run.subtitle ?? 'No message available'}</p>
  </div>
  {#if run.attention}
    <p class="session-directive"><span aria-hidden="true">↗</span> Please answer in the terminal · tap to see context</p>
  {:else if run.todos.length}
    <div class="session-progress"><div><span>Task progress</span><span>{completed} / {run.todos.length}</span></div><progress value={completed} max={run.todos.length} aria-label="Completed tasks"></progress></div>
  {:else}
    <p class="session-note">{run.confidence} · last activity {formatRelativeAgo(run.lastActivityAt, now)}</p>
  {/if}
  <div class="session-footer"><span>{run.attention ? 'Waiting' : 'Duration'}: {formatElapsed(run.attention?.requestedAt ?? run.startedAt, now, run.endedAt ?? (['idle', 'done', 'detached'].includes(run.status) ? run.lastActivityAt : undefined))}</span><span>{formatTokens(run.usage.tokensIn + run.usage.tokensOut)} tok{cost ? ` · ${cost}` : ''}</span></div>
  <div class="session-model">{run.model}{run.unread ? ' · unread' : ''}</div>
</button>
