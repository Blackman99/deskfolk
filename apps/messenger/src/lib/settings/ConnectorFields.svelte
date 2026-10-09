<script lang="ts">
	import { connectorById, connectorFor, type ConnectorId } from '@real-bot/protocol';
	import ConnectorLogo from './ConnectorLogo.svelte';
	import WorkspaceField from './WorkspaceField.svelte';
	import type { Copy } from '../copy.ts';
	import { keyIsWorkspaceId, type ProviderDraft, type ProviderFieldErrors } from './provider-form.ts';

	/**
	 * A built-in connector's connection (ADR 0072): name, key and, for Anthropic, a workspace. The
	 * address is the plan the key was found on; with several plans it can also be picked here.
	 */
	type Props = {
		connectorId: ConnectorId;
		draft: ProviderDraft;
		errors: ProviderFieldErrors;
		fieldPrefix: string;
		keySet?: boolean;
		fetching: boolean;
		fetchError: string | null;
		t: Copy;
		patch: (partial: Partial<ProviderDraft>) => void;
	};

	let { connectorId, draft, errors, fieldPrefix, keySet, fetching, fetchError, t, patch }: Props = $props();

	const connector = $derived(connectorById(connectorId)!);
	const several = $derived(connector.plans.length > 1);
	/** The plan the address is on; none until a plan took the key. */
	const plan = $derived(connectorFor(draft.baseUrl, connector.apiFormat)?.plan ?? null);
	const planName = (id: string) => t.connectors.plan[`${connectorId}:${id}` as keyof typeof t.connectors.plan] ?? id;

	function pickPlan(id: string): void {
		const picked = connector.plans.find((item) => item.id === id);
		if (picked) patch({ baseUrl: picked.baseUrl });
	}
</script>

<div class="connector-head">
	<ConnectorLogo id={connectorId} size={40} />
	<span class="connector-head-text">
		<span class="connector-head-name">{t.connectors.name[connectorId]}</span>
		<span class="connector-head-blurb">{t.connectors.blurb[connectorId]}</span>
	</span>
</div>
<div class="modal-section connector-section">
	<label for={`${fieldPrefix}-name`}>{t.settings.providerName}</label>
	<input
		id={`${fieldPrefix}-name`}
		type="text"
		placeholder={t.connectors.name[connectorId]}
		value={draft.name}
		oninput={(ev) => patch({ name: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.name}
		<p class="field-error">{t.settings.providerNameEmpty}</p>
	{/if}
</div>
<div class="modal-section connector-section">
	<div class="field-head-row">
		<label for={`${fieldPrefix}-key`}>{t.settings.endpointKey}</label>
		{#if keySet !== undefined}
			<span class="connector-key-badge" class:is-set={keySet}>{keySet ? t.settings.keySet : t.settings.keyUnset}</span>
		{/if}
	</div>
	<input
		id={`${fieldPrefix}-key`}
		type="password"
		autocomplete="off"
		placeholder={keySet ? '••••••••' : t.connectors.keyPlaceholder[connectorId]}
		value={draft.apiKey}
		oninput={(ev) => patch({ apiKey: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if keyIsWorkspaceId(draft)}
		<p class="field-error">{t.connectors.keyIsWorkspace}</p>
	{:else if errors.endpointKey}
		<p class="field-error">{t.settings.keyEmpty}</p>
	{/if}
</div>
{#if connector.workspace}
	<WorkspaceField
		id={`${fieldPrefix}-workspace`}
		value={draft.workspaceId}
		invalid={errors.anthropicWorkspace === 'invalid'}
		{t}
		oninput={(value) => patch({ workspaceId: value })}
	/>
{/if}
{#if several}
	<div class="modal-section connector-section">
		<label for={`${fieldPrefix}-plan`}>{t.connectors.planLabel}</label>
		<select id={`${fieldPrefix}-plan`} value={plan?.id ?? ''} onchange={(ev) => pickPlan(ev.currentTarget.value)}>
			{#if !plan}<option value="" disabled>—</option>{/if}
			{#each connector.plans as item (item.id)}
				<option value={item.id}>{planName(item.id)}</option>
			{/each}
		</select>
		<p class="muted field-hint">{t.connectors.planHint}</p>
	</div>
{/if}
<div class="connector-status" role="status">
	{#if fetching}
		<span class="connector-status-line is-busy"><span class="connector-spinner" aria-hidden="true"></span>{several ? t.connectors.detecting : t.connectors.verifying}</span>
	{:else if fetchError}
		<div class="models-fetch-tip" role="alert">{fetchError}</div>
	{:else if plan && draft.availableModels.length > 0}
		<span class="connector-status-line is-ok">
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>
			{several ? t.connectors.detected(planName(plan.id), draft.availableModels.length) : t.connectors.verified(draft.availableModels.length)}
		</span>
	{:else if !keySet && draft.apiKey.trim().length === 0}
		<span class="connector-status-line">{several ? t.connectors.waitingKey : t.connectors.waitingKeySingle}</span>
	{/if}
</div>
<button type="button" class="connector-use-custom" onclick={() => patch({ connector: null, baseUrl: draft.baseUrl || connector.plans[0]!.baseUrl })}>
	{t.connectors.useCustom}
</button>

<style>
	.connector-head {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 16px;
	}

	.connector-head-text {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.connector-head-name {
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}

	.connector-head-blurb {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.45;
	}

	.connector-key-badge {
		font-size: 11px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--muted);
	}

	.connector-key-badge.is-set {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok);
		font-weight: 600;
	}

	.connector-section select {
		width: 100%;
	}

	.connector-status {
		min-height: 20px;
		margin: 2px 0 10px;
	}

	.connector-status-line {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.connector-status-line.is-ok {
		color: var(--ok);
		font-weight: 500;
	}

	.connector-spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 2px solid var(--line);
		border-top-color: var(--accent);
		animation: connector-spin 0.8s linear infinite;
	}

	@keyframes connector-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.connector-use-custom {
		display: block;
		align-self: flex-start;
		margin: 0 auto 0 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		font-size: 12px;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.connector-use-custom:hover {
		color: var(--accent);
	}

	@media (max-width: 720px) {
		.connector-section > input,
		.connector-section select {
			min-height: 48px;
			font-size: 16px;
		}

		.connector-section > label,
		.connector-section .field-head-row > label {
			font-size: 14px;
		}

		.connector-use-custom {
			min-height: 44px;
			font-size: 14px;
		}
	}
</style>
