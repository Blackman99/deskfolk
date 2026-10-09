<script lang="ts">
	import type { Provider, ReaderEndpointModel, SettingsPatch } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import SideModelCard from './SideModelCard.svelte';

	/**
	 * Which model keeps the board, trace and plan in order (整理模型, ADR 0075): the organizer, the
	 * scribe and the picture checks against a sample and between parts. Any model an endpoint lists,
	 * or the default model; a Claude model of yours is not offered, since the daemon only runs this
	 * on an endpoint. It is a place for a strong one, which the page's intro says.
	 */
	interface Props {
		providers: readonly Provider[];
		/** The model chosen for organizing; null follows the default. */
		chosen: ReaderEndpointModel | null;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		t: Copy;
	}

	let { providers, chosen, defaultModel, patch, t }: Props = $props();
</script>

<SideModelCard
	kind="organizer"
	{providers}
	{chosen}
	{defaultModel}
	{patch}
	toPatch={(next) => ({ organizer_model: next as ReaderEndpointModel | null })}
	title={t.organizerModel.title}
	followDefault={t.organizerModel.followDefault}
	failed={t.organizerModel.failed}
	{t}
/>
