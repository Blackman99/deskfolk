<script lang="ts">
	import type { AgentRunApproval } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
	import IconButton from '../IconButton.svelte';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { Copy } from '../copy.ts';
	import { holdFullscreenPreview } from '../overlays/fullscreen-preview.ts';
	import { dragRegion } from '../window-chrome.ts';

	/**
	 * The plan Claude Code asks you to approve in plan mode (ADR 0098), where a run's approval card
	 * goes: the plan as it wrote it, then approve — it gets to work, plan mode off — or keep planning.
	 * A line you send meanwhile is what to change, so the card says to just write it below. A long
	 * plan can take the whole window to be read, its buttons still under it.
	 */
	type Props = {
		t: Copy;
		approval: AgentRunApproval;
		disabled: boolean;
		onAnswer: (allow: boolean) => void;
		onOpenPath: (path: string) => void;
	};

	let { t, approval, disabled, onAnswer, onOpenPath }: Props = $props();

	let card = $state<HTMLElement | null>(null);
	let body = $state<HTMLElement | null>(null);
	let full = $state(false);
	/** The card's height in the conversation, held while it is out of it, so the transcript under the window does not move. */
	let held = $state(0);

	function enter(): void {
		held = card?.offsetHeight ?? 0;
		full = true;
	}

	/** Answering and opening a file land behind the whole window, so both leave it first. */
	function answer(allow: boolean): void {
		full = false;
		onAnswer(allow);
	}

	function openPath(path: string): void {
		full = false;
		onOpenPath(path);
	}

	$effect(() => {
		if (!full) return;
		return holdFullscreenPreview(() => {
			full = false;
		});
	});

	// Into the top layer, where no pane's transform or clipping reaches it, as a preview's full view
	// goes. The node stays where it is, so the plan keeps its place and is not drawn again.
	$effect(() => {
		const el = card;
		if (!el || !full) return;
		const previous = document.activeElement as HTMLElement | null;
		if (typeof el.showPopover === 'function') {
			el.setAttribute('popover', 'manual');
			el.showPopover();
		}
		// The arrow keys and space scroll the plan.
		body?.focus({ preventScroll: true });
		return () => {
			if (typeof el.hidePopover === 'function' && el.hasAttribute('popover')) {
				if (el.isConnected) el.hidePopover();
				el.removeAttribute('popover');
			}
			// Only now: with neither the card nor this in the conversation for a moment, the transcript
			// would be shorter and its scroll position would not come back.
			held = 0;
			previous?.focus?.({ preventScroll: true });
		};
	});
</script>

<article bind:this={card} class="plan-card" class:is-full={full} data-agent-approval data-plan-card>
	<div class="plan-head" data-tauri-drag-region={full ? dragRegion : undefined}>
		<Icon name="list" size={12} />
		<span>{t.project.planHead}</span>
		<span class="plan-who">{t.project.agentNames.claude_code}</span>
		{#if approval.summary.trim()}
			<IconButton
				class="plan-full-toggle"
				size="xs"
				icon={full ? 'minimize' : 'maximize'}
				label={full ? t.project.planExitFullscreen : t.project.planFullscreen}
				pressed={full}
				data-plan-full-toggle
				onclick={() => (full ? (full = false) : enter())}
			/>
		{/if}
	</div>
	<div bind:this={body} class="plan-body" tabindex="-1">
		{#if approval.summary.trim()}
			<MarkdownBody source={approval.summary} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} onOpenArtifact={openPath} />
		{:else}
			<p class="plan-empty">{t.project.planEmpty}</p>
		{/if}
	</div>
	<div class="plan-foot">
		<div class="plan-actions">
			<Button variant="primary" icon="check" {disabled} onclick={() => answer(true)}>{t.project.planApprove}</Button>
			<Button {disabled} onclick={() => answer(false)}>{t.project.planKeep}</Button>
		</div>
		<!-- The composer is under the card, not under the whole window. -->
		<span class="plan-hint">{full ? t.project.planHintFull : t.project.planHint}</span>
	</div>
</article>
{#if held > 0}
	<div class="plan-held" style:height="{held}px" aria-hidden="true"></div>
{/if}

<style>
	/* A plan is not a warning: the accent's quiet ring, where an approval card has the warn one. */
	.plan-card {
		overflow: hidden;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-lg);
		background: var(--pane);
		box-shadow:
			0 0 0 3px var(--accent-glow),
			var(--shadow-sm);
	}

	.plan-head {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 9px 16px;
		border-bottom: 1px solid var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: var(--text-caption);
		font-weight: 650;
	}

	.plan-who {
		color: var(--ink-secondary);
		font-weight: 500;
	}

	.plan-who::before {
		content: '·';
		margin-right: 6px;
		color: var(--muted-light);
	}

	/* Beside the head's words, without making the head taller than they do. */
	.plan-head > :global(.plan-full-toggle) {
		margin: -4px -8px -4px auto;
	}

	/* A long plan scrolls in the card; the buttons stay in sight under it. */
	.plan-body {
		max-height: min(420px, 55vh);
		overflow-y: auto;
		padding: 12px 16px;
		overscroll-behavior: contain;
		outline: none;
	}

	.plan-empty {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}

	.plan-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding: 10px 16px 14px;
		border-top: 1px solid var(--line-subtle);
	}

	.plan-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.plan-hint {
		font-size: 12px;
		color: var(--muted);
	}

	/*
	 * The whole window, edge to edge; everything a popover brings by default is undone here. The
	 * z-index is for a browser with no top layer: under the toasts (1200) and a file's preview.
	 */
	.plan-card.is-full {
		--reading-width: 760px;
		position: fixed;
		inset: 0;
		z-index: 1100;
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100dvh;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: 0;
		box-shadow: none;
		color: var(--ink);
	}

	.is-full .plan-head {
		flex-shrink: 0;
		box-sizing: border-box;
		/* Level with the traffic lights, whose centre line is at 26pt. */
		min-height: 52px;
		padding-top: max(9px, env(safe-area-inset-top));
	}

	/* On macOS the window's traffic lights take the start of the row (`window-chrome.ts`). */
	:global(:root[data-chrome='mac']) .plan-card.is-full .plan-head {
		padding-left: 84px;
	}

	/* This head is tall enough for it, and the window's edge needs the margin the card's did not. */
	.is-full .plan-head > :global(.plan-full-toggle) {
		margin-block: 0;
		margin-right: 0;
	}

	.is-full .plan-body {
		flex: 1;
		min-height: 0;
		max-height: none;
		padding: 24px;
	}

	.is-full .plan-body > :global(.md-body) {
		max-width: var(--reading-width);
		margin-inline: auto;
	}

	/* The buttons start where the plan's lines do. */
	.is-full .plan-foot {
		flex-shrink: 0;
		padding-inline: max(24px, calc((100% - var(--reading-width)) / 2));
		padding-bottom: max(14px, env(safe-area-inset-bottom));
	}
</style>
