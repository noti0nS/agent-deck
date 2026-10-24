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
  class="animate-card-enter bezel-specular group relative w-full min-h-[184px] text-left rounded p-3.5 transition-all hover:border-[#2E3545] focus:outline-none focus:border-[#6BA6FF] active:bg-[#171B24] sm:min-h-[208px] sm:p-4 overflow-hidden {run.status === 'waiting' ? '!border-[#FFB020]/45 bg-[linear-gradient(135deg,rgba(255,176,32,0.05)_0%,rgba(18,21,28,0.98)_55%)]' : ''}"
  data-testid="run-card"
  data-run-id={run.id}
  data-run-status={run.status}
>
  <!-- 3px left status rail (§8.3) -->
  <div
    class="absolute left-0 top-0 bottom-0 w-[3px]"
    style="background-color: {statusColor}; {run.confidence === 'inferred' ? 'background-image: repeating-linear-gradient(to bottom, transparent 0 3px, #12151C 3px 6px);' : ''}"
  ></div>

  {#if run.status === 'waiting' && run.attention}
    <!-- §8.4 "needs you" read-only card state (OpenCode terminal alert well) -->
    <div class="pl-2 flex flex-col justify-between h-full gap-3">
      <!-- Header -->
      <div class="flex items-center justify-between gap-2 pb-2 border-b border-[#212631]/80">
        <div class="flex min-w-0 items-center gap-2">
          <span
            class="inline-flex items-center justify-center text-[#FFB020] font-bold {animatePulse ? (isEscalatedBreathe ? 'animate-breathe-waiting' : 'animate-pulse-waiting') : ''}"
            aria-hidden="true"
          >
            ⚠
          </span>
          <span class="w-[7px] h-[7px] rounded-full shrink-0" style="background-color: {sourceColor};"></span>
          <span class="chrome-label !text-[#ECEDF2] truncate">
            {run.source} · {run.projectName}
          </span>
        </div>
        <span class="shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-[#FFB020]/10 border border-[#FFB020]/40 font-mono-tabular text-[11px] font-semibold text-[#FFB020] tracking-wide">
          <span class="w-1.5 h-1.5 rounded-full bg-[#FFB020]"></span>
          waiting {formatElapsed(run.attention.requestedAt, now)}
        </span>
      </div>

      <!-- Prompt + Recessed Terminal Well -->
      <div class="space-y-2">
        <p class="text-[15px] sm:text-[16px] text-[#ECEDF2] font-semibold tracking-tight">
          {run.attention.kind === 'permission'
            ? 'Wants to run a command or tool'
            : run.attention.kind === 'question'
              ? 'Waiting for your answer'
              : 'Needs your attention'}
        </p>
        <div class="well-recessed !border-[#FFB020]/45 rounded px-3 py-2.5 font-mono-tabular space-y-1">
          <div class="flex items-center gap-2 text-[13px] sm:text-[14px] text-[#ECEDF2] truncate">
            <span class="text-[#FFB020] font-semibold select-none">$</span>
            <span class="truncate font-medium">{run.attention.summary}</span>
          </div>
          {#if run.projectPath}
            <p class="text-[11px] sm:text-[12px] text-[#8B93A6] truncate">
              in <span class="text-[#ECEDF2]/80">{run.projectPath}</span>
            </p>
          {/if}
        </div>
      </div>

      <!-- Read-only footer instruction -->
      <div class="pt-2 border-t border-[#212631]/80 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 font-mono-tabular text-[11px] sm:text-[12px] text-[#FFB020]">
        <span>→ answer in the terminal · tap to see context</span>
        {#if run.confidence === 'inferred'}
          <span class="text-[#8B93A6] border border-dashed border-[#4C5365] px-1.5 py-0.5 rounded-sm uppercase text-[10px]">inferred</span>
        {:else}
          <span class="chrome-label !text-[10px] !text-[#8B93A6] hidden sm:inline">READ-ONLY</span>
        {/if}
      </div>
    </div>
  {:else}
    <!-- Standard OpenCode instrument card anatomy (§8.3) -->
    <div class="pl-2 flex flex-col justify-between h-full gap-2.5">
      <!-- Top row: source dot + source tag + project + status/elapsed -->
      <div class="flex items-center justify-between gap-2 pb-2 border-b border-[#212631]/70">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-[7px] h-[7px] rounded-full shrink-0" style="background-color: {sourceColor};"></span>
          <span class="chrome-label shrink-0">{run.source}</span>
          <span class="text-[#4C5365] text-[11px] shrink-0">·</span>
          <span class="font-mono-tabular text-[13px] sm:text-[14px] text-[#ECEDF2] truncate font-semibold">
            {run.projectName}
          </span>
          {#if run.unread}
            <span class="px-1.5 py-0.5 font-mono-tabular text-[10px] font-semibold uppercase tracking-wider bg-[#3DDC97]/15 text-[#3DDC97] border border-[#3DDC97]/40 rounded-sm shrink-0">
              unread
            </span>
          {/if}
        </div>
        <div class="flex items-center gap-2 shrink-0">
          {#if run.confidence === 'inferred'}
            <span
              title="Inferred from file mtime"
              class="px-1.5 py-0.5 rounded-sm border border-dashed border-[#8B93A6]/60 font-mono-tabular text-[10px] uppercase tracking-wider text-[#8B93A6]"
            >inferred</span>
          {/if}
          <span class="font-mono-tabular text-[12px] text-[#8B93A6]">
            {formatElapsed(run.startedAt, now, run.endedAt)}
          </span>
          <span class="text-[#4C5365] group-hover:text-[#8B93A6] transition-colors text-[12px]" aria-hidden="true">⤢</span>
        </div>
      </div>

      <!-- Title (2 lines max) + optional goal subtitle -->
      <div>
        <h3 class="text-[15px] sm:text-[16px] leading-snug text-[#ECEDF2] font-semibold tracking-tight line-clamp-2">
          {run.title}
        </h3>
        {#if run.subtitle}
          <p class="text-[12px] sm:text-[13px] text-[#8B93A6] truncate mt-0.5">{run.subtitle}</p>
        {/if}
      </div>

      <!-- Recessed Terminal "Now" Monospace Well -->
      <div class="well-recessed rounded px-2.5 py-2 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <!-- Status conveyed by icon + text + colour (§8.7 accessibility) -->
          <span
            class="inline-flex items-center gap-1 font-mono-tabular text-[12px] font-semibold shrink-0 {animatePulse && run.status === 'running' ? 'animate-pulse-running' : ''}"
            style="color: {statusColor};"
          >
            <span aria-hidden="true">{statusIcon}</span>
            <span>{run.status}</span>
          </span>

          <span class="text-[#2E3545] select-none">|</span>

          <span class="min-w-0 font-mono-tabular text-[12px] sm:text-[13px] text-[#ECEDF2] truncate">
            {#if run.currentStep}
              <span class="px-1.5 py-0.5 rounded-sm bg-[#171B24] border border-[#2E3545] text-[#6BA6FF] text-[11px] font-medium">{run.currentStep.label}</span>
              <span class="ml-1.5 text-[#ECEDF2]">{run.currentStep.detail}</span>
            {:else if run.status === 'stalled'}
              <span class="text-[#7A8496]">quiet {formatRelativeAgo(run.lastActivityAt, now)}</span>
            {:else if run.status === 'detached'}
              <span class="text-[#7A8496]">lost contact</span>
            {:else if run.status === 'done'}
              <span class="text-[#8B93A6]">turn completed</span>
            {:else}
              <span class="text-[#8B93A6]">idle</span>
            {/if}
          </span>
        </div>

        {#if run.filesChanged && run.filesChanged.length > 0}
          {@const latestFile = run.filesChanged[0]}
          <span class="font-mono-tabular text-[11px] shrink-0 px-1.5 py-0.5 rounded-sm bg-[#12151C] border border-[#212631]">
            <span class="text-[#3DDC97] font-semibold">+{latestFile.additions}</span>
            <span class="text-[#FF5E5E] font-semibold ml-1">−{latestFile.deletions}</span>
          </span>
        {/if}
      </div>

      <!-- 60-second micro-timeline inside recessed track (§8.3) -->
      <div class="space-y-1">
        <div class="well-recessed rounded-sm px-1.5 py-1 flex items-end gap-[1px] h-5 sm:gap-[2px]" aria-label="Last 60 seconds activity">
          {#each ticks as tick}
            <div
              class="flex-1 rounded-t-[1px]"
              style="
                height: {tick === 'tool' ? '13px' : tick === 'waiting' ? '11px' : tick === 'error' ? '13px' : tick === 'thinking' ? '7px' : '3px'};
                background-color: {tick === 'tool' ? '#3DDC97' : tick === 'waiting' ? '#FFB020' : tick === 'error' ? '#FF5E5E' : tick === 'thinking' ? '#8B93A6' : '#212631'};
              "
            ></div>
          {/each}
        </div>
      </div>

      <!-- Footer numbers (tabular figures, honest cost precision) -->
      <div class="pt-1.5 border-t border-[#212631]/80 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] sm:text-[12px] text-[#8B93A6] font-mono-tabular">
        <div class="flex items-center gap-1.5 truncate min-w-0">
          {#if totalTodos > 0}
            <span class="text-[#ECEDF2] font-medium">{completedTodos}/{totalTodos} steps</span>
            <span class="text-[#4C5365]">·</span>
          {/if}
          <span class="truncate text-[#ECEDF2]/90">{run.model}</span>
          {#if run.usage.precision !== 'none'}
            <span class="text-[#4C5365]">·</span>
            <span>{formatTokens(run.usage.tokensIn)} in / {formatTokens(run.usage.tokensOut)} out</span>
          {/if}
        </div>

        <div class="flex items-center gap-1.5 shrink-0">
          {#if costDisplay !== null}
            <span class="text-[#ECEDF2] font-semibold">{costDisplay}</span>
            <span class="text-[#4C5365]">·</span>
          {/if}
          <span>{run.usage.turns} turns</span>
          <span class="text-[#4C5365]">·</span>
          <span>{formatRelativeAgo(run.lastActivityAt, now)}</span>
        </div>
      </div>
    </div>
  {/if}
</button>
