<script lang="ts">
  import { deckStore, type ViewName } from '$lib/stores/deck.svelte';
  import AmbientView from '$lib/views/AmbientView.svelte';
  import DeckView from '$lib/views/DeckView.svelte';
  import UsageView from '$lib/views/UsageView.svelte';
  import LedgerView from '$lib/views/LedgerView.svelte';
  import DetailView from '$lib/views/DetailView.svelte';

  const MAIN_VIEWS: ViewName[] = ['ambient', 'deck', 'usage', 'ledger'];

  let touchStartX = 0;
  let touchStartY = 0;
  let pairCodeInput = $state('');
  let pairError = $state(false);

  function handleTouchStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }
  }

  function handleTouchEnd(e: TouchEvent) {
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;

    if (deckStore.activeView === 'detail') {
      if (dx > 60) deckStore.backFromDetail();
      return;
    }

    const idx = MAIN_VIEWS.indexOf(deckStore.activeView);
    if (idx === -1) return;
    if (dx < -60 && idx < MAIN_VIEWS.length - 1) {
      deckStore.setView(MAIN_VIEWS[idx + 1]);
    } else if (dx > 60 && idx > 0) {
      deckStore.setView(MAIN_VIEWS[idx - 1]);
    }
  }

  async function onPairSubmit(e: SubmitEvent) {
    e.preventDefault();
    const ok = await deckStore.submitPairCode(pairCodeInput);
    pairError = !ok;
  }

  const degradedAdapters = $derived(
    Object.values(deckStore.state.adapters).filter((a) => a.status === 'degraded')
  );
</script>

<main
  class="max-w-[1440px] mx-auto px-3 sm:px-4 pt-3 pb-nav"
  ontouchstart={handleTouchStart}
  ontouchend={handleTouchEnd}
>
  {#if deckStore.needsPairing}
    <div class="max-w-md mx-auto mt-10 sm:mt-20 bg-[#14171C] border border-[#232830] rounded-sm p-4 sm:p-6 space-y-4">
      <h1 class="text-[18px] sm:text-[20px] font-semibold text-[#E8EBF0]">Pair Device with Agent Deck</h1>
      <p class="text-[13px] sm:text-[14px] text-[#8A93A3]">
        Run <code class="font-mono-tabular text-[#E8EBF0]">agent-deck pair</code> on your PC and enter the 8-character code.
      </p>
      <form onsubmit={onPairSubmit} class="space-y-3">
        <input
          type="text"
          bind:value={pairCodeInput}
          placeholder="7F2K-9QRT"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          class="w-full h-12 px-3 bg-[#0B0D10] border border-[#232830] rounded-sm font-mono-tabular text-[18px] text-[#E8EBF0] uppercase"
        />
        {#if pairError}
          <p class="text-[13px] text-[#FF5E5E]">Invalid or expired pairing code.</p>
        {/if}
        <button
          type="submit"
          class="w-full h-12 bg-[#6BA6FF] text-[#0B0D10] font-semibold rounded-sm text-[15px]"
        >
          Pair Device
        </button>
      </form>
    </div>
  {:else}
    {#if degradedAdapters.length > 0 && deckStore.activeView !== 'ambient'}
      <div class="mb-3 bg-[#14171C] border border-[#FFB020]/50 rounded-sm px-3 py-1.5 text-[12px] text-[#FFB020] font-mono-tabular flex flex-wrap items-center justify-between gap-1 break-words sm:text-[13px]">
        <span>
          Adapter degraded: {degradedAdapters.map((a) => `${a.source} (${a.lastError ?? 'offline'})`).join(', ')}
        </span>
      </div>
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

    <!-- Bottom Thumb-Reach View Indicator Bar (≥48px hit targets, hidden in chrome-free Ambient) -->
    {#if deckStore.activeView !== 'ambient'}
      <nav
        aria-label="Deck views"
        class="safe-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-[#232830] bg-[#14171C]/95 backdrop-blur"
      >
        <div class="mx-auto flex max-w-[1440px] items-stretch gap-1 px-2 pt-1.5 sm:justify-center sm:gap-2 sm:px-4">
          {#each MAIN_VIEWS as v}
            <button
              type="button"
              onclick={() => deckStore.setView(v)}
              aria-current={deckStore.activeView === v ? 'page' : undefined}
              class="min-h-[50px] flex-1 rounded-sm px-2 text-[11px] font-medium uppercase tracking-wider transition-colors active:bg-[#232830] sm:min-h-[48px] sm:flex-none sm:px-5 sm:text-[13px] {deckStore.activeView === v ? 'bg-[#232830] text-[#E8EBF0] border border-[#6BA6FF]/60' : 'text-[#8A93A3] hover:text-[#E8EBF0]'}"
              data-testid="nav-{v}"
            >
              {v}
            </button>
          {/each}
        </div>
      </nav>
    {/if}
  {/if}
</main>
