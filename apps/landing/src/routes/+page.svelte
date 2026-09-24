<script lang="ts">
  import { base } from '$app/paths';
  import { onMount } from 'svelte';
  import Logo from '$lib/Logo.svelte';

  onMount(() => {
    const lang = (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    window.location.replace(`${base}/${lang}`);
  });
</script>

<svelte:head>
  <meta http-equiv="refresh" content="0;url={base}/zh" />
</svelte:head>

<div class="redirect">
  <Logo size={28} />
  <span>Deskfolk</span>
  <span class="spinner" aria-hidden="true"></span>
</div>

<style>
  .redirect {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--ink-2);
    font-family: var(--font-serif);
    font-size: 1.1rem;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--teal);
    border-top-color: transparent;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
