<script lang="ts">
	import { untrack } from 'svelte';
	import type { AgentUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import {
		AGENT_USAGE_POLL_MS,
		agentHasWindows,
		agentTokenText,
		agentUsageNames,
		agentWindowLabel,
		agentWindowsSorted
	} from '../settings/agent-usage.ts';
	import { usageLeft, usageLeftText, usageLevel } from '../settings/claude-usage.ts';

	/**
	 * Your other local agents' usage under Claude's strip (ADR 0079), for the agents something runs
	 * on: where the agent reports its plan's windows (Codex), what is left of each, as Claude's strip
	 * says it; for the others what this app's own records hold of them today, never a percentage the
	 * agent did not give. Nothing at all while there is nothing to show. Asked every few minutes
	 * while the window is in front; the daemon keeps answers as long.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** How tall the strip stands, 0 while it is away: the phone's + button keeps clear of it. */
		height?: number;
	}

	let { runtime, t, height = $bindable(0) }: Props = $props();
	let measured = $state(0);

	let items = $state<AgentUsage[]>([]);
	let busy = false;
	/** A daemon older than ADR 0079 has no such route: ask no more. */
	let unsupported = false;

	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const names = $derived(agentUsageNames(items, t));
	$effect(() => {
		height = items.length > 0 ? measured : 0;
	});

	async function load(api: MessengerApi): Promise<void> {
		if (busy || unsupported) return;
		busy = true;
		try {
			items = (await api.agentUsage(false)).items;
		} catch (error) {
			if ((error as { status?: number } | null)?.status === 404) unsupported = true;
			// Any other failure leaves what was shown; the next ask tries again.
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		const api = client;
		if (!api) return;
		let last = 0;
		const tick = () => {
			const now = Date.now();
			if (document.visibilityState !== 'visible' || now - last < AGENT_USAGE_POLL_MS) return;
			last = now;
			void load(api);
		};
		// `load` writes state of its own: tracked, every answer would set off the next ask.
		untrack(tick);
		const timer = setInterval(tick, 60_000);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});
</script>

{#if items.length > 0}
	<section class="agent-usage" aria-label={t.agents.usage.title} data-agent-usage bind:clientHeight={measured}>
		<ul>
			{#each items as item, index (`${item.runner}:${item.custom_id ?? ''}:${item.config_dir ?? ''}`)}
				<li class="agent-usage-item" data-agent-usage-item={item.runner} data-agent-usage-account={item.config_dir ?? ''}>
					<span class="agent-usage-name" title={names[index]}><AgentLogo runner={item.runner} size={14} /><span class="agent-usage-label">{names[index]}</span></span>
					{#if agentHasWindows(item)}
						<span class="agent-usage-windows">
							{#each agentWindowsSorted(item.windows) as window}
								<span class="agent-usage-window is-{usageLevel(window.percent)}" data-agent-usage-window={window.minutes ?? ''}>
									<span class="agent-usage-window-label">{agentWindowLabel(window.minutes, t)}</span>
									<!-- Filled with what is left, so an empty bar is a window spent. -->
									<span class="agent-usage-bar" aria-hidden="true"><span style:width="{usageLeft(window.percent)}%"></span></span>
									<span class="agent-usage-percent">{t.agents.usage.left(usageLeftText(window.percent))}</span>
								</span>
							{/each}
						</span>
					{:else}
						<span class="agent-usage-today" data-agent-usage-today>{t.agents.usage.today(String(item.today.turns), agentTokenText(item.today.tokens))}</span>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.agent-usage {
		border-top: 1px solid var(--line);
		background: var(--glass-footer);
		position: relative;
		z-index: 20;
		padding: 8px 12px;
		color: var(--muted);
		font: 500 11px/1.3 var(--font);
	}

	/* A name column as wide as the longest name, cut short before any number is. */
	.agent-usage ul {
		display: grid;
		grid-template-columns: minmax(0, max-content) minmax(0, 1fr);
		align-items: center;
		gap: 6px 10px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.agent-usage-item {
		display: contents;
	}

	/* The agent's logo, then its name, cut short on its own so the logo always stays whole. */
	.agent-usage-name {
		display: flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		max-width: calc(9em + 19px);
		color: var(--ink);
		font-weight: 600;
	}

	.agent-usage-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* One window to a column while the strip is wide enough, one to a line when it is not. */
	.agent-usage-windows {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
		gap: 4px 10px;
		min-width: 0;
	}

	.agent-usage-window {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		white-space: nowrap;
	}

	.agent-usage-bar {
		flex: 1 1 16px;
		min-width: 16px;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--line);
		overflow: hidden;
	}

	.agent-usage-bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--muted);
	}

	.agent-usage-window.is-warn .agent-usage-bar > span {
		background: var(--warn);
	}

	.agent-usage-window.is-danger .agent-usage-bar > span {
		background: var(--danger);
	}

	.agent-usage-percent {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}

	.agent-usage-window.is-warn .agent-usage-percent {
		color: var(--warn-text);
	}

	.agent-usage-window.is-danger .agent-usage-percent {
		color: var(--danger-text);
	}

	.agent-usage-today {
		min-width: 0;
		overflow: hidden;
		font-variant-numeric: tabular-nums;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
