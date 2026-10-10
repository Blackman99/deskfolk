<script lang="ts">
	import { untrack } from 'svelte';
	import { AGENT_KINDS, type AgentStatus, type BotRunner, type CustomAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { agentAccountExample, agentCommand, agentFailure, type AgentFailure } from './agents.ts';
	import HelpTip from './HelpTip.svelte';

	/**
	 * One of your local agents besides Claude Code (ADR 0079), as the daemon found it: where it is,
	 * which version, whether it is signed in, how it reaches the network and which models it lists,
	 * with the other accounts' config directories a Bot may run on for an agent that has them.
	 * Deskfolk only runs it and asks it about itself; signing in is the agent's own, in a terminal.
	 * Text names only: Claude's mark is the one vendor mark in the app.
	 */
	export type AgentCardApi = {
		detectAgent: (runner: BotRunner, customId?: string | null) => Promise<AgentStatus>;
		setAgentPath: (runner: BotRunner, path: string | null) => Promise<AgentStatus>;
		setAgentAccounts: (runner: BotRunner, configDirs: string[]) => Promise<AgentStatus>;
	};

	interface Props {
		status: AgentStatus;
		api: AgentCardApi | null;
		t: Copy;
		/** For one of your own ACP agents: its command and arguments as you listed them. */
		custom?: CustomAgent | null;
		/** Told the daemon's new answer after a check, a path or an account list was set. */
		onChange?: (status: AgentStatus) => void;
	}

	let { status, api, t, custom = null, onChange }: Props = $props();

	let busy = $state(false);
	let failed = $state(false);
	let pathDraft = $state(untrack(() => (status.source === 'setting' && status.path ? status.path : '')));
	let pathFailure = $state<AgentFailure | null>(null);
	let accountDraft = $state('');
	let accountFailure = $state<AgentFailure | null>(null);

	const kind = $derived(AGENT_KINDS[status.runner]);
	const isCustom = $derived(status.runner === 'custom');
	const command = $derived(agentCommand(status, custom));
	const configDirVar = $derived(kind.configDirVar);
	/** Your accounts besides the daemon's own environment, which the facts above already show. */
	const listed = $derived(status.accounts?.filter((entry) => entry.config_dir !== null) ?? []);
	const listedDirs = $derived(listed.map((entry) => entry.config_dir!));

	async function run(work: (client: AgentCardApi) => Promise<AgentStatus>, onFail: (error: unknown) => void): Promise<void> {
		if (!api || busy) return;
		busy = true;
		failed = false;
		try {
			const next = await work(api);
			if (next.source === 'setting' && next.path) pathDraft = next.path;
			onChange?.(next);
		} catch (error) {
			onFail(error);
		} finally {
			busy = false;
		}
	}

	function detect(): Promise<void> {
		pathFailure = null;
		return run((client) => client.detectAgent(status.runner, status.custom_id), () => (failed = true));
	}

	function savePath(): Promise<void> {
		pathFailure = null;
		const path = pathDraft.trim() || null;
		return run(
			(client) => client.setAgentPath(status.runner, path),
			(error) => {
				const failure = agentFailure(error);
				if (failure.kind === 'failed') failed = true;
				else pathFailure = failure;
			}
		);
	}

	/** Saves the whole list after an add or a removal; one a Bot runs on stays (409). */
	function saveAccounts(configDirs: string[]): Promise<void> {
		accountFailure = null;
		return run(
			async (client) => {
				const next = await client.setAgentAccounts(status.runner, configDirs);
				accountDraft = '';
				return next;
			},
			(error) => {
				const failure = agentFailure(error);
				if (failure.kind === 'failed') failed = true;
				else accountFailure = failure;
			}
		);
	}
</script>

<section class="agent-card" aria-label={status.label} data-agent-card={status.runner} data-agent-custom-id={status.custom_id ?? undefined}>
	<div class="agent-head">
		<h3 class="agent-title"><span data-agent-label>{status.label}</span><HelpTip text={t.agents.hint(status.label)} label={t.agents.help(status.label)} /></h3>
	</div>
	{#if failed}
		<p class="agent-error" role="alert" data-agent-failed>{t.agents.failed}</p>
	{/if}
	{#if !status.path}
		<p class="agent-warn" data-agent-missing>{isCustom ? t.agents.notFoundCustom(command) : t.agents.notFound(command)}</p>
	{:else}
		<dl class="agent-facts">
			<dt>{isCustom ? t.agents.command : t.agents.path}</dt>
			<dd data-agent-path><code>{status.path}</code>{#if status.source}<span class="agent-source">· {t.agents.source[status.source] ?? status.source}</span>{/if}</dd>
			{#if isCustom}
				<dt>{t.agents.args}</dt>
				<dd data-agent-args>{#if custom && custom.args.length > 0}<code>{custom.args.join(' ')}</code>{:else}{t.agents.noArgs}{/if}</dd>
			{/if}
			<dt>{t.agents.version}</dt>
			<dd data-agent-version>{status.version ?? '—'}</dd>
			<dt>{t.agents.signIn}</dt>
			<dd data-agent-signin>{@render signIn(status)}</dd>
			<dt>{t.agents.network}</dt>
			<dd data-agent-network>{#if status.proxy}<code>{status.proxy}</code>{#if status.proxy_source}<span class="agent-source">· {t.agents.proxySource[status.proxy_source] ?? status.proxy_source}</span>{/if}{:else}{t.agents.direct}{/if}</dd>
			<dt>{t.agents.models}</dt>
			<dd data-agent-models>{status.models.length > 0 ? t.agents.modelsCount(status.models.length, status.default_model) : t.agents.modelsNone}</dd>
		</dl>
	{/if}
	{#if status.error && status.path}
		<p class="agent-note" data-agent-error>{status.error}</p>
	{/if}
	{#if status.runner === 'antigravity'}
		<p class="agent-note" data-agent-note="antigravity">{t.agents.noteAntigravity}</p>
	{/if}
	{#if status.runner === 'zcode'}
		<p class="agent-note" data-agent-note="zcode">{t.agents.noteZcode}</p>
	{/if}
	{#if configDirVar && status.path}
		<div class="agent-accounts" data-agent-accounts>
			<h4>{t.agents.accounts.heading}<HelpTip text={t.agents.accounts.hint(status.label, configDirVar)} label={t.agents.accounts.help} /></h4>
			{#each listed as entry (entry.config_dir)}
				<section class="agent-account" aria-label={entry.config_dir} data-agent-account-dir={entry.config_dir}>
					<div class="agent-account-head">
						<div class="agent-account-main">
							<code class="agent-account-dir">{entry.config_dir}</code>
							<span class="agent-account-state">{@render signIn(entry)}</span>
						</div>
						<button type="button" class="btn-xs" disabled={busy} onclick={() => void saveAccounts(listedDirs.filter((dir) => dir !== entry.config_dir))}>{t.agents.accounts.remove}</button>
					</div>
					{#if entry.error}<p class="agent-note">{entry.error}</p>{/if}
				</section>
			{/each}
			{#if listed.length === 0}
				<p class="agent-note">{t.agents.accounts.none}</p>
			{/if}
			{#if accountFailure}
				<p class="agent-error" role="alert" data-agent-account-error={accountFailure.kind}>
					{accountFailure.kind === 'in_use' ? t.agents.accounts.inUse : t.agents.accounts.invalid}
					{#if accountFailure.detail}<span class="agent-error-detail">{accountFailure.detail}</span>{/if}
				</p>
			{/if}
			<form class="agent-path" onsubmit={(event) => { event.preventDefault(); if (accountDraft.trim()) void saveAccounts([...listedDirs, accountDraft.trim()]); }}>
				<input
					type="text"
					bind:value={accountDraft}
					placeholder={t.agents.accounts.placeholder(agentAccountExample(status.runner))}
					aria-label={t.agents.accounts.placeholder(agentAccountExample(status.runner))}
					spellcheck="false"
					autocomplete="off"
					disabled={busy}
				/>
				<button type="submit" class="btn-xs" disabled={busy || !accountDraft.trim()}>{t.agents.accounts.add}</button>
			</form>
		</div>
	{/if}
	{#if pathFailure}
		<p class="agent-error" role="alert" data-agent-path-error>
			{t.agents.pathInvalid}
			{#if pathFailure.detail}<span class="agent-error-detail">{pathFailure.detail}</span>{/if}
		</p>
	{/if}
	<div class="agent-path">
		{#if !isCustom}
			<input
				type="text"
				bind:value={pathDraft}
				placeholder={t.agents.pathPlaceholder(command)}
				aria-label={t.agents.pathPlaceholder(command)}
				spellcheck="false"
				autocomplete="off"
				disabled={busy}
				data-agent-path-input
			/>
			<button type="button" class="btn-xs" disabled={busy} onclick={() => void savePath()} data-agent-path-save>{t.agents.pathSave}</button>
		{/if}
		<button type="button" class="btn-xs" disabled={busy} onclick={() => void detect()} data-agent-recheck>{busy ? t.agents.checking : t.agents.recheck}</button>
	</div>
</section>

{#snippet signIn(entry: { logged_in: boolean | null; auth: string | null; login_command: string | null })}
	{#if entry.logged_in === true}
		{t.agents.signedIn(entry.auth)}
	{:else if entry.logged_in === false}
		{#if entry.login_command}{t.agents.signedOut} <code>{entry.login_command}</code>{:else}{t.agents.signedOutNoCommand}{/if}
	{:else}
		{t.agents.signInUnknown}
	{/if}
{/snippet}

<style>
	.agent-card {
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

	.agent-head h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.agent-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.agent-error,
	.agent-warn {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
	}

	.agent-error {
		color: var(--danger-text);
	}

	.agent-warn {
		color: var(--ink);
	}

	/* The daemon's own words under ours: they name the Bots that stand in the way. */
	.agent-error-detail {
		display: block;
		margin-top: 2px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.agent-facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: 4px 12px;
		margin: 0;
		font-size: 12px;
	}

	.agent-facts dt {
		color: var(--muted);
	}

	.agent-facts dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--ink);
	}

	/* Svelte drops a tag's leading space, so the gap after the path is a margin. */
	.agent-source {
		margin-left: 0.4em;
		color: var(--muted);
	}

	.agent-accounts h4 {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}

	.agent-accounts {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	/* A block per account: where it lives, then what the agent says of its sign-in. */
	.agent-account {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding: 8px 10px 10px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		font-size: 12px;
	}

	.agent-account-head {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}

	.agent-account-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1 1 auto;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.agent-account-dir {
		color: var(--ink);
		font-size: 11px;
	}

	.agent-account-state {
		color: var(--muted);
	}

	.agent-path {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	.agent-path input {
		flex: 1 1 220px;
		min-width: 0;
		font-size: 12px;
	}
</style>
