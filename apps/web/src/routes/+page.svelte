<script lang="ts">
  import { deckStore, type ViewName } from '$lib/stores/deck.svelte';
  import { formatTokens } from '$lib/format';
  import SourceSelector from '$lib/components/SourceSelector.svelte';
  import AmbientView from '$lib/views/AmbientView.svelte';
  import DeckView from '$lib/views/DeckView.svelte';
  import UsageView from '$lib/views/UsageView.svelte';
  import LedgerView from '$lib/views/LedgerView.svelte';
  import DetailView from '$lib/views/DetailView.svelte';

  const MAIN_VIEWS: ViewName[] = ['ambient', 'deck', 'usage', 'ledger'];
  let settingsOpen = $state(false);
  let pairCodeInput = $state('');
  let pairError = $state(false);

  async function onPairSubmit(e: SubmitEvent) {
    e.preventDefault();
    const ok = await deckStore.submitPairCode(pairCodeInput);
    pairError = !ok;
  }

  const degradedAdapters = $derived(
    Object.values(deckStore.state.adapters).filter((a) => a.status === 'degraded' && deckStore.visibleSources.includes(a.source))
  );
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') settingsOpen = false; }} />

<main
  class="dashboard-shell"

>
  {#if deckStore.needsPairing}
    <div class="max-w-md mx-auto mt-10 sm:mt-20 bezel-specular rounded p-5 sm:p-6 space-y-4">
      <div class="flex items-center gap-2 border-b border-[#212631] pb-3">
        <span class="font-mono-tabular text-[13px] font-bold text-[#6BA6FF]">&gt;_</span>
        <span class="chrome-label !text-[#ECEDF2]">AGENT DECK / PAIRING</span>
      </div>
      <h1 class="text-[18px] sm:text-[20px] font-semibold tracking-tight text-[#ECEDF2]">Pair Device with Agent Deck</h1>
      <p class="text-[13px] sm:text-[14px] text-[#8B93A6]">
        Run <code class="font-mono-tabular px-1.5 py-0.5 bg-[#0D0F14] border border-[#212631] rounded text-[#ECEDF2]">agent-deck pair</code> on your PC and enter the 8-character code.
      </p>
      <form onsubmit={onPairSubmit} class="space-y-3">
        <input
          type="text"
          bind:value={pairCodeInput}
          placeholder="7F2K-9QRT"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          class="w-full h-12 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[18px] text-[#ECEDF2] uppercase tracking-widest"
        />
        {#if pairError}
          <p class="text-[13px] text-[#FF5E5E] font-mono-tabular">✕ Invalid or expired pairing code.</p>
        {/if}
        <button
          type="submit"
          class="w-full h-12 bg-[#6BA6FF] hover:bg-[#5A95EE] text-[#090A0D] font-semibold rounded text-[14px] uppercase tracking-wider transition-colors"
        >
          Pair Device
        </button>
      </form>
    </div>
  {:else}
    {#if degradedAdapters.length > 0 && deckStore.activeView !== 'ambient'}
      <div class="mb-3 bezel-specular !border-[#FFB020]/50 rounded px-3 py-2 text-[12px] text-[#FFB020] font-mono-tabular flex flex-wrap items-center justify-between gap-2 break-words sm:text-[13px]">
        <span class="flex items-center gap-2">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-[#FFB020]"></span>
          <span>Adapter degraded: {degradedAdapters.map((a) => `${a.source} (${a.lastError ?? 'offline'})`).join(', ')}</span>
        </span>
        <span class="chrome-label !text-[#FFB020]/80">FALLBACK ACTIVE</span>
      </div>
    {/if}

    {#if deckStore.activeView !== 'ambient'}
      <header class="dashboard-header">
        <a class="dashboard-brand" href="/" aria-label="Agent Deck home"><span aria-hidden="true">&gt;_</span> Agent Deck</a>
        <span class="dashboard-host"><span class="host-dot"></span> {deckStore.visibleAggregates.activeCount} agents active</span>
        <div class="dashboard-summary">
          {#if deckStore.visibleAggregates.waitingCount}<span class="attention-count">{deckStore.visibleAggregates.waitingCount} awaiting attention</span>{/if}
          <span class="running-count">{deckStore.visibleAggregates.activeCount} active</span>
          {#if deckStore.visibleAggregates.hasExactCost}<span class="dashboard-tokens">$ {deckStore.visibleAggregates.todayCostExactUsd.toFixed(2)}</span>{/if}
          {#if deckStore.visibleAggregates.hasEstimatedCost}<span class="dashboard-tokens">$ {deckStore.visibleAggregates.todayCostEstimatedUsd.toFixed(2)} est.</span>{/if}
          {#if deckStore.visibleAggregates.burnRateAlarm}<span class="attention-count" data-testid="burn-rate-alarm">High spend · ${deckStore.visibleAggregates.burnRateUsdPerMin.toFixed(2)}/min</span>{/if}
          <span class="dashboard-tokens">{formatTokens(deckStore.visibleAggregates.todayTokensIn + deckStore.visibleAggregates.todayTokensOut)} tok today</span>
          <div class="settings-anchor">
            <button type="button" class="dashboard-settings" aria-label="Settings" aria-expanded={settingsOpen} onclick={() => settingsOpen = !settingsOpen}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg></button>
          </div>
        </div>
      </header>
      {#if settingsOpen}
        <button type="button" class="settings-backdrop" aria-label="Dismiss settings" onclick={() => settingsOpen = false}></button>
        <aside class="settings-panel" aria-label="Display settings">
          <div class="settings-panel-title"><strong>Agent Deck</strong><button type="button" aria-label="Close settings" onclick={() => settingsOpen = false}>Close</button></div>
          <SourceSelector />
          <nav aria-label="Deck views">{#each MAIN_VIEWS as v}<button type="button" data-testid="nav-{v}" onclick={() => { deckStore.setView(v); settingsOpen = false; }} aria-current={deckStore.activeView === v ? 'page' : undefined}>{v}</button>{/each}</nav>
          <a href="/settings">All settings</a>
        </aside>
      {/if}
      {#if deckStore.activeView !== 'deck' && deckStore.activeView !== 'detail'}<button class="back-projects" type="button" onclick={() => deckStore.setView('deck')}>Back to projects</button>{/if}

    {/if}
    <!-- Active View Container -->
    {#if deckStore.activeView === 'ambient'}
      <AmbientView />
    {:else if deckStore.activeView === 'deck'}
      <DeckView />
    {:else if deckStore.activeView === 'usage'}
      <UsageView />
    {:else if deckStore.activeView === 'ledger'}
      <LedgerView />
    {:else if deckStore.activeView === 'detail'}
      <DetailView />
    {/if}
  {/if}
</main>
