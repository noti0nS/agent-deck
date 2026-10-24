<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { deckStore } from '$lib/stores/deck.svelte';

  let { children } = $props();

  onMount(() => {
    return deckStore.init();
  });
</script>

<!-- Single aria-live="polite" region used ONLY when a run enters `waiting` (§8.7) -->
<div class="sr-only" aria-live="polite" aria-atomic="true">
  {deckStore.waitingAnnouncement}
</div>

<!-- Reconnect top hairline banner (§8.6): never a spinner over content -->
{#if deckStore.connectionStatus !== 'connected'}
  <div
    class="fixed top-0 left-0 right-0 z-50 h-[3px] transition-colors {deckStore.connectionStatus === 'reconnecting' ? 'bg-[#FFB020]' : 'bg-[#3DDC97]'}"
    data-testid="reconnect-hairline"
  ></div>
  {#if deckStore.connectionStatus === 'reconnecting'}
    <div class="bg-[#FFB020]/15 border-b border-[#FFB020]/40 px-4 py-1 text-[13px] text-[#FFB020] font-mono-tabular flex items-center justify-between">
      <span>reconnecting… showing last known state</span>
      <span>seq #{deckStore.state.seq}</span>
    </div>
  {/if}
{/if}

<div
  class="min-h-screen transition-opacity duration-500 {deckStore.isNightDimmed && deckStore.activeView === 'ambient' ? 'opacity-65' : 'opacity-100'}"
  style="transform: translate({deckStore.pixelShift.x}px, {deckStore.pixelShift.y}px);"
>
  {@render children()}
</div>
