<script lang="ts">
	import type { Locale } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { copyText } from '../clipboard.ts';
	import { openExternalLink } from '../open-link.ts';
	import { RELAY_GUIDE_COMMANDS, relayGuideUrl, type RelayGuideStep } from './relay-guide.ts';

	type Props = { t: Copy; locale: Locale };

	let { t, locale }: Props = $props();

	/** The block whose button last copied; one at a time, like the pairing code's. */
	let copied = $state<RelayGuideStep | null>(null);

	/** Step 4 is the form below, so it has words and no command. */
	const steps = $derived<{ text: string; command?: RelayGuideStep; note?: string }[]>([
		{ text: t.remote.relayGuidePrepare, command: 'prepare' },
		{ text: t.remote.relayGuideEnv, command: 'env' },
		{ text: t.remote.relayGuideUp, command: 'up', note: t.remote.relayGuideUpNote },
		{ text: t.remote.relayGuideFill },
		{ text: t.remote.relayGuidePairingOff, command: 'pairingOff' }
	]);
</script>

<!-- Closed by default: most people opening this card already run a relay and only need the form. -->
<details class="relay-guide" data-testid="relay-guide">
	<summary>{t.remote.relayGuideSummary}</summary>
	<div class="relay-guide-body">
		<p class="relay-guide-lead">{t.remote.relayGuideLead}</p>
		<ol class="relay-guide-steps">
			{#each steps as step, index (index)}
				<li>
					<p class="relay-guide-text">{step.text}</p>
					{#if step.command}
						{@const command = step.command}
						<div class="relay-guide-command">
							<pre class="mono" data-testid={`relay-guide-${command}`}>{RELAY_GUIDE_COMMANDS[command]}</pre>
							<button
								type="button"
								class="btn-xs"
								onclick={() => {
									copyText(RELAY_GUIDE_COMMANDS[command]);
									copied = command;
								}}
							>
								{copied === command ? t.chat.copied : t.remote.relayGuideCopy}
							</button>
						</div>
					{/if}
					{#if step.note}<p class="relay-guide-note">{step.note}</p>{/if}
				</li>
			{/each}
		</ol>
		<div class="relay-guide-more">
			<button type="button" class="btn-xs" onclick={() => void openExternalLink(relayGuideUrl(locale))}>
				{t.remote.relayGuideFull}
			</button>
			<p class="relay-guide-note">{t.remote.relayGuideFullNote}</p>
		</div>
	</div>
</details>

<style>
	.relay-guide {
		min-width: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.relay-guide summary {
		cursor: pointer;
		padding: 8px 12px;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent);
		list-style: none;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.relay-guide summary::-webkit-details-marker {
		display: none;
	}

	.relay-guide summary::before {
		content: '';
		width: 6px;
		height: 6px;
		border-right: 1.5px solid currentColor;
		border-bottom: 1.5px solid currentColor;
		transform: rotate(-45deg);
		transition: transform 0.15s ease;
		flex-shrink: 0;
	}

	.relay-guide[open] summary::before {
		transform: rotate(45deg);
	}

	.relay-guide-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 0 12px 12px;
	}

	.relay-guide-lead,
	.relay-guide-text {
		margin: 0;
		font-size: 13px;
		line-height: 1.55;
		color: var(--ink-secondary);
	}

	.relay-guide-text {
		color: var(--ink);
	}

	.relay-guide-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.relay-guide-steps {
		counter-reset: relay-guide-step;
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.relay-guide-steps li {
		counter-increment: relay-guide-step;
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding-left: 26px;
		position: relative;
	}

	.relay-guide-steps li::before {
		content: counter(relay-guide-step);
		position: absolute;
		left: 0;
		top: 1px;
		width: 18px;
		height: 18px;
		border-radius: var(--radius-full);
		border: 1px solid var(--line);
		background: var(--sidebar-bg);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* Commands keep their lines: a wrapped shell line pastes as two. The block scrolls instead. */
	.relay-guide-command {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
	}

	.relay-guide-command pre {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink-secondary);
		font-size: 11px;
		line-height: 1.55;
		white-space: pre;
		overflow-x: auto;
	}

	.relay-guide-command .btn-xs {
		flex-shrink: 0;
	}

	.relay-guide-more {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
	}
</style>
