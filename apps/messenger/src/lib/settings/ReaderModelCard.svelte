<script lang="ts">
	import type { ClaudeCodeStatus, Provider, ReaderModel, SettingsPatch } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import SideModelCard from './SideModelCard.svelte';

	/**
	 * Which model reads each line for what the app acts on (读句, ADR 0055): any model an endpoint
	 * lists, a Claude model run through your own Claude Code (ADR 0061), or the default model. Your
	 * line waits on the reading, so this is where a fast one goes. The card is that setting's own
	 * page, whose intro says so.
	 */
	interface Props {
		providers: readonly Provider[];
		/** The model chosen for reading; null follows the default. */
		chosen: ReaderModel | null;
		/** The default endpoint's default model, named on the option that follows it. */
		defaultModel: string | null;
		patch: (patch: SettingsPatch) => Promise<unknown | null>;
		/** What the daemon finds of your Claude Code; absent or failing (the phone cannot ask), no Claude group is offered. */
		claudeCode?: (() => Promise<ClaudeCodeStatus>) | null;
		t: Copy;
	}

	let { providers, chosen, defaultModel, patch, claudeCode = null, t }: Props = $props();
</script>

<SideModelCard
	kind="reader"
	{providers}
	{chosen}
	{defaultModel}
	{patch}
	toPatch={(next) => ({ reader_model: next })}
	title={t.readerModel.title}
	followDefault={t.readerModel.followDefault}
	failed={t.readerModel.failed}
	claude={{ status: claudeCode, note: t.readerModel.claudeNote }}
	{t}
/>
