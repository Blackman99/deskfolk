<script lang="ts">
	import { onMount } from 'svelte';
	import type { ClaudeCodeSessionListing, ProjectAgent } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { modalOut } from '../modal-motion.ts';
	import ProjectDirPicker from './ProjectDirPicker.svelte';
	import { PROJECT_AGENTS } from './project-groups.ts';

	/**
	 * Start a project session (ADR 0095): pick the agent, then a directory, and in it start anew or
	 * carry on a terminal session that ran there. Mounted only while open, so a fresh mount is the reset.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		onClose: () => void;
	};

	let { runtime, t, onClose }: Props = $props();
	/** A click outside closes the sheet; a text-selection drag that starts inside never does. */
	const backdrop = backdropClick();

	let agent = $state<ProjectAgent>(PROJECT_AGENTS[0]!);
	/** The terminal sessions, read once; enough of them that a directory from last week still shows. */
	let items = $state<ClaudeCodeSessionListing[] | null>(null);
	let loadFailed = $state(false);

	onMount(() => {
		const client = runtime.client;
		if (!client) {
			loadFailed = true;
			return;
		}
		void (async () => {
			try {
				items = await client.claudeCodeSessions(120);
			} catch {
				// The phone, or a daemon older than ADR 0095: it has no list to give.
				loadFailed = true;
			}
		})();
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
	<div class="modal-dialog project-session-modal" data-project-sheet>
		<div class="modal-head">
			<button type="button" class="modal-back" aria-label={t.common.back} title={t.common.back} onclick={onClose}>
				<Icon name="chevron-left" />
			</button>
			<h2>{t.project.add}</h2>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="modal-body">
			<div class="modal-section" data-project-agents>
				<span class="field-head">{t.project.agentHead}</span>
				<div class="agent-tiles" role="radiogroup" aria-label={t.project.agentHead}>
					{#each PROJECT_AGENTS as each (each)}
						<button
							type="button"
							class="agent-tile"
							class:active={agent === each}
							role="radio"
							aria-checked={agent === each}
							data-project-agent={each}
							onclick={() => (agent = each)}
						>
							<AgentLogo runner={each} size={20} />
							<span>{t.project.agentName}</span>
						</button>
					{/each}
				</div>
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
						<ProjectDirPicker {runtime} {t} {agent} {items} sessions={runtime.snapshot.sessions} />
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

	.agent-tiles {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.agent-tile {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 6px 14px 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}

	.agent-tile:hover {
		background: var(--row-hover);
	}

	.agent-tile.active {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.dirs {
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}

	@media (max-width: 680px) {
		.agent-tile {
			min-height: 44px;
		}
	}
</style>
