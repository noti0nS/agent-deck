<script lang="ts">
  let { value = $bindable(''), invalid = false }: { value?: string; invalid?: boolean } = $props();
  let cells = $state<string[]>(Array(8).fill(''));
  const inputs: HTMLInputElement[] = [];
  const clean = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  function focus(index: number) { inputs[Math.max(0, Math.min(7, index))]?.focus(); }
  function publish() { value = `${cells.slice(0, 4).join('')}-${cells.slice(4).join('')}`; }
  function insert(text: string, index: number) {
    const chars = clean(text);
    if (!chars) { cells[index] = ''; publish(); return; }
    const start = chars.length >= 8 ? 0 : index;
    for (let n = 0; n < Math.min(chars.length, 8 - start); n++) cells[start + n] = chars[n];
    publish();
    focus(start + chars.length);
  }
  $effect(() => {
    const chars = clean(value);
    if (chars !== cells.join('')) cells = Array.from({ length: 8 }, (_, i) => chars[i] ?? '');
  });
</script>

<fieldset class="pair-code" aria-describedby={invalid ? 'pair-code-error' : 'pair-code-hint'}>
  <legend>Pairing code</legend>
  <div class="code-cells">
    {#each Array(8) as _, i}
      {#if i === 4}<span class="code-divider" aria-hidden="true">–</span>{/if}
      <input bind:this={inputs[i]} value={cells[i]} aria-label={`Character ${i + 1} of 8`}
        aria-invalid={invalid} type="text" inputmode="text" autocapitalize="characters"
        autocomplete={i === 0 ? 'one-time-code' : 'off'} spellcheck="false"
        onfocus={(event) => event.currentTarget.select()}
        oninput={(event) => { insert(event.currentTarget.value, i); event.currentTarget.value = cells[i]; }}
        onpaste={(event) => { event.preventDefault(); insert(event.clipboardData?.getData('text') ?? '', i); }}
        onkeydown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); focus(i - 1); }
          if (event.key === 'ArrowRight') { event.preventDefault(); focus(i + 1); }
          if (event.key === 'Backspace') {
            event.preventDefault();
            if (cells[i]) cells[i] = '';
            else if (i > 0) { cells[i - 1] = ''; focus(i - 1); }
            publish();
          }
        }} />
    {/each}
  </div>
  <p id="pair-code-hint">Type or paste the code shown on your PC.</p>
</fieldset>

<style>
  .pair-code { min-width:0; border:0; padding:0; }
  legend { font-size:12px; color:#cbd0d8; margin-bottom:10px; }
  .code-cells { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)) 12px repeat(4,minmax(0,1fr)); gap:5px; align-items:center; }
  input { width:100%; min-width:0; height:50px; padding:0; text-align:center; border:1px solid #3a414d; border-radius:7px; background:#101318; color:#ecedf2; font:500 20px ui-monospace,monospace; caret-color:#6ba6ff; transition:border-color 150ms,background 150ms; }
  input:focus { outline:2px solid #6ba6ff; outline-offset:2px; border-color:transparent; background:#192231; }
  input[aria-invalid=true] { border-color:#ff5e5e; }
  .code-divider { text-align:center; color:#8b93a6; }
  p { font-size:11px; color:#929aa5; margin-top:10px; }
  @media(prefers-reduced-motion:reduce) { input { transition:none; } }
</style>
