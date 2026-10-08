<script lang="ts">
	import { untrack } from 'svelte';
	import type { ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { localeTag } from '../locale-tag.ts';
	import ClaudeUsageRows from '../settings/ClaudeUsageRows.svelte';
	import { CLAUDE_USAGE_POLL_MS, claudeAgentInUse, headlineWindows, usageLevel, usagePercentText } from '../settings/claude-usage.ts';

	/**
	 * Your Claude plan's usage above the list's foot (ADR 0061), once a Bot runs on Claude Agent: the
	 * plan's 5-hour and 7-day windows at a glance, every window and when it starts over when opened.
	 * Asked every few minutes while the window is in front; the daemon keeps answers as long.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
	}

	let { runtime, t }: Props = $props();

	let usage = $state<ClaudeUsage | null>(null);
	let open = $state(false);
	let busy = $state(false);
	let now = $state(Date.now());

	const inUse = $derived(claudeAgentInUse(runtime.snapshot.bots));
	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const locale = $derived(localeTag(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'));
	const shown = $derived(inUse && usage?.available ? usage : null);

	async function load(api: MessengerApi, refresh: boolean): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			usage = await api.claudeUsage(refresh);
		} catch {
			// An older daemon has no such route; the meter stays away rather than showing a failure.
		} finally {
			busy = false;
			now = Date.now();
		}
	}

	$effect(() => {
		const api = client;
		if (!api || !inUse) return;
		let last = 0;
		const tick = () => {
			now = Date.now();
			if (document.visibilityState !== 'visible' || now - last < CLAUDE_USAGE_POLL_MS) return;
			last = now;
			void load(api, false);
		};
		// `load` reads and writes state of its own: tracked, every answer would set off the next ask.
		untrack(tick);
		const timer = setInterval(tick, 60_000);
		document.addEventListener('visibilitychange', tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', tick);
		};
	});
</script>

{#if shown}
	<section class="usage-meter" class:is-open={open} aria-label={t.claudeAgent.usage.title} data-claude-usage>
		<button
			type="button"
			class="usage-summary"
			aria-expanded={open}
			aria-label={open ? t.claudeAgent.usage.collapse : t.claudeAgent.usage.expand}
			onclick={() => (open = !open)}
		>
			<span class="usage-title">Claude</span>
			{#each headlineWindows(shown) as window (window.kind)}
				<span class="usage-chip is-{usageLevel(window.percent)}" data-usage-chip={window.kind}>
					<span class="usage-chip-label">{window.kind === 'five_hour' ? t.claudeAgent.usage.fiveHourShort : t.claudeAgent.usage.sevenDayShort}</span>
					<span class="usage-chip-bar" aria-hidden="true"><span style:width="{window.percent}%"></span></span>
					<span class="usage-chip-percent">{usagePercentText(window.percent)}</span>
				</span>
			{/each}
			<svg class="usage-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="m18 15-6-6-6 6"></path>
			</svg>
		</button>
		{#if open}
			<div class="usage-detail">
				<ClaudeUsageRows usage={shown} {t} {locale} {now} {busy} onRefresh={() => client && void load(client, true)} />
			</div>
		{/if}
	</section>
{/if}

<style>
	.usage-meter {
		border-top: 1px solid var(--line);
		background: var(--glass-footer);
		container: usage-meter / inline-size;
		position: relative;
		z-index: 20;
	}

	.usage-summary {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 32px;
		padding: 6px 12px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font: 500 11px/1 var(--font);
		cursor: pointer;
		text-align: left;
	}

	.usage-summary:hover {
		color: var(--ink);
		background: var(--btn-secondary-hover);
	}

	.usage-summary:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--accent-glow);
	}

	.usage-title {
		color: var(--ink);
		font-weight: 600;
		flex-shrink: 0;
	}

	.usage-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		white-space: nowrap;
	}

	.usage-chip-bar {
		width: 28px;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--line);
		overflow: hidden;
		flex-shrink: 0;
	}

	.usage-chip-bar > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--muted);
	}

	.usage-chip-percent {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.usage-chip.is-warn .usage-chip-bar > span {
		background: var(--warn);
	}

	.usage-chip.is-warn .usage-chip-percent {
		color: var(--warn-text);
	}

	.usage-chip.is-danger .usage-chip-bar > span {
		background: var(--danger);
	}

	.usage-chip.is-danger .usage-chip-percent {
		color: var(--danger-text);
	}

	.usage-caret {
		margin-left: auto;
		flex-shrink: 0;
		transform: rotate(180deg);
	}

	.usage-meter.is-open .usage-caret {
		transform: none;
	}

	.usage-detail {
		padding: 2px 12px 10px;
	}

	/* A narrow list keeps the words and numbers and drops the little bars. */
	@container usage-meter (max-width: 239px) {
		.usage-summary {
			gap: 8px;
		}

		.usage-chip-bar {
			display: none;
		}
	}
</style>
