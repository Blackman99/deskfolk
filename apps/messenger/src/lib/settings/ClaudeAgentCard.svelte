<script lang="ts">
	import { untrack } from 'svelte';
	import type { ClaudeAccountUsage, ClaudeCodeStatus, ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { localeTag } from '../locale-tag.ts';
	import AgentLogo from './AgentLogo.svelte';
	import { claudeAccountLabel, claudeAgentPaysPerToken } from './claude-agent.ts';
	import { usageAccountNote, usageAccounts, usageCheckedTime, usageLatestCheck } from './claude-usage.ts';
	import ClaudeUsageFoot from './ClaudeUsageFoot.svelte';
	import ClaudeUsageRows from './ClaudeUsageRows.svelte';
	import HelpTip from './HelpTip.svelte';

	/**
	 * Your own Claude Code as the daemon finds it (ADR 0061): where it is, which version, which
	 * account it is signed in with, and the other accounts' config directories a Bot may run on.
	 * Deskfolk only runs it and asks it about itself; signing in is Claude Code's own, in a terminal.
	 */
	export type ClaudeAgentApi = {
		claudeCode: () => Promise<ClaudeCodeStatus>;
		detectClaudeCode: () => Promise<ClaudeCodeStatus>;
		setClaudeCodePath: (path: string | null) => Promise<ClaudeCodeStatus>;
		/** The other accounts' config directories, the whole list; absent from an older client. */
		setClaudeCodeAccounts?: (configDirs: string[]) => Promise<ClaudeCodeStatus>;
		/** Your plan's usage, as that Claude Code reads it; absent from an older client. */
		claudeUsage?: (refresh?: boolean) => Promise<ClaudeUsage>;
	};

	interface Props {
		api: ClaudeAgentApi | null;
		t: Copy;
		locale?: 'zh' | 'en';
		/** Told each status read, so a host (the setup wizard) can wait for a signed-in Claude Code. */
		onstatus?: (status: ClaudeCodeStatus) => void;
	}

	let { api, t, locale = 'zh', onstatus }: Props = $props();

	let status = $state<ClaudeCodeStatus | null>(null);
	let busy = $state(false);
	let failed = $state(false);
	let unavailable = $state(false);
	let pathDraft = $state('');
	let accountDraft = $state('');
	let accountError = $state<'in_use' | 'invalid' | null>(null);
	let usage = $state<ClaudeUsage | null>(null);
	let usageBusy = $state(false);
	let now = $state(Date.now());

	async function run(work: (api: ClaudeAgentApi) => Promise<ClaudeCodeStatus>): Promise<void> {
		if (!api || busy) return;
		busy = true;
		failed = false;
		try {
			status = await work(api);
			unavailable = false;
			pathDraft = status.source === 'setting' && status.path ? status.path : pathDraft;
		} catch (error) {
			// Not there: a phone paired with a Mac on a Deskfolk from before the relay carried it.
			if ((error as { status?: number }).status === 404) unavailable = true;
			else failed = true;
		} finally {
			busy = false;
		}
	}

	/** Saves the whole list after an add or a removal; one a Bot runs on stays (409). */
	async function saveAccounts(configDirs: string[]): Promise<void> {
		if (!api?.setClaudeCodeAccounts || busy) return;
		busy = true;
		failed = false;
		accountError = null;
		try {
			status = await api.setClaudeCodeAccounts(configDirs);
			accountDraft = '';
		} catch (error) {
			const code = (error as { status?: number }).status;
			if (code === 409) accountError = 'in_use';
			else if (code === 422) accountError = 'invalid';
			else failed = true;
		} finally {
			busy = false;
		}
	}

	async function loadUsage(refresh: boolean): Promise<void> {
		if (!api?.claudeUsage || usageBusy) return;
		usageBusy = true;
		try {
			usage = await api.claudeUsage(refresh);
		} catch {
			// Not there over the relay from an older daemon: the card simply shows no usage.
		} finally {
			usageBusy = false;
			now = Date.now();
		}
	}

	// Asks once per client. `run` reads and writes `busy`, so it runs untracked: tracked, every
	// answer would set off the next ask.
	$effect(() => {
		if (!api) return;
		untrack(() => {
			void run((client) => client.claudeCode());
			void loadUsage(false);
		});
	});

	$effect(() => {
		if (status) onstatus?.(status);
	});

	const account = $derived(status && status.path && status.logged_in !== false ? claudeAccountLabel(status, t) : null);
	/** Where the daemon's own environment signs in from, as Claude Code reports it. */
	const ownDir = $derived(status?.accounts?.find((entry) => entry.config_dir === null)?.config_directory ?? null);
	const listed = $derived(status?.accounts?.filter((entry) => entry.config_dir !== null) ?? []);
	const listedDirs = $derived(listed.map((entry) => entry.config_dir!));
	const usageShown = $derived(usage ? usageAccounts(usage) : []);
	/** An account's usage when there is something to show for it: its windows, or why it has none. */
	function usageOf(dir: string | null): ClaudeAccountUsage | null {
		return usageShown.find((entry) => (entry.config_dir ?? null) === dir && (entry.available || entry.reason === 'no_plan' || entry.reason === 'failed')) ?? null;
	}
	const usageListed = $derived(status?.path ? [usageOf(null), ...listedDirs.map(usageOf)].filter((entry) => entry !== null) : []);
</script>

<section class="claude-card" aria-label={t.claudeAgent.title} data-claude-agent>
	<div class="claude-head">
		<h3 class="claude-title"><AgentLogo runner="claude_code" size={20} />{t.claudeAgent.title}<HelpTip text={t.claudeAgent.hint} label={t.claudeAgent.help} /></h3>
	</div>
	{#if unavailable}
		<p class="claude-note">{t.claudeAgent.unreachable}</p>
	{:else}
		{#if failed}
			<p class="claude-error" role="alert">{t.claudeAgent.failed}</p>
		{/if}
		{#if status}
			{#if !status.path}
				<p class="claude-warn" data-claude-missing>{t.claudeAgent.notFound}</p>
			{:else}
				<dl class="claude-facts">
					<dt>{t.claudeAgent.path}</dt>
					<dd><code>{status.path}</code>{#if status.source}<span class="claude-source">· {t.claudeAgent.source[status.source] ?? status.source}</span>{/if}</dd>
					<dt>{t.claudeAgent.version}</dt>
					<dd>{status.version ?? '—'}</dd>
					<dt>{t.claudeAgent.network}</dt>
					<dd data-claude-network>{#if status.proxy}<code>{status.proxy}</code>{#if status.proxy_source}<span class="claude-source">· {t.claudeAgent.proxySource[status.proxy_source] ?? status.proxy_source}</span>{/if}{:else}{t.claudeAgent.direct}{/if}</dd>
				</dl>
				{#if status.base_url_set}
					<p class="claude-note">{t.claudeAgent.baseUrl}</p>
				{/if}
				{#if status.outdated}
					<p class="claude-note">{t.claudeAgent.outdated(status.sdk_version)}</p>
				{/if}
				<div class="claude-accounts" data-claude-accounts>
					<h4>{t.claudeAgent.accounts.heading}<HelpTip text={t.claudeAgent.accounts.hint} label={t.claudeAgent.accounts.help} /></h4>
					<section class="claude-account" aria-label={account ?? t.claudeAgent.methods.none} data-claude-account>
						<div class="claude-account-head">
							<div class="claude-account-main">
								<span class="claude-account-name">{account ?? t.claudeAgent.methods.none}<span class="claude-account-tag">{t.claudeAgent.accounts.defaultTag}</span></span>
								{#if ownDir}<code class="claude-account-dir">{ownDir}</code>{/if}
							</div>
						</div>
						{#if status.logged_in === false}
							<p class="claude-warn" data-claude-signed-out>{t.claudeAgent.signedOut}</p>
						{/if}
						{#if claudeAgentPaysPerToken(status)}
							<p class="claude-warn" data-claude-api-key>{t.claudeAgent.apiKey}</p>
						{/if}
						{@render accountUsage(usageOf(null))}
					</section>
					{#each listed as entry (entry.config_dir)}
						<section class="claude-account" aria-label={entry.config_dir} data-claude-account-dir={entry.config_dir}>
							<div class="claude-account-head">
								<div class="claude-account-main">
									{#if entry.logged_in === false}
										<span class="claude-account-name">{t.claudeAgent.methods.none}</span>
									{:else}
										<span class="claude-account-name">{claudeAccountLabel(entry, t)}</span>
									{/if}
									<code class="claude-account-dir">{entry.config_dir}</code>
								</div>
								{#if api?.setClaudeCodeAccounts}
									<button type="button" class="btn-xs" disabled={busy} onclick={() => void saveAccounts(listedDirs.filter((dir) => dir !== entry.config_dir))}>{t.claudeAgent.accounts.remove}</button>
								{/if}
							</div>
							{#if entry.logged_in === false}
								<p class="claude-warn">{t.claudeAgent.accounts.signedOut} <code>{entry.login_command}</code></p>
							{/if}
							{@render accountUsage(usageOf(entry.config_dir))}
						</section>
					{/each}
					{#if usageListed.length > 0}
						<ClaudeUsageFoot checkedAt={usageLatestCheck(usageListed)} stale={false} {t} locale={localeTag(locale)} busy={usageBusy} onRefresh={() => void loadUsage(true)} />
					{/if}
					{#if accountError}
						<p class="claude-error" role="alert" data-claude-account-error={accountError}>{accountError === 'in_use' ? t.claudeAgent.accounts.inUse : t.claudeAgent.accounts.invalid}</p>
					{/if}
					{#if status.accounts && api?.setClaudeCodeAccounts}
						<form class="claude-path" onsubmit={(event) => { event.preventDefault(); if (accountDraft.trim()) void saveAccounts([...listedDirs, accountDraft.trim()]); }}>
							<input
								type="text"
								bind:value={accountDraft}
								placeholder={t.claudeAgent.accounts.placeholder}
								aria-label={t.claudeAgent.accounts.placeholder}
								spellcheck="false"
								autocomplete="off"
								disabled={busy}
							/>
							<button type="submit" class="btn-xs" disabled={busy || !accountDraft.trim()}>{t.claudeAgent.accounts.add}</button>
						</form>
					{/if}
				</div>
			{/if}
		{/if}
		<div class="claude-path">
			<input
				type="text"
				bind:value={pathDraft}
				placeholder={t.claudeAgent.pathPlaceholder}
				aria-label={t.claudeAgent.pathPlaceholder}
				spellcheck="false"
				autocomplete="off"
				disabled={busy}
			/>
			<button type="button" class="btn-xs" disabled={busy} onclick={() => void run((client) => client.setClaudeCodePath(pathDraft.trim() || null))}>{t.claudeAgent.pathSave}</button>
			<button type="button" class="btn-xs" disabled={busy} onclick={() => void run((client) => client.detectClaudeCode())}>{busy ? t.claudeAgent.checking : t.claudeAgent.recheck}</button>
		</div>
	{/if}
</section>


{#snippet accountUsage(entry: ClaudeAccountUsage | null)}
	{#if entry?.available}
		{@const failedAt = entry.error !== null ? usageCheckedTime(entry.checked_at, localeTag(locale)) : null}
		<div class="claude-account-usage" data-claude-card-usage>
			<ClaudeUsageRows usage={entry} {t} locale={localeTag(locale)} {now} busy={usageBusy} foot={false} />
			{#if failedAt}<p class="claude-stale">{t.claudeAgent.usage.stale(failedAt)}</p>{/if}
		</div>
	{:else if entry}
		<p class="claude-note" data-claude-card-usage>{usageAccountNote(entry, t)}</p>
	{/if}
{/snippet}

<style>
	.claude-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.claude-head h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.claude-note {
		margin: 4px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.claude-error,
	.claude-warn {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
	}

	.claude-error {
		color: var(--danger-text);
	}

	.claude-warn {
		color: var(--ink);
	}

	.claude-facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 4px 12px;
		margin: 0;
		font-size: 12px;
	}

	.claude-facts dt {
		color: var(--muted);
	}

	.claude-facts dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--ink);
	}

	/* Svelte drops a tag's leading space, so the gap after the path is a margin. */
	.claude-source {
		margin-left: 0.4em;
		color: var(--muted);
	}

	.claude-accounts h4 {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}

	.claude-accounts {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	.claude-accounts .claude-note,
	.claude-account .claude-warn {
		margin: 0;
	}

	/* A block per account: who it is, where it lives, then its usage. */
	.claude-account {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding: 8px 10px 10px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		font-size: 12px;
	}

	.claude-account-head {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}

	.claude-account-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.claude-account-name {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
		color: var(--ink);
		font: 600 13px/1.3 var(--font);
	}

	.claude-account-tag {
		padding: 0 6px;
		border: 1px solid var(--line);
		border-radius: 999px;
		color: var(--muted);
		font: 500 11px/16px var(--font);
	}

	.claude-account-dir {
		color: var(--muted);
		font-size: 11px;
	}

	.claude-stale {
		margin: 4px 0 0;
		color: var(--warn-text);
		font-size: 11px;
	}

	.claude-path {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	.claude-path input {
		flex: 1 1 220px;
		min-width: 0;
		font-size: 12px;
	}
</style>
