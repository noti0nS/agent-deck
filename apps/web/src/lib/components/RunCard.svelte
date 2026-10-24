<script lang="ts">
  import type { AgentRun } from '@agent-deck/core';
  import {
    formatCost,
    formatElapsed,
    formatRelativeAgo,
    formatTokens,
    SOURCE_COLORS,
    STATUS_COLORS,
    STATUS_ICONS
  } from '$lib/format';

  interface Props {
    run: AgentRun;
    now: number;
    animatePulse: boolean;
    waitingEscalateSeconds: number;
    onSelect: (runId: string) => void;
  }

  let { run, now, animatePulse, waitingEscalateSeconds, onSelect }: Props = $props();

  const sourceColor = $derived(SOURCE_COLORS[run.source] ?? '#6BA6FF');
  const statusColor = $derived(STATUS_COLORS[run.status] ?? '#7A8496');
  const statusIcon = $derived(STATUS_ICONS[run.status] ?? '●');
  const costDisplay = $derived(formatCost(run.usage.costUsd, run.usage.costSource, run.usage.precision));

  const completedTodos = $derived(run.todos.filter((t) => t.status === 'completed').length);
  const totalTodos = $derived(run.todos.length);

  const waitingElapsedSec = $derived(
    run.attention ? Math.max(0, Math.floor((now - run.attention.requestedAt) / 1000)) : 0
  );
  const isEscalatedBreathe = $derived(waitingElapsedSec >= waitingEscalateSeconds);

  const ticks = $derived(run.activityTimeline ?? new Array(60).fill('none'));
</script>

<!-- Card is strictly read-only: tap opens Detail context; never mutates the agent (P5, §8.3, §8.4) -->
<button
  type="button"
  onclick={() => onSelect(run.id)}
  class="animate-card-enter group relative w-full min-h-[168px] text-left bg-[#14171C] border border-[#232830] rounded-sm p-3 transition-colors focus:outline-none focus:border-[#6BA6FF] active:bg-[#171B21] sm:min-h-[192px] sm:p-4"
  data-testid="run-card"
  data-run-id={run.id}
  data-run-status={run.status}
>
  <!-- 3px left status rail (§8.3) -->
  <div
    class="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-sm"
    style="background-color: {statusColor}; {run.confidence === 'inferred' ? 'background-image: repeating-linear-gradient(to bottom, transparent 0 3px, #14171C 3px 6px);' : ''}"
  ></div>

  {#if run.status === 'waiting' && run.attention}
    <!-- §8.4 "needs you" read-only card state -->
    <div class="pl-2 flex flex-col justify-between h-full gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span
            class="inline-flex items-center justify-center text-[#FFB020] font-bold {animatePulse ? (isEscalatedBreathe ? 'animate-breathe-waiting' : 'animate-pulse-waiting') : ''}"
            aria-hidden="true"
          >
            ⚠
          </span>
          <span class="w-[6px] h-[6px] rounded-full shrink-0" style="background-color: {sourceColor};"></span>
          <span class="chrome-label !text-[#E8EBF0] font-semibold truncate">
            {run.source} · {run.projectName}
          </span>
        </div>
        <span class="shrink-0 font-mono-tabular text-[12px] text-[#FFB020] sm:text-[13px]">
          waiting {formatElapsed(run.attention.requestedAt, now)}
        </span>
      </div>

      <div class="space-y-1.5">
        <p class="text-[15px] text-[#E8EBF0] font-medium">
          {run.attention.kind === 'permission'
            ? 'Wants to run a command or tool'
            : run.attention.kind === 'question'
              ? 'Waiting for your answer'
              : 'Needs your attention'}
        </p>
        <div class="bg-[#0B0D10] border border-[#FFB020]/50 rounded-sm px-3 py-2 font-mono-tabular text-[14px] text-[#E8EBF0] truncate">
          {run.attention.summary}
        </div>
        {#if run.projectPath}
          <p class="font-mono-tabular text-[13px] text-[#8A93A3] truncate">
            in {run.projectPath}
          </p>
        {/if}
      </div>

      <div class="pt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px] text-[#FFB020] sm:text-[13px]">
        <span>→ answer in the terminal · tap to see context</span>
        {#if run.confidence === 'inferred'}
          <span class="text-[#8A93A3] border border-dashed border-[#4A5160] px-1.5 py-0.5 rounded-sm">inferred</span>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Standard instrument card anatomy (§8.3) -->
    <div class="pl-2 flex flex-col justify-between h-full gap-2.5">
      <!-- Top row: source 6px dot + project + elapsed -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-[6px] h-[6px] rounded-full shrink-0" style="background-color: {sourceColor};"></span>
          <span class="chrome-label shrink-0">{run.source}</span>
          <span class="font-mono-tabular text-[14px] text-[#E8EBF0] truncate font-medium">
            {run.projectName}
          </span>
          {#if run.unread}
            <span class="px-1.5 py-0.5 text-[11px] uppercase tracking-wider bg-[#3DDC97]/15 text-[#3DDC97] border border-[#3DDC97]/40 rounded-sm">
              unread
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          {#if run.confidence === 'inferred'}
            <span
              title="Inferred from file mtime"
              class="w-2.5 h-2.5 rounded-full border border-dashed border-[#8A93A3]"
            ></span>
          {/if}
          <span class="font-mono-tabular text-[13px] text-[#8A93A3]">
            {formatElapsed(run.startedAt, now, run.endedAt)}
          </span>
          <span class="text-[#4A5160] text-[13px]" aria-hidden="true">⤢</span>
        </div>
      </div>

      <!-- Title (2 lines max) + optional goal subtitle -->
      <div>
        <h3 class="text-[16px] leading-snug text-[#E8EBF0] font-medium line-clamp-2">
          {run.title}
        </h3>
        {#if run.subtitle}
          <p class="text-[13px] text-[#8A93A3] truncate mt-0.5">{run.subtitle}</p>
        {/if}
      </div>

      <!-- Status + "Now" monospace box -->
      <div class="bg-[#0B0D10] border border-[#232830] rounded-sm px-3 py-2 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <!-- Status conveyed by icon + text + colour (§8.7 accessibility) -->
          <span
            class="inline-flex items-center gap-1 text-[13px] font-medium shrink-0 {animatePulse && run.status === 'running' ? 'animate-pulse-running' : ''}"
            style="color: {statusColor};"
          >
            <span aria-hidden="true">{statusIcon}</span>
            <span>{run.status}</span>
          </span>

          <span class="min-w-0 font-mono-tabular text-[13px] text-[#E8EBF0] truncate">
            {#if run.currentStep}
              <span class="text-[#8A93A3]">{run.currentStep.label}</span>
              <span class="ml-1.5">{run.currentStep.detail}</span>
            {:else if run.status === 'stalled'}
              <span class="text-[#7A8496]">quiet {formatRelativeAgo(run.lastActivityAt, now)}</span>
            {:else if run.status === 'detached'}
              <span class="text-[#7A8496]">lost contact</span>
            {:else if run.status === 'done'}
              <span class="text-[#8A93A3]">turn completed</span>
            {:else}
              <span class="text-[#8A93A3]">idle</span>
            {/if}
          </span>
        </div>

        {#if run.filesChanged && run.filesChanged.length > 0}
          {@const latestFile = run.filesChanged[0]}
          <span class="font-mono-tabular text-[12px] shrink-0 text-[#8A93A3]">
            <span class="text-[#3DDC97]">+{latestFile.additions}</span>
            <span class="text-[#FF5E5E] ml-1">−{latestFile.deletions}</span>
          </span>
        {/if}
      </div>

      <!-- 60-second micro-timeline (§8.3) -->
      <div class="flex items-end gap-[1px] h-4 pt-1 sm:gap-[2px]" aria-label="Last 60 seconds activity">
        {#each ticks as tick}
          <div
            class="flex-1 rounded-t-[1px]"
            style="
              height: {tick === 'tool' ? '14px' : tick === 'waiting' ? '12px' : tick === 'error' ? '14px' : tick === 'thinking' ? '8px' : '3px'};
              background-color: {tick === 'tool' ? '#3DDC97' : tick === 'waiting' ? '#FFB020' : tick === 'error' ? '#FF5E5E' : tick === 'thinking' ? '#8A93A3' : '#232830'};
            "
          ></div>
        {/each}
      </div>

      <!-- Footer numbers (tabular figures, honest cost precision) -->
      <div class="pt-1 border-t border-[#232830] flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[12px] text-[#8A93A3] font-mono-tabular sm:gap-x-3 sm:text-[13px]">
        <div class="flex items-center gap-2 truncate min-w-0">
          {#if totalTodos > 0}
            <span>{completedTodos}/{totalTodos} steps</span>
            <span>·</span>
          {/if}
          <span class="truncate text-[#E8EBF0]">{run.model}</span>
          {#if run.usage.precision !== 'none'}
            <span>·</span>
            <span>{formatTokens(run.usage.tokensIn)} in / {formatTokens(run.usage.tokensOut)} out</span>
          {/if}
        </div>

        <div class="flex items-center gap-2 shrink-0">
          {#if costDisplay !== null}
            <span class="text-[#E8EBF0]">{costDisplay}</span>
            <span>·</span>
          {/if}
          <span>{run.usage.turns} turns</span>
          <span>·</span>
          <span>{formatRelativeAgo(run.lastActivityAt, now)}</span>
        </div>
      </div>
    </div>
  {/if}
</button>
