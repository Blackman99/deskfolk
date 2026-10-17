<script lang="ts">
	import type { Attachment, SessionSummary } from '@real-bot/protocol';
	import { onMount } from 'svelte';
	import Icon from '../Icon.svelte';
	import SessionAvatar from '../SessionAvatar.svelte';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { modalOut } from '../modal-motion.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { resolveBotDmOrigin } from '../sidebar/bot-dm-source.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import ChatStage from './ChatStage.svelte';

	/**
	 * A Bot↔Bot direct, read in a popup over the conversation it came from (ADR 0091). It is opened
	 * only from the message it hangs under — or a link, a search hit or a notification that names it
	 * — never from the list, and never as a tab: you read that one exchange and close it. The
	 * transcript is the conversation's own, read-only as a Bot↔Bot direct always is. What opens from
	 * inside it (a file, a Bot's profile, a flow) opens where it always does, so the popup steps aside
	 * for it first.
	 */
	let {
		runtime,
		t,
		session,
		onClose,
		onOpenProfile,
		onOpenArtifact,
		onCreateBot
	}: {
		runtime: MessengerRuntime;
		t: Copy;
		session: SessionSummary;
		onClose: () => void;
		onOpenProfile: (botId: string) => void;
		onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;
		onCreateBot: () => void;
	} = $props();

	const backdrop = backdropClick();
	let root = $state<HTMLElement | null>(null);

	const snapshot = $derived(runtime.snapshot);
	const botsById = $derived(new Map(snapshot.bots.map((bot) => [bot.id, bot] as const)));
	const sessionsById = $derived(new Map(snapshot.sessions.map((row) => [row.id, row] as const)));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
	const title = $derived(sessionTitle(session, botsById, rosterLabels));
	const source = $derived(resolveBotDmOrigin(session, sessionsById));

	function titleOf(row: SessionSummary): string {
		return sessionTitle(row, botsById, rosterLabels);
	}

	/** The line it came from: in the conversation under the popup, or in the direct it was opened from. */
	function goToSource(): void {
		if (source.kind !== 'session') return;
		void runtime.selectSession(source.session.id, source.messageId ? { messageId: source.messageId } : undefined);
	}

	onMount(() => {
		root?.focus({ preventScroll: true });
	});

	function menuOpen(): boolean {
		return document.querySelector('[role="menu"]') !== null;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={root}
	class="modal-backdrop page-on-phone bot-dm-backdrop"
	in:pageSlide
	out:modalOut
	role="dialog"
	aria-modal="true"
	aria-labelledby="bot-dm-title"
	tabindex="-1"
	onmousedowncapture={backdrop.press}
	onclick={(event) => {
		if (backdrop.isOutside(event)) onClose();
	}}
	onkeydown={(event) => {
		// A menu or a picker inside the transcript takes its own Escape first. A message's menu
		// listens on the window, after this, so an open one is asked about here.
		if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || menuOpen()) return;
		event.stopPropagation();
		onClose();
	}}
>
	<div class="modal-dialog bot-dm-dialog" data-session-id={session.id}>
		<div class="modal-head">
			<button type="button" class="modal-back" aria-label={t.common.back} onclick={onClose}>
				<Icon name="chevron-left" />
			</button>
			<SessionAvatar {session} bots={botsById} size="sm" />
			<div class="modal-head-titles">
				<h2 id="bot-dm-title">{title}</h2>
				{#if source.kind === 'session'}
					{@const sourceTitle = titleOf(source.session)}
					<button
						type="button"
						class="bot-dm-source"
						title={source.root
							? t.sidebar.botBotSourceRoot(sourceTitle, titleOf(source.root))
							: t.sidebar.botBotSource(sourceTitle)}
						onclick={goToSource}
					>
						<span aria-hidden="true">{source.depth > 0 ? '↳' : '↰'}</span>
						<span class="bot-dm-source-text">{t.sidebar.botBotSource(sourceTitle)}</span>
					</button>
				{:else}
					<span class="bot-dm-source is-static">
						{source.kind === 'missing' ? t.sidebar.botBotSourceMissing : t.sidebar.botBotSourceUnknown}
					</span>
				{/if}
			</div>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="bot-dm-conversation">
			<ChatStage {runtime} {t} selected={session} {onOpenProfile} {onOpenArtifact} {onCreateBot} />
		</div>
	</div>
</div>

<style>
	.bot-dm-dialog {
		width: 760px;
		max-width: 92vw;
		/* Nearly the window's height: a direct is a transcript read top to bottom, a tall window shows more of it. */
		height: min(92dvh, calc(100dvh - 48px));
		min-height: 0;
		overflow: hidden;
	}

	.bot-dm-dialog :global(.modal-head) {
		gap: 10px;
		justify-content: flex-start;
	}

	.bot-dm-dialog :global(.modal-head-titles) {
		flex: 1 1 auto;
		min-width: 0;
	}

	.bot-dm-dialog :global(.modal-head h2) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Under the title, the line it came from; on a phone too, where the subject line is shown anyway. */
	.bot-dm-source {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.3;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
	}

	button.bot-dm-source {
		cursor: pointer;
	}

	button.bot-dm-source:hover {
		color: var(--accent);
	}

	button.bot-dm-source:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.bot-dm-source.is-static {
		opacity: 0.7;
	}

	.bot-dm-source-text {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* The conversation as a pane holds one: it scrolls inside, and a narrow one lays out like a phone. */
	.bot-dm-conversation {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-height: 0;
		min-width: 0;
		container: conversation / inline-size;
	}
</style>
