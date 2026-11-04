<script lang="ts">
  import { onMount } from 'svelte';
  import { deckStore } from '$lib/stores/deck.svelte';
  import { formatTokens, SOURCE_COLORS } from '$lib/format';
  import type { AgentRun } from '@agent-deck/core';

  let range = $state<'today' | 'week'>('today');
  let summary = $state<{
    tokensIn: number;
    tokensOut: number;
    exactCostUsd: number;
    estimatedCostUsd: number;
    hasExactCost: boolean;
    hasEstimatedCost: boolean;
    runs: number;
    turns: number;
    toolCalls: number;
    activeMs: number;
    recentAvgDailyTokens: number;
    trendVsAvgPct: number;
    burnRateTokensPerMin: number;
    burnRateUsdPerMin: number;
    burnRateAlarm: boolean;
  } | null>(null);

  let timeseries = $state<Array<{ bucketTs: number; tokensIn: number; tokensOut: number; costUsd: number }>>([]);
  let byProject = $state<Array<{ key: string; tokensIn: number; tokensOut: number; exactCostUsd: number; estimatedCostUsd: number; precision: string }>>([]);
  let byModel = $state<Array<{ key: string; tokensIn: number; tokensOut: number; exactCostUsd: number; estimatedCostUsd: number; precision: string; runs: number; turns: number }>>([]);
  let unproductiveRuns = $state<AgentRun[]>([]);

  const visibleUnproductiveRuns = $derived(unproductiveRuns.filter(r => deckStore.visibleSources.includes(r.source)));

  async function loadUsage() {
    const now = Date.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const from = range === 'today' ? startOfToday.getTime() : now - 7 * 86_400_000;

    try {
      const [sumRes, tsRes, projRes, modRes, unprodRes] = await Promise.all([
        fetch(`/api/usage/summary?from=${from}&to=${now}`),
        fetch(`/api/usage/timeseries?from=${now - 7 * 86_400_000}&to=${now}&bucket=1h`),
        fetch(`/api/usage/breakdown?by=project&from=${from}&to=${now}`),
        fetch(`/api/usage/breakdown?by=model&from=${from}&to=${now}`),
        fetch(`/api/usage/runs?sortBy=unproductive&limit=5&from=${from}&to=${now}`)
      ]);

      if (sumRes.ok) summary = await sumRes.json();
      if (tsRes.ok) {
        const d = await tsRes.json();
        timeseries = d.series ?? [];
      }
      if (projRes.ok) {
        const d = await projRes.json();
        byProject = d.rows ?? [];
      }
      if (modRes.ok) {
        const d = await modRes.json();
        byModel = d.rows ?? [];
      }
      if (unprodRes.ok) {
        const d = await unprodRes.json();
        unproductiveRuns = d.runs ?? [];
      }
    } catch {
      // ignore
    }
  }

  onMount(() => {
    loadUsage();
  });

  function switchRange(next: 'today' | 'week') {
    range = next;
    loadUsage();
  }

  // Hand-drawn 2px SVG sparkline (§8.2, §8.5)
  const sparklinePath = $derived.by(() => {
    if (timeseries.length === 0) return 'M 0 60 L 600 60';
    const maxTok = Math.max(1, ...timeseries.map((b) => b.tokensIn + b.tokensOut));
    const pts = timeseries.map((b, i) => {
      const x = timeseries.length === 1 ? 300 : (i / (timeseries.length - 1)) * 600;
      const y = 64 - ((b.tokensIn + b.tokensOut) / maxTok) * 56;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M ${pts.join(' L ')}`;
  });

  const sparklineAreaPath = $derived.by(() => {
    if (timeseries.length === 0) return 'M 0 68 L 600 68 Z';
    return `${sparklinePath} L 600 68 L 0 68 Z`;
  });

  const maxProjectTokens = $derived(
    Math.max(1, ...byProject.map((p) => p.tokensIn + p.tokensOut))
  );

  // Mark the newest sample so a single-bucket window still shows something.
  const sparklineLast = $derived.by(() => {
    if (timeseries.length === 0) return null;
    const maxTok = Math.max(1, ...timeseries.map((b) => b.tokensIn + b.tokensOut));
    const i = timeseries.length - 1;
    const b = timeseries[i];
    const x = timeseries.length === 1 ? 300 : (i / (timeseries.length - 1)) * 600;
    const y = 64 - ((b.tokensIn + b.tokensOut) / maxTok) * 56;
    return { x, y };
  });
</script>

<section class="flex flex-col gap-3.5 sm:gap-4" data-testid="usage-view">
  <!-- Header + Today / Week Segmented Switcher & Hero KPI Matrix -->
  <div class="bezel-specular rounded p-3.5 sm:p-4 flex flex-wrap items-center justify-between gap-3 sm:gap-4">
    <div class="well-recessed p-1 rounded flex items-center gap-1">
      <button
        type="button"
        onclick={() => switchRange('today')}
        class="min-h-[44px] px-3.5 rounded-sm font-mono-tabular font-semibold text-[12px] uppercase tracking-wider transition-colors sm:px-4 {range === 'today' ? 'bg-[#171B24] border border-[#6BA6FF]/70 text-[#ECEDF2]' : 'border border-transparent text-[#8B93A6] hover:text-[#ECEDF2]'}"
      >
        Today
      </button>
      <button
        type="button"
        onclick={() => switchRange('week')}
        class="min-h-[44px] px-3.5 rounded-sm font-mono-tabular font-semibold text-[12px] uppercase tracking-wider transition-colors sm:px-4 {range === 'week' ? 'bg-[#171B24] border border-[#6BA6FF]/70 text-[#ECEDF2]' : 'border border-transparent text-[#8B93A6] hover:text-[#ECEDF2]'}"
      >
        Last 7 Days
      </button>
    </div>

    <div class="grid w-full grid-cols-2 gap-x-3 gap-y-3 font-mono-tabular sm:flex sm:w-auto sm:items-center sm:gap-6">
      <div>
        <div class="chrome-label">Tokens ({range})</div>
        <div class="text-[22px] font-bold text-[#ECEDF2] sm:text-[26px]">
          {formatTokens((summary?.tokensIn ?? 0) + (summary?.tokensOut ?? 0))}
          {#if summary && summary.trendVsAvgPct !== 0}
            <span class="mt-0.5 block text-[11px] sm:mt-0 sm:ml-1.5 sm:inline sm:text-[12px] px-1.5 py-0.5 rounded-sm border {summary.trendVsAvgPct > 0 ? 'bg-[#FFB020]/10 border-[#FFB020]/40 text-[#FFB020]' : 'bg-[#3DDC97]/10 border-[#3DDC97]/40 text-[#3DDC97]'}">
              {summary.trendVsAvgPct > 0 ? `+${summary.trendVsAvgPct}%` : `${summary.trendVsAvgPct}%`} vs 7d avg
            </span>
          {/if}
        </div>
      </div>

      <div>
        <div class="chrome-label">Actual Spend</div>
        <div class="text-[22px] font-bold text-[#ECEDF2] sm:text-[26px]">
          {summary?.hasExactCost ? `$${summary.exactCostUsd.toFixed(2)}` : '—'}
        </div>
      </div>

      <div>
        <div class="chrome-label">API-Equiv (est. API-rate)</div>
        <div class="text-[22px] font-bold text-[#8B93A6] sm:text-[26px]">
          {summary?.hasEstimatedCost ? `$${summary.estimatedCostUsd.toFixed(2)} est.` : '—'}
        </div>
      </div>

      <div>
        <div class="chrome-label">Live Burn Rate</div>
        <div class="text-[20px] font-bold sm:text-[24px] {summary?.burnRateAlarm ? 'text-[#FF5E5E]' : 'text-[#3DDC97]'}">
          ${(summary?.burnRateUsdPerMin ?? 0).toFixed(3)}/min
        </div>
      </div>
    </div>
  </div>

  <!-- 7-day tokens/hour hand-drawn SVG sparkline inside recessed well (§8.2, §8.5) -->
  <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-2.5">
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <span class="chrome-label">Tokens / Hour (7-Day Sparkline)</span>
      <span class="font-mono-tabular text-[11px] text-[#8B93A6] sm:text-[12px]">
        {timeseries.length} hourly {timeseries.length === 1 ? 'bucket' : 'buckets'}
      </span>
    </div>
    <div class="well-recessed rounded p-2.5 sm:p-3">
      <svg viewBox="0 0 600 70" class="w-full h-16 overflow-visible sm:h-24" role="img" aria-label="Tokens per hour sparkline">
        <defs>
          <linearGradient id="sparkline-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#3DDC97" stop-opacity="0.22" />
            <stop offset="100%" stop-color="#3DDC97" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        <line x1="0" y1="20" x2="600" y2="20" stroke="#212631" stroke-dasharray="3 3" stroke-width="1" />
        <line x1="0" y1="44" x2="600" y2="44" stroke="#212631" stroke-dasharray="3 3" stroke-width="1" />
        <path d={sparklineAreaPath} fill="url(#sparkline-grad)" />
        <path d={sparklinePath} fill="none" stroke="#3DDC97" stroke-width="2" stroke-linecap="round" />
        {#if sparklineLast}
          <circle cx={sparklineLast.x} cy={sparklineLast.y} r="3.5" fill="#3DDC97" />
        {/if}
      </svg>
    </div>
  </div>

  <!-- Two columns: Stacked Bars by Project + Compact Table by Model -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-3.5 sm:gap-4">
    <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="chrome-label">Usage by Project</span>
        <div class="flex items-center gap-3 font-mono-tabular text-[11px] text-[#8B93A6]">
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-[1px] bg-[#6BA6FF]"></span>In</span>
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-[1px] bg-[#3DDC97]"></span>Out</span>
        </div>
      </div>
      {#if byProject.length === 0}
        <p class="text-[13px] text-[#8B93A6] font-mono-tabular">No project samples in window.</p>
      {:else}
        {#each byProject as proj}
          {@const total = proj.tokensIn + proj.tokensOut}
          {@const inPct = Math.round((proj.tokensIn / maxProjectTokens) * 100)}
          {@const outPct = Math.round((proj.tokensOut / maxProjectTokens) * 100)}
          <div class="space-y-1.5">
            <div class="flex items-center justify-between text-[13px] font-mono-tabular">
              <span class="text-[#ECEDF2] font-semibold truncate">{proj.key}</span>
              <span class="text-[#8B93A6]">
                <span class="text-[#ECEDF2]">{formatTokens(total)}</span> tok
                {#if proj.exactCostUsd > 0}
                  · ${proj.exactCostUsd.toFixed(2)}
                {:else if proj.estimatedCostUsd > 0}
                  · ${proj.estimatedCostUsd.toFixed(2)} est.
                {/if}
              </span>
            </div>
            <!-- 3px rounded stacked bar inside recessed track (§8.5) -->
            <div class="w-full h-2.5 well-recessed rounded-[3px] flex overflow-hidden">
              <div class="bg-[#6BA6FF] h-full" style="width: {inPct}%"></div>
              <div class="bg-[#3DDC97] h-full" style="width: {outPct}%"></div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span class="chrome-label">Usage by Model</span>
        <span class="well-recessed px-2 py-0.5 rounded-sm font-mono-tabular text-[11px] text-[#8B93A6]">
          Price table v{deckStore.pricingInfo.version} ({deckStore.pricingInfo.updatedAt})
        </span>
      </div>
      {#if byModel.length === 0}
        <p class="text-[13px] text-[#8B93A6] font-mono-tabular">No model samples in window.</p>
      {:else}
        <div class="divide-y divide-[#212631] font-mono-tabular text-[12px] sm:text-[13px]">
          {#each byModel as m}
            <div class="py-2 flex items-center justify-between gap-2">
              <div class="truncate">
                <span class="text-[#ECEDF2] font-medium">{m.key}</span>
                <span class="text-[#8B93A6] ml-2">{m.turns} turns</span>
              </div>
              <div class="shrink-0 text-right">
                <span class="text-[#ECEDF2]">{formatTokens(m.tokensIn + m.tokensOut)}</span>
                <span class="text-[#8B93A6] ml-2">
                  {#if m.exactCostUsd > 0}
                    <span class="text-[#ECEDF2]">${m.exactCostUsd.toFixed(2)}</span>
                  {:else if m.estimatedCostUsd > 0}
                    ${m.estimatedCostUsd.toFixed(2)} est.
                  {:else}
                    —
                  {/if}
                </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Expensive & Low-Output Runs (§7.4) -->
  <div class="bezel-specular rounded p-3.5 sm:p-4 space-y-2.5">
    <div class="chrome-label">High-Burn / Low-File-Delta Sessions</div>
    {#if visibleUnproductiveRuns.length === 0}
      <p class="text-[13px] text-[#8B93A6] font-mono-tabular">No sessions recorded yet.</p>
    {:else}
      <div class="divide-y divide-[#212631] font-mono-tabular text-[12px] sm:text-[13px]">
        {#each visibleUnproductiveRuns as r (r.id)}
          {@const srcColor = SOURCE_COLORS[r.source] ?? '#6BA6FF'}
          <button
            type="button"
            onclick={() => deckStore.setView('detail', r.id)}
            class="w-full py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[#0D0F14] active:bg-[#171B24] px-2 rounded-sm transition-colors"
          >
            <div class="flex min-w-0 items-center gap-2 truncate">
              <span class="w-2 h-2 rounded-full shrink-0" style="background-color: {srcColor};"></span>
              <span class="chrome-label shrink-0">{r.source}</span>
              <span class="text-[#ECEDF2] font-semibold">{r.projectName}</span>
              <span class="hidden text-[#8B93A6] truncate sm:inline">· {r.title}</span>
              {#if r.historical}
                <span class="hidden text-[10px] px-1.5 py-0.5 border border-[#2E3545] text-[#8B93A6] rounded-sm uppercase sm:inline">historical</span>
              {/if}
            </div>
            <div class="shrink-0 flex items-center gap-2 text-[#8B93A6] sm:gap-3">
              <span class="text-[#ECEDF2]">{formatTokens(r.usage.tokensIn + r.usage.tokensOut)} tok</span>
              <span class="px-1.5 py-0.5 rounded-sm well-recessed text-[11px]">{r.filesChanged?.length ?? 0} files</span>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</section>
