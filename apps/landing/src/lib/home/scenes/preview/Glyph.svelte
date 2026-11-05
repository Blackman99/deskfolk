<script lang="ts">
  import type { Kind } from '../../file-kind';

  /** A small file-type mark for the file list: a sheet of paper with a sign for what is on it. */
  let { kind }: { kind: Kind } = $props();
</script>

<svg class="glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  {#if kind === 'image'}
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M2.6 11.5 6 8l2.6 2.6L10.5 9l3 3" />
    <circle cx="11" cy="5.8" r="0.9" />
  {:else if kind === 'video'}
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M6.8 6v4l3.4-2z" fill="currentColor" />
  {:else if kind === 'audio'}
    <path d="M3 8v0M5.5 5.5v5M8 3.5v9M10.5 5.5v5M13 8v0" />
  {:else if kind === 'office'}
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.6" />
    <path d="M2.5 7h11M7 2.5v11" />
  {:else}
    <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
    <path d="M9 1.8V5h3.5" />
    {#if kind !== 'unknown'}<path d="M6 8.3h4.5M6 10.6h4.5" />{/if}
  {/if}
</svg>

<style>
  .glyph {
    flex: none;
  }
</style>
