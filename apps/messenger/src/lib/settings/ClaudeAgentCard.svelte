<script lang="ts">
	import { untrack } from 'svelte';
	import type { ClaudeCodeStatus, ClaudeUsage } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { localeTag } from '../locale-tag.ts';
	import { claudeAccountLabel, claudeAgentPaysPerToken } from './claude-agent.ts';
	import ClaudeSpark from './ClaudeSpark.svelte';
	import ClaudeUsageRows from './ClaudeUsageRows.svelte';

	/**
	 * Your own Claude Code as the daemon finds it (ADR 0061): where it is, which version, which
	 * account it is signed in with. Deskfolk only runs it and asks it about itself; signing in is
	 * Claude Code's own, in a terminal.
	 */
	export type ClaudeAgentApi = {
		claudeCode: () => Promise<ClaudeCodeStatus>;
		detectClaudeCode: () => Promise<ClaudeCodeStatus>;
		setClaudeCodePath: (path: string | null) => Promise<ClaudeCodeStatus>;
		/** Your plan's usage, as that Claude Code reads it; absent from an older client. */
		claudeUsage?: (refresh?: boolean) => Promise<ClaudeUsage>;
	};

	interface Props {
		api: ClaudeAgentApi | null;
		t: Copy;
		locale?: 'zh' | 'en';
	}

	let { api, t, locale = 'zh' }: Props = $props();

	let status = $state<ClaudeCodeStatus | null>(null);
	let busy = $state(false);
	let failed = $state(false);
	let unavailable = $state(false);
	let pathDraft = $state('');
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
			// The route is the computer's own: over the relay it is not there at all.
			if ((error as { status?: number }).status === 404) unavailable = true;
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

	const account = $derived(status && status.path && status.logged_in !== false ? claudeAccountLabel(status, t) : null);
</script>

<section class="claude-card" aria-label={t.claudeAgent.title} data-claude-agent>
	<div class="claude-head">
		<h3 class="claude-title"><ClaudeSpark size={16} />{t.claudeAgent.title}</h3>
		<p>{t.claudeAgent.hint}</p>
	</div>
	{#if unavailable}
		<p class="claude-note">{t.claudeAgent.localOnly}</p>
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
					<dt>{t.claudeAgent.account}</dt>
					<dd data-claude-account>{account ?? t.claudeAgent.methods.none}</dd>
					<dt>{t.claudeAgent.network}</dt>
					<dd data-claude-network>{#if status.proxy}<code>{status.proxy}</code>{#if status.proxy_source}<span class="claude-source">· {t.claudeAgent.proxySource[status.proxy_source] ?? status.proxy_source}</span>{/if}{:else}{t.claudeAgent.direct}{/if}</dd>
				</dl>
				{#if status.logged_in === false}
					<p class="claude-warn" data-claude-signed-out>{t.claudeAgent.signedOut}</p>
				{/if}
				{#if claudeAgentPaysPerToken(status)}
					<p class="claude-warn" data-claude-api-key>{t.claudeAgent.apiKey}</p>
				{/if}
				{#if status.base_url_set}
					<p class="claude-note">{t.claudeAgent.baseUrl}</p>
				{/if}
				{#if status.outdated}
					<p class="claude-note">{t.claudeAgent.outdated(status.sdk_version)}</p>
				{/if}
			{/if}
		{/if}
		{#if usage && (usage.available || usage.reason === 'no_plan' || usage.reason === 'failed')}
			<div class="claude-usage" data-claude-card-usage>
				<h4>{t.claudeAgent.usage.heading}</h4>
				{#if usage.available}
					<ClaudeUsageRows {usage} {t} locale={localeTag(locale)} {now} busy={usageBusy} onRefresh={() => void loadUsage(true)} />
				{:else}
					<p class="claude-note">{usage.reason === 'no_plan' ? t.claudeAgent.usage.noPlan : t.claudeAgent.usage.failed}</p>
				{/if}
			</div>
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

	.claude-head p,
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

	.claude-usage {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	.claude-usage h4 {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
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
