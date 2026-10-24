<script lang="ts">
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatElapsed, formatTokens, SOURCE_COLORS, STATUS_COLORS, STATUS_ICONS } from '$lib/format';

  const runs = $derived(deckStore.sortedRuns.slice(0, 6));
  const agg = $derived(deckStore.state.aggregates);
</script>

<!-- Ambient View (§8.2): chrome-free, 2x type size. Bands collapse to two compact lines on phones. -->
<section
  class="min-h-[calc(100dvh-88px)] flex flex-col justify-between gap-4 py-3 sm:gap-6 sm:py-4 sm:cursor-none"
  data-testid="ambient-view"
>
  <!-- Aggregate Row -->
  <div class="bg-[#14171C] border border-[#232830] rounded-sm px-4 py-3 sm:px-6 sm:py-5">
    <div class="grid grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-6">
      <div>
        <div class="chrome-label">Today's Tokens</div>
        <div class="font-mono-tabular text-[28px] leading-none font-semibold text-[#E8EBF0] mt-1 sm:text-[42px]">
          {formatTokens(agg.todayTokensIn + agg.todayTokensOut)}
        </div>
      </div>

      <div>
        <div class="chrome-label">API-Equiv / Spend</div>
        <div class="font-mono-tabular text-[24px] leading-none font-medium text-[#E8EBF0] mt-1 sm:text-[36px]">
          {#if agg.hasExactCost}
            ${agg.todayCostExactUsd.toFixed(2)}
          {:else if agg.hasEstimatedCost}
            ${agg.todayCostEstimatedUsd.toFixed(2)} <span class="text-[18px] text-[#8A93A3]">est.</span>
          {:else}
            —
          {/if}
        </div>
      </div>

      <div>
        <div class="chrome-label">Active Sessions</div>
        <div class="font-mono-tabular text-[24px] leading-none font-medium text-[#3DDC97] mt-1 sm:text-[36px]">
          {agg.activeCount}
        </div>
      </div>

      {#if agg.waitingCount > 0}
        <div>
          <div class="chrome-label !text-[#FFB020]">Needs You</div>
          <div class="font-mono-tabular text-[20px] leading-none font-semibold text-[#FFB020] mt-1 sm:text-[36px]">
            ⚠ {agg.waitingCount} waiting
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Horizontal bands per agent (2x Deck type size) -->
  <div class="flex-1 flex flex-col gap-2 sm:gap-3">
    {#each runs as run, idx (run.id)}
      {@const sColor = SOURCE_COLORS[run.source] ?? '#6BA6FF'}
      {@const stColor = STATUS_COLORS[run.status] ?? '#7A8496'}
      {@const stIcon = STATUS_ICONS[run.status] ?? '●'}
      <button
        type="button"
        onclick={() => deckStore.setView('detail', run.id)}
        class="w-full text-left bg-[#14171C] border border-[#232830] rounded-sm px-3 py-2.5 flex flex-col gap-1.5 relative active:bg-[#171B21] sm:px-6 sm:py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
      >
        <div
          class="absolute left-0 top-0 bottom-0 w-[4px]"
          style="background-color: {stColor};"
        ></div>

        <div class="flex min-w-0 items-center gap-2 sm:shrink-0 sm:gap-4">
          <span
            class="w-2.5 h-2.5 rounded-full shrink-0 sm:w-3 sm:h-3 {idx < 2 && run.status === 'running' ? 'animate-pulse-running' : ''}"
            style="background-color: {sColor};"
          ></span>
          <span class="font-mono-tabular text-[17px] font-semibold text-[#E8EBF0] truncate sm:text-[24px] sm:shrink-0">
            {run.projectName}
          </span>
          <span class="text-[13px] shrink-0 sm:text-[20px]" style="color: {stColor};">
            {stIcon} {run.status}
          </span>
        </div>

        <div class="flex w-full min-w-0 items-center justify-between gap-3 font-mono-tabular text-[13px] sm:w-auto sm:flex-1 sm:justify-end sm:gap-6 sm:text-[22px]">
          <span class="min-w-0 truncate text-[#8A93A3]">
            {#if run.status === 'waiting' && run.attention}
              <span class="text-[#FFB020]">{run.attention.summary}</span>
            {:else if run.currentStep}
              {run.currentStep.label} {run.currentStep.detail}
            {:else}
              {run.title}
            {/if}
          </span>

          <div class="flex shrink-0 items-center gap-2 sm:gap-6">
            {#if run.confidence === 'inferred'}
              <span
                class="px-2 py-0.5 text-[11px] border border-dashed border-[#8A93A3] text-[#8A93A3] rounded-sm sm:text-[14px]"
                title="Inferred state"
              >
                ····
              </span>
            {/if}
            <span class="text-[#8A93A3]">{formatElapsed(run.startedAt, deckStore.now, run.endedAt)}</span>
            <span class="text-[#E8EBF0] w-16 text-right sm:w-24">
              {formatTokens(run.usage.tokensIn + run.usage.tokensOut)}
            </span>
          </div>
        </div>
      </button>
    {/each}
  </div>
</section>
