<script lang="ts">
  import { onMount } from 'svelte';
  import type { Dict } from '$lib/i18n';
  import { THEMES, getTheme, initTheme, setTheme, type Theme } from '$lib/theme.svelte';

  let { t }: { t: Dict } = $props();

  const labels: Record<Theme, string> = $derived({
    system: t.nav.themeSystem,
    light: t.nav.themeLight,
    dark: t.nav.themeDark
  });

  onMount(() => {
    initTheme();
  });
</script>

<div class="toggle" role="radiogroup" aria-label={t.nav.theme}>
  {#each THEMES as theme}
    <button
      type="button"
      role="radio"
      class="opt"
      class:on={getTheme() === theme}
      aria-checked={getTheme() === theme}
      aria-label={labels[theme]}
      title={labels[theme]}
      onclick={() => setTheme(theme)}
    >
      {#if theme === 'system'}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="3" width="13" height="8.5" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 13.5h5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      {:else if theme === 'light'}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      {:else}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
      {/if}
    </button>
  {/each}
</div>

<style>
  .toggle {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--paper);
  }

  .opt {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 26px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--ink-3);
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
  }

  .opt:hover {
    color: var(--ink);
  }

  .opt.on {
    background: var(--teal-tint);
    color: var(--teal-2);
  }

  @media (prefers-reduced-motion: reduce) {
    .opt {
      transition: none;
    }
  }
</style>
