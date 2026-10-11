<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Attachment, Bot, BuiltinModelRole, Hold, Provider, SessionSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import JobLayout from './JobLayout.svelte';

	/**
	 * The narrow host for the board: a page that fills the screen, with Back to step out of it.
	 *
	 * On a wide window the same `JobLayout` is a pane instead. The board used to carry its own
	 * floating window here — drag the title bar, pull a corner, remember the frame — and that is
	 * gone: a pane that should float is dragged out by its tab, and the workbench owns the one
	 * implementation of a floating frame.
	 */
	interface Props {
		api: MessengerApi | null;
		taskId: string | null;
		/** A line filed under no job, as its own board (ADR 0083). */
		line?: string | null;
		callEditor?: Snippet<[BuiltinModelRole]>;
		focus?: import('./task-trace.ts').TraceFocus | null;
		focusToken?: number;
		sessionId: string;
		activeSessionId: string;
		sessions: readonly SessionSummary[];
		bots: readonly Bot[];
		providers?: readonly Provider[];
		youLabel: string;
		deletedLabel: string;
		workspacePath: string | null;
		t: Copy;
		reloadToken: number;
		onClose: () => void;
		onJump: (sessionId: string, messageId: string) => void;
		onTask?: (taskId: string) => void;
		onOpenArtifact?: (
			relpath: string,
			att?: Attachment,
			messageId?: string | null,
			forceTree?: boolean,
			taskId?: string | null,
			siblings?: Attachment[] | null
		) => void;
		holds?: readonly Hold[] | null;
		onStop?: (choice: import('../chat/stop-menu.ts').StopChoice) => Promise<unknown> | void;
		onLift?: (hold: Hold) => Promise<unknown> | void;
		controlsDisabled?: boolean;
		onOpenRoles?: (playbookId: string) => void;
	}

	let {
		api,
		taskId,
		line = null,
		callEditor,
		focus = null,
		focusToken = 0,
		sessionId,
		activeSessionId,
		sessions,
		bots,
		providers = [],
		youLabel,
		deletedLabel,
		workspacePath,
		t,
		reloadToken,
		onClose,
		onJump,
		onTask,
		onOpenArtifact,
		holds = null,
		onStop,
		onLift,
		controlsDisabled = false,
		onOpenRoles
	}: Props = $props();

</script>

<div
	class="trace-page"
	transition:pageSlide
	role="dialog"
	aria-modal="true"
	aria-label={t.trace.title}
	tabindex="-1"
>
	<JobLayout
		host="page"
		{api}
		{taskId}
		{line}
		{callEditor}
		{focus}
		{focusToken}
		{sessionId}
		{activeSessionId}
		{sessions}
		{bots}
		{providers}
		{youLabel}
		{deletedLabel}
		{workspacePath}
		{t}
		{reloadToken}
		{onClose}
		{onJump}
		{onTask}
		{onOpenArtifact}
		{holds}
		{onStop}
		{onLift}
		{controlsDisabled}
		{onOpenRoles}
	/>
</div>

<style>
	.trace-page {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		background: var(--pane);
	}

	@media (max-width: 680px) {
		.trace-page {
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}
	}
</style>
