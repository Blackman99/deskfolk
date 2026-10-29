<script lang="ts">
	import { tick } from 'svelte';
	import type { Bot, ProjectAgent, SessionSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import AgentAvatar from './AgentAvatar.svelte';
	import SessionRow from './SessionRow.svelte';
	import type { SessionStatusResult } from './session-status.ts';

	/**
	 * One project session under its directory (ADR 0095), the size of a Bot's row and saying the same:
	 * its agent's mark, its name and time, the run's status or else the last line, and the unread
	 * count. The mark is the session's, not the directory's: one directory can hold sessions of
	 * different agents. Renaming turns the row into a name field of the same height.
	 */
	type Props = {
		session: SessionSummary;
		t: Copy;
		/** The open conversation. */
		on: boolean;
		/** The row the context menu belongs to. */
		contextOpen: boolean;
		title: string;
		/** The agent it runs: its mark leads the row. */
		agent: ProjectAgent;
		/** Its own name; null while your first line has not named it yet. */
		name?: string | null;
		/** The row is a name field: Enter or leaving it saves, Escape leaves the name as it was. */
		renaming?: boolean;
		/** The new name, or null to leave it; false when it did not go through, so the field stays. */
		onRename?: (name: string | null) => Promise<boolean>;
		time: string;
		/** The run at work or waiting on you in it, said as a Bot's turn would be. */
		status: SessionStatusResult;
		preview: string;
		unread: number;
		bots: ReadonlyMap<string, Bot>;
		botStatus: (botId: string) => SessionStatusResult | undefined;
		onSelect: () => void;
		onContextMenu: (e: MouseEvent) => void;
		/** A press that may become a drag into the workbench: only where there is one. */
		onPointerDown?: (e: PointerEvent) => void;
	};

	let { session, t, on, contextOpen, title, agent, name = null, renaming = false, onRename, time, status, preview, unread, bots, botStatus, onSelect, onContextMenu, onPointerDown }: Props = $props();

	let field = $state<HTMLInputElement | null>(null);
	let draft = $state('');
	let failed = $state(false);
	/** Enter and the blur that follows it are one save, not two; Escape's blur saves nothing. */
	let saving = false;
	let done = false;

	$effect(() => {
		if (!renaming) return;
		draft = name ?? '';
		failed = false;
		done = false;
		void tick().then(() => {
			field?.focus();
			field?.select();
		});
	});

	async function commit(): Promise<void> {
		if (saving || done || !onRename) return;
		const next = draft.trim();
		saving = true;
		// Blank or unchanged leaves the name as it was.
		const ok = await onRename(next && next !== (name ?? '') ? next : null);
		saving = false;
		done = ok;
		failed = !ok;
		if (!ok) field?.focus();
	}
</script>

{#if renaming}
	<div class="project-rename" class:is-on={on} data-project-session data-renaming>
		<AgentAvatar {agent} title={t.project.agentNames[agent]} />
		<input
			bind:this={field}
			class="rename-field"
			type="text"
			value={draft}
			maxlength="200"
			placeholder={t.project.untitled}
			aria-label={t.project.renameLabel}
			aria-invalid={failed}
			title={failed ? t.project.renameFailed : undefined}
			oninput={(event) => {
				draft = event.currentTarget.value;
				failed = false;
			}}
			onkeydown={(event) => {
				// Enter that confirms an input method's candidate is the input method's.
				if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
					event.preventDefault();
					void commit();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					done = true;
					void onRename?.(null);
				}
			}}
			onblur={() => void commit()}
		/>
		<span class="rename-preview">{preview}</span>
	</div>
{:else}
	<SessionRow
		{session}
		{t}
		{on}
		{contextOpen}
		{agent}
		{title}
		{time}
		{status}
		{preview}
		{unread}
		{bots}
		{botStatus}
		{onSelect}
		{onContextMenu}
		{onPointerDown}
	/>
{/if}

<style>
	/* The row it stands in for, line for line, so starting a rename moves nothing below it. */
	.project-rename {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr);
		grid-template-rows: auto auto;
		gap: 2px 10px;
		align-items: center;
		padding: 8px 10px;
		margin: 1px 0;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
	}

	.project-rename.is-on {
		background: var(--pane);
		border-color: var(--line);
		box-shadow: var(--shadow-sm);
	}

	.project-rename :global(.row-avatar) {
		--avatar-ring: var(--pane);
	}

	.rename-field {
		grid-column: 2;
		grid-row: 1;
		min-width: 0;
		/* The title's line: 14px at 1.5. */
		height: 21px;
		padding: 0 6px;
		margin-left: -7px;
		border: 1px solid var(--field-focus-border);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		outline: none;
		box-shadow: var(--field-focus-ring);
	}

	.rename-field[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.rename-preview {
		grid-column: 2;
		grid-row: 2;
		min-width: 0;
		min-height: 1.4em;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	@media (max-width: 680px) {
		.project-rename {
			grid-template-columns: 48px minmax(0, 1fr);
			gap: 3px 12px;
			padding: 10px 14px;
			margin: 0;
			border: 0;
			border-radius: 0;
		}

		.project-rename.is-on {
			background: var(--accent-tint);
			box-shadow: none;
		}

		.project-rename :global(.row-avatar) {
			--avatar-size: 48px;
		}

		.rename-field {
			height: 24px;
			font-size: 16px;
		}

		.rename-preview {
			font-size: 13px;
			line-height: 1.35;
		}
	}
</style>
