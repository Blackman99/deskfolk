<script lang="ts">
	import type { AgentRunApproval } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import Icon from '../Icon.svelte';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { Copy } from '../copy.ts';

	/**
	 * The plan Claude Code asks you to approve in plan mode (ADR 0098), where a run's approval card
	 * goes: the plan as it wrote it, then approve — it gets to work, plan mode off — or keep planning.
	 * A line you send meanwhile is what to change, so the card says to just write it below.
	 */
	type Props = {
		t: Copy;
		approval: AgentRunApproval;
		disabled: boolean;
		onAnswer: (allow: boolean) => void;
		onOpenPath: (path: string) => void;
	};

	let { t, approval, disabled, onAnswer, onOpenPath }: Props = $props();
</script>

<article class="plan-card" data-agent-approval data-plan-card>
	<div class="plan-head">
		<Icon name="list" size={12} />
		<span>{t.project.planHead}</span>
		<span class="plan-who">{t.project.agentName}</span>
	</div>
	<div class="plan-body">
		{#if approval.summary.trim()}
			<MarkdownBody source={approval.summary} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} onOpenArtifact={onOpenPath} />
		{:else}
			<p class="plan-empty">{t.project.planEmpty}</p>
		{/if}
	</div>
	<div class="plan-foot">
		<div class="plan-actions">
			<Button variant="primary" icon="check" {disabled} onclick={() => onAnswer(true)}>{t.project.planApprove}</Button>
			<Button {disabled} onclick={() => onAnswer(false)}>{t.project.planKeep}</Button>
		</div>
		<span class="plan-hint">{t.project.planHint}</span>
	</div>
</article>

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

	/* A long plan scrolls in the card; the buttons stay in sight under it. */
	.plan-body {
		max-height: min(420px, 55vh);
		overflow-y: auto;
		padding: 12px 16px;
		overscroll-behavior: contain;
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
</style>
