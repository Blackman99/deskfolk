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
		usageAccountDetail,
		usageAccountLabel,
		usageAccountNote,
		usageAccountShortLabels,
		usageAccounts,
		usageLeft,
		usageLeftText,
		usageLevel
	} from '../settings/claude-usage.ts';

	/**
	 * Your Claude plan's usage above the list's foot (ADR 0061), once a Bot runs on Claude Agent,
	 * under Claude's mark: how much of the plan's 5-hour and 7-day windows is left at a glance, every
	 * window and when it starts over when opened. With Bots on more than one Claude account, each named
	 * by its plan or email, one line each. Where the strip is wide enough, the account's email follows
	 * the name and each window has a small ring as full as what is left. Asked every few minutes
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
	const details = $derived(shown.map((account, index) => usageAccountDetail(account, shortLabels[index] ?? '')));
	const hasInfo = $derived(details.some((detail) => detail !== null));

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
	<section class="usage-meter" class:is-open={open} class:is-several={several} class:has-info={hasInfo} aria-label={t.claudeAgent.usage.title} data-claude-usage bind:clientHeight={measured}>
		<button
			type="button"
			class="usage-summary"
			aria-expanded={open}
			aria-label={open ? t.claudeAgent.usage.collapse : t.claudeAgent.usage.expand}
			onclick={() => (open = !open)}
		>
			<!-- One line per account, columns aligned. A wide strip adds the email and a ring on each window. -->
			<span class="usage-mark"><ClaudeSpark size={14} /></span>
			<span class="usage-accounts">
				{#each shown as account, index (account.config_dir ?? '')}
					<span class="usage-line" data-usage-account={account.config_dir ?? ''}>
						<span class="usage-title" title={usageAccountLabel(account, t)}>{shortLabels[index]}</span>
						{#if hasInfo}
							<span class="usage-info" title={details[index] ?? ''}>{details[index] ?? ''}</span>
						{/if}
						{#if account.available}
							<span class="usage-windows">
								{#each ['five_hour', 'seven_day'] as const as kind (kind)}
									{@const window = account.windows.find((entry) => entry.kind === kind)}
									{#if window}
										<span class="usage-chip is-{usageLevel(window.percent)}" data-usage-chip={kind}>
											<span class="usage-chip-label">{kind === 'five_hour' ? t.claudeAgent.usage.fiveHourShort : t.claudeAgent.usage.sevenDayShort}</span>
											<!-- A fixed ring, not a bar: it must not take the width the email uses. -->
											<svg class="usage-chip-ring" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
												<circle cx="6" cy="6" r="4.25" fill="none" stroke="var(--line)" stroke-width="1.75" />
												<circle class="usage-ring-fill" cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset={100 - usageLeft(window.percent)} transform="rotate(-90 6 6)" />
											</svg>
											<span class="usage-chip-percent">{t.claudeAgent.usage.left(usageLeftText(window.percent))}</span>
										</span>
									{:else}
										<span class="usage-chip" aria-hidden="true"></span>
									{/if}
								{/each}
							</span>
						{:else}
							<span class="usage-line-note">{usageAccountNote(account, t)}</span>
						{/if}
					</span>
				{/each}
			</span>
			<svg class="usage-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="m18 15-6-6-6 6"></path>
			</svg>
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
		container: usage / inline-size;
	}

	.usage-summary {
		display: flex;
		align-items: center;
		gap: 10px;
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

	/* Mark, then the windows sharing whatever width is left, caret at the end. */
	.usage-accounts {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(min-content, 1fr) minmax(min-content, 1fr);
		align-items: center;
		column-gap: 10px;
		row-gap: 5px;
		min-width: 0;
	}

	/* Several accounts: a name first, cut short before any number is. */
	.usage-meter.is-several .usage-accounts {
		grid-template-columns: minmax(0, max-content) minmax(min-content, 1fr) minmax(min-content, 1fr);
	}

	.usage-summary:hover {
		color: var(--ink);
		background: var(--btn-secondary-hover);
	}

	.usage-summary:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--accent-glow);
	}

	.usage-line,
	.usage-windows {
		display: contents;
	}

	.usage-mark {
		display: flex;
		align-items: center;
		width: 14px;
		height: 14px;
		flex: none;
	}

	/* The name stays off a single account until the strip is wide enough to say who it is. */
	.usage-title,
	.usage-info {
		display: none;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.usage-meter.is-several .usage-title {
		display: block;
	}

	.usage-title {
		color: var(--ink);
		font-weight: 600;
	}

	.usage-info {
		color: var(--muted);
		font-weight: 400;
	}

	.usage-chip {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		white-space: nowrap;
	}

	/* Hidden on a narrow sidebar, where twelve pixels twice would crowd the numbers out. */
	.usage-chip-ring {
		display: none;
		flex: none;
		width: 12px;
		height: 12px;
		color: var(--muted);
	}

	.usage-chip.is-warn .usage-chip-ring {
		color: var(--warn);
	}

	.usage-chip.is-danger .usage-chip-ring {
		color: var(--danger);
	}

	.usage-chip-percent {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
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
		flex: none;
		width: 12px;
		transform: rotate(180deg);
	}

	.usage-meter.is-open .usage-caret {
		transform: none;
	}

	.usage-detail {
		padding: 2px 12px 10px;
	}

	/*
	 * Wider than a narrow sidebar (a phone, or the list dragged out): the email takes the spare
	 * width, and each window keeps a fixed ring of what is left. One line per account.
	 */
	@container usage (min-width: 300px) {
		.usage-meter .usage-title,
		.usage-meter .usage-info,
		.usage-chip-ring {
			display: block;
		}

		.usage-meter .usage-accounts,
		.usage-meter.is-several .usage-accounts {
			grid-template-columns: minmax(0, max-content) max-content max-content;
		}

		.usage-meter.has-info .usage-accounts,
		.usage-meter.has-info.is-several .usage-accounts {
			grid-template-columns: minmax(0, max-content) minmax(0, 1fr) max-content max-content;
		}
	}

</style>
