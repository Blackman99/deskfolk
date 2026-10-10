<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { localeTag } from '../locale-tag.ts';
	import UsagePanelBody from './UsagePanelBody.svelte';
	import { usageFeedOf } from './usage-feed.svelte.ts';

	/** Every agent's usage in full, kept fresh while shown: the phone's page and the workbench's tab. */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
	}

	let { runtime, t }: Props = $props();

	const feed = $derived(usageFeedOf(runtime));
	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const locale = $derived(localeTag(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'));

	$effect(() => {
		const api = client;
		if (!api) return;
		return feed.watch(api);
	});
</script>

{#if feed.agents}
	<UsagePanelBody agents={feed.agents} {t} {locale} now={feed.now} busy={feed.busy} failed={feed.failed} onRefresh={() => client && void feed.load(client, true)} />
{/if}
