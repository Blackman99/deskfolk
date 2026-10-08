<script lang="ts">
	import { untrack } from 'svelte';
	import type { ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { localeTag } from '../locale-tag.ts';
	import ClaudeSpark from '../settings/ClaudeSpark.svelte';
	import ClaudeUsageAccounts from '../settings/ClaudeUsageAccounts.svelte';
	import ClaudeUsageRows from '../settings/ClaudeUsageRows.svelte';
	import {
		CLAUDE_USAGE_POLL_MS,
		claudeAgentInUse,
		usageAccountLabel,
		usageAccountNote,
		usageAccountShortLabels,
		usageAccounts,
		usageLeftText,
		usageLevel
	} from '../settings/claude-usage.ts';

	/**
	 * Your Claude plan's usage above the list's foot (ADR 0061), once a Bot runs on Claude Agent,
	 * under Claude's mark: how much of the plan's 5-hour and 7-day windows is left at a glance, every
	 * window and when it starts over when opened. With Bots on more than one Claude account, a line
	 * for each, named by its plan or email. Asked every few minutes while the window is in front;
	 * the daemon keeps answers as long.
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
			<!-- One grid, every line the same cells (mark, name, 5-hour, 7-day, caret), so the columns line up. -->
			{#each shown as account, index (account.config_dir ?? '')}
				<span class="usage-line" data-usage-account={account.config_dir ?? ''}>
					<span class="usage-mark">{#if index === 0}<ClaudeSpark size={14} />{/if}</span>
					{#if several}
						<span class="usage-title" title={usageAccountLabel(account, t)}>{shortLabels[index]}</span>
					{/if}
					{#if account.available}
						{#each ['five_hour', 'seven_day'] as const as kind (kind)}
							{@const window = account.windows.find((entry) => entry.kind === kind)}
							{#if window}
								<span class="usage-chip is-{usageLevel(window.percent)}" data-usage-chip={kind}>
									<span class="usage-chip-label">{kind === 'five_hour' ? t.claudeAgent.usage.fiveHourShort : t.claudeAgent.usage.sevenDayShort}</span>
									<span class="usage-chip-percent">{t.claudeAgent.usage.left(usageLeftText(window.percent))}</span>
								</span>
							{:else}
								<span class="usage-chip" aria-hidden="true"></span>
							{/if}
						{/each}
					{:else}
						<span class="usage-line-note">{usageAccountNote(account, t)}</span>
					{/if}
					{#if index === 0}
						<svg class="usage-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="m18 15-6-6-6 6"></path>
						</svg>
					{:else}
						<span class="usage-caret" aria-hidden="true"></span>
					{/if}
				</span>
			{/each}
		</button>
		{#if open}
			<div class="usage-detail">
				{#if several}
					<ClaudeUsageAccounts accounts={shown} {t} {locale} {now} {busy} onRefresh={() => client && void load(client, true)} />
				{:else}
					<ClaudeUsageRows usage={shown[0]!} {t} {locale} {now} {busy} onRefresh={() => client && void load(client, true)} />
				{/if}
			</div>
		{/if}
	</section>
{/if}

<style>
	.usage-meter {
		border-top: 1px solid var(--line);
		background: var(--glass-footer);
		position: relative;
		z-index: 20;
	}

	.usage-summary {
		display: grid;
		/* Mark, 5-hour, 7-day, then the caret pushed to the end. */
		grid-template-columns: 14px max-content max-content minmax(12px, 1fr);
		align-items: center;
		column-gap: 10px;
		row-gap: 5px;
		width: 100%;
		min-height: 32px;
		padding: 7px 12px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font: 500 11px/1 var(--font);
		cursor: pointer;
		text-align: left;
	}

	/* Several accounts: a name after the mark, cut short before any number is. */
	.usage-meter.is-several .usage-summary {
		grid-template-columns: 14px minmax(0, max-content) max-content max-content minmax(12px, 1fr);
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
		display: contents;
	}

	.usage-mark {
		display: flex;
		align-items: center;
		width: 14px;
		height: 14px;
	}

	.usage-title {
		min-width: 0;
		color: var(--ink);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-chip {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
		white-space: nowrap;
	}

	.usage-chip-percent {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.usage-chip.is-warn .usage-chip-percent {
		color: var(--warn-text);
	}

	.usage-chip.is-danger .usage-chip-percent {
		color: var(--danger-text);
	}

	/* A line without windows says why across both of their columns. */
	.usage-line-note {
		grid-column: span 2;
		min-width: 0;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-caret {
		justify-self: end;
		width: 12px;
		transform: rotate(180deg);
	}

	.usage-meter.is-open .usage-caret {
		transform: none;
	}

	.usage-detail {
		padding: 2px 12px 10px;
	}

</style>
