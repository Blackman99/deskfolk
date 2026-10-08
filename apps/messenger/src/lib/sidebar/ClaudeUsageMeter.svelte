<script lang="ts">
	import { untrack } from 'svelte';
	import type { ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { localeTag } from '../locale-tag.ts';
	import ClaudeUsageRows from '../settings/ClaudeUsageRows.svelte';
	import {
		CLAUDE_USAGE_POLL_MS,
		claudeAgentInUse,
		headlineWindows,
		usageAccountLabel,
		usageAccountNote,
		usageAccountShortLabels,
		usageAccounts,
		usageLevel,
		usagePercentText
	} from '../settings/claude-usage.ts';

	/**
	 * Your Claude plan's usage above the list's foot (ADR 0061), once a Bot runs on Claude Agent: the
	 * plan's 5-hour and 7-day windows at a glance, every window and when it starts over when opened.
	 * With Bots on more than one Claude account, a line for each, named by its email.
	 * Asked every few minutes while the window is in front; the daemon keeps answers as long.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** How tall the strip stands, 0 while it is away: the phone's + button keeps clear of it. */
		height?: number;
	}

	let { runtime, t, height = $bindable(0) }: Props = $props();
	let measured = $state(0);

	let usage = $state<ClaudeUsage | null>(null);
	let open = $state(false);
	let busy = $state(false);
	let now = $state(Date.now());

	const inUse = $derived(claudeAgentInUse(runtime.snapshot.bots));
	const client = $derived(runtime.connection === 'connected' ? runtime.client : null);
	const locale = $derived(localeTag(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh'));
	const shown = $derived(inUse && usage ? usageAccounts(usage).filter((account) => account.available || account.reason === 'signed_out' || account.reason === 'failed') : []);
	const several = $derived(shown.length > 1);
	const visible = $derived(shown.some((account) => account.available));
	$effect(() => {
		height = visible ? measured : 0;
	});
	const shortLabels = $derived(usageAccountShortLabels(shown, t));

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

{#if visible}
	<section class="usage-meter" class:is-open={open} class:is-several={several} aria-label={t.claudeAgent.usage.title} data-claude-usage bind:clientHeight={measured}>
		<button
			type="button"
			class="usage-summary"
			aria-expanded={open}
			aria-label={open ? t.claudeAgent.usage.collapse : t.claudeAgent.usage.expand}
			onclick={() => (open = !open)}
		>
			{#each shown as account, index (account.config_dir ?? '')}
				<span class="usage-line" data-usage-account={account.config_dir ?? ''}>
					<span class="usage-title" title={several ? usageAccountLabel(account, t) : undefined}>{several ? shortLabels[index] : 'Claude'}</span>
					{#if account.available}
						{#each headlineWindows(account) as window (window.kind)}
							<span class="usage-chip is-{usageLevel(window.percent)}" data-usage-chip={window.kind}>
								<span class="usage-chip-label">{window.kind === 'five_hour' ? t.claudeAgent.usage.fiveHourShort : t.claudeAgent.usage.sevenDayShort}</span>
								<span class="usage-chip-bar" aria-hidden="true"><span style:width="{window.percent}%"></span></span>
								<span class="usage-chip-percent">{usagePercentText(window.percent)}</span>
							</span>
						{/each}
					{:else}
						<span class="usage-line-note">{usageAccountNote(account, t)}</span>
					{/if}
					{#if index === 0}
						<svg class="usage-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="m18 15-6-6-6 6"></path>
						</svg>
					{:else}
						<!-- The caret's room on the other lines too, so the columns line up. -->
						<span class="usage-caret usage-caret-room" aria-hidden="true"></span>
					{/if}
				</span>
			{/each}
		</button>
		{#if open}
			<div class="usage-detail">
				{#each shown as account, index (account.config_dir ?? '')}
					{#if several}
						<p class="usage-detail-account">{usageAccountLabel(account, t)}</p>
					{/if}
					{#if account.available}
						<ClaudeUsageRows usage={account} {t} {locale} {now} {busy}
							onRefresh={index === shown.length - 1 ? () => client && void load(client, true) : undefined} />
					{:else}
						<p class="usage-detail-note">{usageAccountNote(account, t)}</p>
					{/if}
				{/each}
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
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: 4px;
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

	.usage-line {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.usage-title {
		color: var(--ink);
		font-weight: 600;
		flex-shrink: 0;
	}

	/* Several accounts: the names line up in one column, cut short when the list is narrow. */
	.usage-meter.is-several .usage-title {
		flex: 0 1 4.5em;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-line-note {
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.usage-detail-account {
		margin: 8px 0 6px;
		font: 600 12px/1.3 var(--font);
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.usage-detail-account:first-child {
		margin-top: 0;
	}

	.usage-detail-note {
		margin: 0 0 4px;
		font-size: 12px;
		color: var(--muted);
	}

	.usage-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		white-space: nowrap;
	}

	/* Short of room, the name gives way, never the numbers. */
	.usage-meter.is-several .usage-chip {
		flex-shrink: 0;
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

	.usage-caret-room {
		width: 12px;
	}

	.usage-detail {
		padding: 2px 12px 10px;
	}

	/* With a name on each line, a list as narrow as the desktop's drops the little bars sooner. */
	@container usage-meter (max-width: 299px) {
		.usage-meter.is-several .usage-chip-bar {
			display: none;
		}
	}

	/* A narrow list keeps the words and numbers and drops the little bars. */
	@container usage-meter (max-width: 239px) {
		.usage-line {
			gap: 8px;
		}

		.usage-chip-bar {
			display: none;
		}
	}
</style>
