<script lang="ts">
  import { deckStore, type ViewName } from '$lib/stores/deck.svelte';
  import AmbientView from '$lib/views/AmbientView.svelte';
  import DeckView from '$lib/views/DeckView.svelte';
  import UsageView from '$lib/views/UsageView.svelte';
  import LedgerView from '$lib/views/LedgerView.svelte';
  import DetailView from '$lib/views/DetailView.svelte';

  const MAIN_VIEWS: ViewName[] = ['ambient', 'deck', 'usage', 'ledger'];
  const VIEW_INDEX: Record<ViewName, string> = {
    ambient: '01',
    deck: '02',
    usage: '03',
    ledger: '04',
    detail: '05'
  };

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
    <div class="max-w-md mx-auto mt-10 sm:mt-20 bezel-specular rounded p-5 sm:p-6 space-y-4">
      <div class="flex items-center gap-2 border-b border-[#212631] pb-3">
        <span class="font-mono-tabular text-[13px] font-bold text-[#6BA6FF]">&gt;_</span>
        <span class="chrome-label !text-[#ECEDF2]">OPENCODE // AGENT DECK PAIRING</span>
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

    <!-- Bottom Thumb-Reach Segmented Terminal Dock (≥48px hit targets, hidden in chrome-free Ambient) -->
    {#if deckStore.activeView !== 'ambient'}
      <nav
        aria-label="Deck views"
        class="safe-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-[#212631] bg-[#0D0F14]/95 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]"
      >
        <div class="mx-auto flex max-w-[1440px] items-center justify-between px-2 pt-1.5 sm:px-4">
          <!-- Left OpenCode Observer Stamp (Tablet/Desktop) -->
          <div class="hidden lg:flex items-center gap-2 min-w-[190px]">
            <span class="w-1.5 h-1.5 rounded-full bg-[#3DDC97]"></span>
            <span class="chrome-label tracking-widest">LIVE DECK OBSERVER</span>
          </div>

          <!-- Center Segmented Channels -->
          <div class="flex flex-1 items-stretch gap-1 sm:flex-none sm:justify-center sm:gap-2">
            {#each MAIN_VIEWS as v}
              {@const isActive = deckStore.activeView === v}
              <button
                type="button"
                onclick={() => deckStore.setView(v)}
                aria-current={isActive ? 'page' : undefined}
                class="relative min-h-[48px] flex-1 rounded-sm px-1.5 font-mono-tabular text-[11px] font-semibold uppercase tracking-wider transition-colors active:bg-[#171B24] sm:flex-none sm:px-5 sm:text-[12px] {isActive ? 'bg-[#171B24] text-[#ECEDF2] border border-[#2E3545] shadow-[inset_0_2px_0_0_#6BA6FF]' : 'text-[#8B93A6] hover:text-[#ECEDF2] hover:bg-[#12151C] border border-transparent'}"
                data-testid="nav-{v}"
              >
                <span class="hidden sm:inline text-[#4C5365] mr-1.5">{VIEW_INDEX[v]}</span>{v}
              </button>
            {/each}
          </div>

          <!-- Right Cadence Stamp (Tablet/Desktop) -->
          <div class="hidden lg:flex items-center justify-end gap-2 min-w-[190px] font-mono-tabular text-[11px] text-[#8B93A6]">
            <span class="chrome-label">SEQ #{deckStore.state.seq}</span>
            <span class="text-[#4C5365]">·</span>
            <a href="/settings" class="chrome-label hover:!text-[#ECEDF2] transition-colors">CFG</a>
          </div>
        </div>
      </nav>
    {/if}
  {/if}
</main>
