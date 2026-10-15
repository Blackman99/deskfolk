<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { IconName } from '../icons.ts';

	let { name }: { name: 'back' | 'refresh' | 'chevron' | 'filter' | 'close' | 'arrow' | 'coins' | 'spark' | 'calendar' | 'info' } = $props();

	const NAMES: Record<string, IconName> = {
		back: 'chevron-left',
		refresh: 'refresh',
		chevron: 'chevron-down',
		filter: 'filter',
		close: 'x',
		coins: 'coins',
		spark: 'sparkle',
		calendar: 'calendar',
		info: 'info'
	};
</script>

<Icon name={NAMES[name] ?? 'arrow-right'} />
