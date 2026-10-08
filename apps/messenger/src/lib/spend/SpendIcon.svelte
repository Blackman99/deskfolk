<script lang="ts">
	let { name }: { name: 'back' | 'refresh' | 'chevron' | 'filter' | 'close' | 'arrow' | 'coins' | 'spark' | 'calendar' | 'info' } = $props();
</script>

<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	{#if name === 'back'}<path d="m14 6-6 6 6 6" />
	{:else if name === 'refresh'}<path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
	{:else if name === 'chevron'}<path d="m8 10 4 4 4-4" />
	{:else if name === 'filter'}<path d="M4 6h16M7 12h10M10 18h4" />
	{:else if name === 'close'}<path d="m7 7 10 10M7 17 17-10" />
	{:else if name === 'coins'}<circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="m7 6 2 4" />
	{:else if name === 'spark'}<path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3Z" />
	{:else if name === 'calendar'}<rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
	{:else if name === 'info'}<circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
	{:else}<path d="M5 12h14m-5-5 5 5-5 5" />{/if}
</svg>
