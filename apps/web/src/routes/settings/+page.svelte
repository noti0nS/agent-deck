<script lang="ts">
  import { deckStore } from '#lib/stores/deck.svelte.js';

  const prefs = $derived(deckStore.state.prefs);
  const adapters = $derived(Object.values(deckStore.state.adapters));

  let columns = $state<2 | 3>(2);
  let stallWarnSeconds = $state(120);
  let ambientIdleSeconds = $state(180);
  let burnRateAlarmUsdPerMin = $state(0.5);
  let nightDimStartHour = $state(22);
  let nightDimEndHour = $state(7);
  let enableAgyRemoteControl = $state(false);
  let savedBanner = $state(false);

  $effect(() => {
    columns = prefs.columns ?? 2;
    stallWarnSeconds = prefs.stallWarnSeconds ?? 120;
    ambientIdleSeconds = prefs.ambientIdleSeconds ?? 180;
    burnRateAlarmUsdPerMin = prefs.burnRateAlarmUsdPerMin ?? 0.5;
    nightDimStartHour = prefs.nightDimStartHour ?? 22;
    nightDimEndHour = prefs.nightDimEndHour ?? 7;
    enableAgyRemoteControl = prefs.enableAgyRemoteControl ?? false;
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    await deckStore.savePrefs({
      columns,
      stallWarnSeconds,
      ambientIdleSeconds,
      burnRateAlarmUsdPerMin,
      nightDimStartHour,
      nightDimEndHour,
      enableAgyRemoteControl
    });
    savedBanner = true;
    setTimeout(() => (savedBanner = false), 2000);
  }
</script>

<!-- Desktop Settings View (/settings) (§7.2, §8.2, §8.6) -->
<main class="max-w-3xl mx-auto p-4 sm:p-6 space-y-5" data-testid="settings-view">
  <div class="flex flex-wrap items-start justify-between gap-3 border-b border-[#212631] pb-4">
    <div>
      <div class="flex items-center gap-2 mb-1">
        <span class="font-mono-tabular text-[13px] font-bold text-[#6BA6FF]">&gt;_</span>
        <span class="chrome-label !text-[#ECEDF2]">AGENT DECK / SETTINGS</span>
      </div>
      <h1 class="text-[19px] font-semibold tracking-tight text-[#ECEDF2] sm:text-[22px]">Agent Deck Settings</h1>
      <p class="text-[13px] text-[#8B93A6] sm:text-[14px]">
        Observe-only sidecar configuration, display schedules, and price table metadata.
      </p>
    </div>
    <a
      href="/"
      class="bezel-specular min-h-[48px] px-4 rounded font-mono-tabular text-[13px] font-semibold text-[#ECEDF2] inline-flex items-center gap-2 hover:border-[#2E3545] active:bg-[#171B24]"
    >
      <span class="text-[#6BA6FF]">←</span>
      <span>Return to Deck</span>
    </a>
  </div>

  <form onsubmit={save} class="bezel-specular rounded p-4 sm:p-5 space-y-4">
    <div class="chrome-label border-b border-[#212631] pb-2">Display & Thresholds</div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-[13px] sm:text-[14px]">
      <label class="space-y-1.5 block">
        <span class="text-[#8B93A6] font-mono-tabular text-[12px]">Deck Grid Columns</span>
        <select
          bind:value={columns}
          class="w-full h-11 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[#ECEDF2]"
        >
          <option value={2}>2 Columns (2×2)</option>
          <option value={3}>3 Columns (2×3)</option>
        </select>
      </label>

      <label class="space-y-1.5 block">
        <span class="text-[#8B93A6] font-mono-tabular text-[12px]">Stall Warning Threshold (seconds)</span>
        <input
          type="number"
          bind:value={stallWarnSeconds}
          min="10"
          max="3600"
          class="w-full h-11 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[#ECEDF2]"
        />
      </label>

      <label class="space-y-1.5 block">
        <span class="text-[#8B93A6] font-mono-tabular text-[12px]">Auto-Ambient Idle Timeout (seconds)</span>
        <input
          type="number"
          bind:value={ambientIdleSeconds}
          min="15"
          max="3600"
          class="w-full h-11 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[#ECEDF2]"
        />
      </label>

      <label class="space-y-1.5 block">
        <span class="text-[#8B93A6] font-mono-tabular text-[12px]">Live Burn-Rate Alarm ($/min)</span>
        <input
          type="number"
          step="0.05"
          bind:value={burnRateAlarmUsdPerMin}
          class="w-full h-11 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[#ECEDF2]"
        />
      </label>

      <label class="space-y-1.5 block">
        <span class="text-[#8B93A6] font-mono-tabular text-[12px]">Night Dim Start Hour (0–23)</span>
        <input
          type="number"
          bind:value={nightDimStartHour}
          min="0"
          max="23"
          class="w-full h-11 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[#ECEDF2]"
        />
      </label>

      <label class="space-y-1.5 block">
        <span class="text-[#8B93A6] font-mono-tabular text-[12px]">Night Dim End Hour (0–23)</span>
        <input
          type="number"
          bind:value={nightDimEndHour}
          min="0"
          max="23"
          class="w-full h-11 px-3 bg-[#090A0D] border border-[#212631] focus:border-[#6BA6FF] focus:outline-none rounded font-mono-tabular text-[#ECEDF2]"
        />
      </label>
    </div>

    <label class="flex items-center gap-3 pt-2 text-[13px] sm:text-[14px]">
      <input type="checkbox" bind:checked={enableAgyRemoteControl} class="w-5 h-5 accent-[#6BA6FF]" />
      <span class="text-[#ECEDF2]">
        Enable opt-in <code class="font-mono-tabular px-1.5 py-0.5 well-recessed rounded-sm">agy remote-control</code> daemon tier (enabled by Agent Deck)
      </span>
    </label>

    <div class="pt-2 flex flex-wrap items-center gap-3 sm:gap-4">
      <button
        type="submit"
        class="w-full sm:w-auto min-h-[48px] px-6 bg-[#6BA6FF] hover:bg-[#5A95EE] text-[#090A0D] font-mono-tabular font-semibold uppercase tracking-wider rounded text-[13px] transition-colors"
      >
        Save Preferences
      </button>
      {#if savedBanner}
        <span class="font-mono-tabular text-[13px] text-[#3DDC97]">✓ Preferences saved.</span>
      {/if}
    </div>
  </form>

  <!-- Price Table Metadata (§7.2) -->
  <div class="bezel-specular rounded p-4 sm:p-5 space-y-2">
    <div class="chrome-label border-b border-[#212631] pb-2">Pricing & Measurement Honesty</div>
    <p class="font-mono-tabular text-[13px] sm:text-[14px] text-[#ECEDF2] pt-1">
      Price Table Version: <span class="text-[#3DDC97] font-semibold">{deckStore.pricingInfo.version}</span> · Updated: <span class="text-[#3DDC97] font-semibold">{deckStore.pricingInfo.updatedAt}</span>
    </p>
    <p class="text-[13px] text-[#8B93A6]">
      Actual spend is shown only where the tool reports it directly (e.g., OpenCode's <code class="font-mono-tabular text-[#ECEDF2]">cost</code> column). Derived figures use this price table and are always labelled <code class="font-mono-tabular text-[#ECEDF2]">est.</code>
    </p>
  </div>

  <!-- Adapter Capabilities Matrix -->
  <div class="bezel-specular rounded p-4 sm:p-5 space-y-3">
    <div class="chrome-label border-b border-[#212631] pb-2">Adapter Capabilities</div>
    <div class="divide-y divide-[#212631] font-mono-tabular text-[12px] sm:text-[13px]">
      {#each adapters as a}
        <div class="py-2.5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div>
            <span class="text-[#ECEDF2] uppercase font-semibold">{a.source}</span>
            <span class="ml-2 text-[#8B93A6]">({a.status})</span>
          </div>
          <div class="text-[#8B93A6]">
            usage: <span class="text-[#ECEDF2]">{a.capabilities.usagePrecision}</span> ·
            live: <span class="text-[#ECEDF2]">{a.capabilities.liveEvents ? 'yes' : 'no'}</span> ·
            subagents: <span class="text-[#ECEDF2]">{a.capabilities.subagents ? 'yes' : 'no'}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>
</main>
