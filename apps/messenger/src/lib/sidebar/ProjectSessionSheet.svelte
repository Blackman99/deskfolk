<script lang="ts">
	import { onMount } from 'svelte';
	import type { ClaudeCodeSessionListing } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import Button from '../Button.svelte';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { modalOut } from '../modal-motion.ts';
	import { pickWorkspaceFolder, workspacePickerAvailable } from '../settings/pick-workspace.ts';
	import ImportClaudeSession from './ImportClaudeSession.svelte';
	import { newProjectRequest, tildePath } from './import-claude-session.ts';
	import { isAbsoluteDir, recentProjectDirs } from './project-groups.ts';

	/**
	 * Start a project session (ADR 0095): in a directory you pick or type, or carrying a terminal
	 * Claude Code session on. Mounted only while open, so a fresh mount is the reset.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		onClose: () => void;
	};

	let { runtime, t, onClose }: Props = $props();
	/** A click outside closes the sheet; a text-selection drag that starts inside never does. */
	const backdrop = backdropClick();

	let dir = $state('');
	let pending = $state(false);
	let error = $state<'invalid' | 'failed' | null>(null);
	/** The terminal sessions, read once: the list below and the recent directories above share them. */
	let items = $state<ClaudeCodeSessionListing[] | null>(null);
	let loadFailed = $state(false);
	const canPick = workspacePickerAvailable();
	const recent = $derived(items ? recentProjectDirs(items) : []);

	onMount(() => {
		const client = runtime.client;
		if (!client) {
			loadFailed = true;
			return;
		}
		void (async () => {
			try {
				items = await client.claudeCodeSessions(40);
			} catch {
				// The phone, or a daemon older than ADR 0095: it has no list to give.
				loadFailed = true;
			}
		})();
	});

	async function pick(): Promise<void> {
		try {
			const picked = await pickWorkspaceFolder(dir, t.project.pickTitle);
			if (picked) {
				dir = picked;
				error = null;
			}
		} catch {
			error = 'failed';
		}
	}

	async function start(): Promise<void> {
		if (pending) return;
		if (!isAbsoluteDir(dir)) {
			error = 'invalid';
			return;
		}
		pending = true;
		error = null;
		const failure = await runtime.createProjectSession(newProjectRequest(dir));
		pending = false;
		if (failure) error = failure.status === 422 || failure.status === 404 ? 'invalid' : 'failed';
	}
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
			<div class="modal-section" data-project-new>
				<span class="field-head">{t.project.newHead}</span>
				<label for="project-dir">{t.project.dirLabel}</label>
				<div class="dir-row">
					<input
						id="project-dir"
						type="text"
						placeholder={t.project.dirPlaceholder}
						autocomplete="off"
						spellcheck="false"
						bind:value={dir}
						oninput={() => (error = null)}
						onkeydown={(e) => {
							if (e.key === 'Enter' && !e.isComposing) void start();
						}}
					/>
					{#if canPick}
						<Button icon="folder" onclick={() => void pick()}>{t.project.pick}</Button>
					{/if}
				</div>
				{#if recent.length > 0}
					<div class="recent" data-project-recent>
						<span class="muted field-hint">{t.project.recent}</span>
						<span class="recent-chips">
							{#each recent as path (path)}
								<button
									type="button"
									class="btn-chip recent-chip"
									class:active={dir === path}
									title={path}
									onclick={() => {
										dir = path;
										error = null;
									}}
								>{tildePath(path)}</button>
							{/each}
						</span>
					</div>
				{/if}
				<p class="muted field-hint">{t.project.dirHint}</p>
				{#if error}
					<p class="field-error" data-project-error>{error === 'invalid' ? t.project.dirInvalid : t.sidebar.saveFailed}</p>
				{/if}
				<div>
					<Button variant="primary" disabled={pending || !dir.trim()} onclick={() => void start()}>{t.project.start}</Button>
				</div>
			</div>
			<div class="modal-section carry" data-project-import>
				<span class="field-head">{t.project.carryHead}</span>
				<ImportClaudeSession {runtime} {t} {items} {loadFailed} />
			</div>
		</div>
	</div>
</div>

<style>
	.modal-dialog.project-session-modal {
		width: 520px;
		max-width: 95vw;
		max-height: 88vh;
	}

	.dir-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.dir-row :global(input) {
		flex: 1;
		min-width: 0;
	}

	.recent {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 8px;
	}

	.recent-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.recent-chip {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.carry {
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}

	@media (max-width: 680px) {
		.dir-row {
			flex-direction: column;
			align-items: stretch;
		}

		.recent-chip {
			min-height: 36px;
		}
	}
</style>
