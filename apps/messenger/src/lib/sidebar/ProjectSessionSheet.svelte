<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { PROJECT_AGENT_CAPS, type ProjectAgent } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { modalOut } from '../modal-motion.ts';
	import ProjectAgentTiles from './ProjectAgentTiles.svelte';
	import ProjectDirPicker from './ProjectDirPicker.svelte';
	import { loadAgentSessions, type ImportListing } from './import-claude-session.ts';
	import { PROJECT_AGENTS } from './project-groups.ts';

	/**
	 * A project session (ADR 0095), in one of two errands: `new` picks the agent, then a directory
	 * to start in; `import` picks the agent, then a terminal session to carry on, by the directory
	 * it ran in. The import sheet offers the agents whose terminal sessions can be carried on
	 * (`PROJECT_AGENT_CAPS`). Mounted only while open, so a fresh mount is the reset.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		mode?: 'new' | 'import';
		/** The agent it opens on: the one whose "new" was chosen. */
		agent?: ProjectAgent;
		onClose: () => void;
	};

	let { runtime, t, mode = 'new', agent: openedOn = 'claude_code', onClose }: Props = $props();
	/** A click outside closes the sheet; a text-selection drag that starts inside never does. */
	const backdrop = backdropClick();

	const agents = $derived(PROJECT_AGENTS.filter((each) => mode === 'new' || PROJECT_AGENT_CAPS[each].importable));
	let agent = $state<ProjectAgent>(untrack(() => (agents.includes(openedOn) ? openedOn : agents[0]!)));
	/**
	 * Each agent's terminal sessions, read once and side by side (another agent's are asked of the
	 * agent itself, which takes a moment); enough of them that a directory from last week still
	 * shows. Every agent's place the folders; the picked agent's are listed under them.
	 */
	const importable = PROJECT_AGENTS.filter((each) => PROJECT_AGENT_CAPS[each].importable);
	let lists = $state<Partial<Record<ProjectAgent, ImportListing[]>>>({});
	let failed = $state<Partial<Record<ProjectAgent, boolean>>>({});
	/** Held until the picked agent's list is in (or could not be had); the others join as they come. */
	const items = $derived(lists[agent] || failed[agent] || !importable.includes(agent) ? Object.values(lists).flat() : null);
	const loadFailed = $derived(failed[agent] === true);

	onMount(() => {
		const client = runtime.client;
		for (const each of importable) {
			if (!client) {
				failed[each] = true;
				continue;
			}
			loadAgentSessions(client, each, 120).then(
				(listed) => {
					lists[each] = listed;
				},
				// The phone, or a daemon older than this agent's list: it has none to give.
				() => {
					failed[each] = true;
				}
			);
		}
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="modal-backdrop page-on-phone"
	in:pageSlide
	out:modalOut
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	onmousedowncapture={backdrop.press}
	onclick={(e) => {
		if (backdrop.isOutside(e)) onClose();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
>
	<div class="modal-dialog project-session-modal" data-project-sheet={mode}>
		<div class="modal-head">
			<button type="button" class="modal-back" aria-label={t.common.back} title={t.common.back} onclick={onClose}>
				<Icon name="chevron-left" />
			</button>
			<h2>{mode === 'import' ? t.project.importTitle : t.project.newTitle}</h2>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="modal-body">
			<div class="modal-section" data-project-agents>
				<span class="field-head">{t.project.agentHead}</span>
				<ProjectAgentTiles {t} {agents} {agent} onpick={(each) => (agent = each)} />
			</div>
			<div class="modal-section dirs">
				<span class="field-head">{t.project.dirsHead}</span>
				{#if loadFailed}
					<p class="field-error" data-import-failed>{t.sidebar.importClaudeFailed}</p>
				{:else if !items}
					<p class="muted field-hint">{t.sidebar.importClaudeLoading}</p>
				{/if}
				<!-- Held until the listing is in: the terminal's directories would otherwise land above the app's under your pointer. -->
				{#if items || loadFailed}
					{#key agent}
						<ProjectDirPicker {runtime} {t} {agent} {mode} {items} sessions={runtime.snapshot.sessions} />
					{/key}
				{/if}
			</div>
		</div>
	</div>
</div>

<style>
	.modal-dialog.project-session-modal {
		width: 560px;
		max-width: 95vw;
		max-height: 88vh;
	}

	.dirs {
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}
</style>
