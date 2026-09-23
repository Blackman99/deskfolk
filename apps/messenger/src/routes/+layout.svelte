<script lang="ts">
	import { onMount } from 'svelte';
	import { version } from '$app/environment';
	import { base } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import BuildUpdateNotice from '$lib/BuildUpdateNotice.svelte';
	import { fetchPublishedVersion } from '$lib/build-version';
	import { BuildUpdates } from '$lib/build-version.svelte';
	import { copyFor } from '$lib/copy';
	import { themeManager } from '$lib/theme';
	import { HOSTED_MESSENGER } from '$lib/remote/mode';
	import '$lib/styles/index.css';

	let { children } = $props();
	// The layout sits above the runtime, so this one line follows the browser rather than the
	// stored setting; everything else in the app reads the setting.
	const t = copyFor(
		typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('zh') ? 'en' : 'zh'
	);
	// Its own poll rather than `updated` from `$app/state`: that one is a boolean that latches,
	// and dismissing one build and asking again for the next needs the version itself.
	const updates = new BuildUpdates(version, () => fetchPublishedVersion(base));

	onMount(() => {
		const stopTheme = themeManager.init();
		if (!HOSTED_MESSENGER) return stopTheme;
		if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
		const stopUpdates = updates.start();
		return () => {
			stopUpdates();
			stopTheme();
		};
	});
</script>

<svelte:head>
	<title>Deskfolk</title>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<BuildUpdateNotice {t} {updates} />
