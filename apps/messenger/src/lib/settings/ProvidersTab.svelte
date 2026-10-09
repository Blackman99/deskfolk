<script lang="ts">
	import ModelLadderCard from './ModelLadderCard.svelte';
	import ReaderModelCard from './ReaderModelCard.svelte';
	import { connectorFor, isLocalEndpoint } from '@real-bot/protocol';
	import ConnectorLogo from './ConnectorLogo.svelte';
	import SpeechCard from './SpeechCard.svelte';
	import type { Copy } from '../copy.ts';
	import { providerHost } from './provider-form.ts';
	import { botAvatarColor } from '../avatar.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		snapshot: Snapshot;
		providerSaving: boolean;
		openAddProvider: () => void;
		openEditProvider: (id: string) => void;
		openProviderModels: (id: string) => void;
		openDeleteProviderConfirm: (id: string) => void;
		setDefaultProvider: (id: string) => Promise<void>;
		setProviderDefaultModel: (id: string, model: string) => Promise<void>;
	};

	let {
		runtime,
		t,
		snapshot,
		providerSaving,
		openAddProvider,
		openEditProvider,
		openProviderModels,
		openDeleteProviderConfirm,
		setDefaultProvider,
		setProviderDefaultModel
	}: Props = $props();

	/** A key is in place, or none is needed: a model server on this computer or network (ADR 0067). */
	function keyReady(provider: { key_set: boolean; base_url: string | null }): boolean {
		return provider.key_set || isLocalEndpoint(provider.base_url);
	}

	function keyLabel(provider: { key_set: boolean; base_url: string | null }): string {
		if (provider.key_set) return t.settings.keySet;
		return isLocalEndpoint(provider.base_url) ? t.settings.keyNotNeeded : t.settings.keyUnset;
	}
</script>

<div class="settings-tab-pane provider-settings-pane">
	<div class="provider-list-head flex items-start justify-between gap-6">
		<p class="muted">{t.settings.providersHint}</p>
		<button type="button" class="btn-provider-add" onclick={openAddProvider}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
			<span>{t.settings.providerAdd}</span>
		</button>
	</div>
	{#if snapshot.providers.length === 0}
		<div class="mcp-empty">
			<p class="muted">{t.settings.providerEmpty}</p>
		</div>
	{/if}
	<div class="provider-card-list flex flex-col gap-5">
		{#each snapshot.providers as provider (provider.id)}
			{@const isDefault = snapshot.settings.default_provider_id === provider.id}
			{@const palette = botAvatarColor(provider.id)}
			{@const host = providerHost(provider.base_url)}
			{@const builtIn = connectorFor(provider.base_url, provider.api_format)}
			<div class="provider-card" class:is-default={isDefault}>
				<div class="provider-card-head flex items-center justify-between gap-5 min-w-0">
					<div class="provider-card-identity">
						{#if builtIn}
							<span class="provider-card-logo" title={t.connectors.name[builtIn.connector.id]}><ConnectorLogo id={builtIn.connector.id} /></span>
						{:else}
							<span
								class="provider-card-mark"
								style:background={palette.bg}
								style:color={palette.text}
								style:border-color={palette.border}
							>{rosterLetter(provider.name)}</span>
						{/if}
						<span class="provider-identity-text min-w-0 flex flex-col gap-[3px] flex-1">
							<span class="provider-name-row flex items-center gap-4 flex-wrap min-w-0">
								<span class="provider-card-name text-14 font-semibold text-ink leading-[1.2]">{provider.name}</span>
								{#if isDefault}
									<span class="provider-badge-default" title={t.settings.providerDefault}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
										<span>{t.settings.providerDefault}</span>
									</span>
								{/if}
								<span class="provider-badge-key" class:is-set={keyReady(provider)} title={keyLabel(provider)}>
									<span class="provider-status-dot w-3 h-3 rounded-[50%] bg-warn shrink-0" class:is-set={keyReady(provider)}></span>
									<span>{keyLabel(provider)}</span>
								</span>
							</span>
							{#if host}
								<span class="provider-card-host mono inline-flex items-center gap-[5px] text-12 text-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-full" title={provider.base_url ?? ''}>
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
									<span class="provider-card-host-text">{host}{provider.api_format === 'anthropic' && !builtIn ? ` · ${t.settings.apiFormatAnthropicShort}` : ''}</span>
									{#if builtIn && builtIn.connector.plans.length > 1}
										<span class="provider-plan-chip">{t.connectors.plan[`${builtIn.connector.id}:${builtIn.plan.id}` as keyof typeof t.connectors.plan] ?? builtIn.plan.id}</span>
									{/if}
								</span>
							{/if}
						</span>
					</div>

					<div class="provider-card-acts flex items-center gap-3 shrink-0">
						{#if !isDefault}
							<button
								type="button"
								class="btn-provider-action btn-provider-setdefault"
								onclick={() => void setDefaultProvider(provider.id)}
								title={t.settings.providerSetDefault}
							>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
								<span>{t.settings.providerSetDefault}</span>
							</button>
						{/if}
						<button
							type="button"
							class="btn-provider-action btn-provider-edit"
							aria-label={`${t.settings.providerConnection}: ${provider.name}`}
							onclick={() => openEditProvider(provider.id)}
							title={t.settings.providerConnection}
						>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
							<span>{t.settings.providerConnection}</span>
						</button>
						<button
							type="button"
							class="btn-provider-action btn-provider-delete"
							aria-label={`${t.settings.providerDelete}: ${provider.name}`}
							onclick={() => openDeleteProviderConfirm(provider.id)}
							title={t.settings.providerDelete}
						>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
						</button>
					</div>
				</div>

				<div class="provider-mobile-default">
					<label for={`default-model-${provider.id}`}>{t.settings.defaultModel}</label>
					<select id={`default-model-${provider.id}`} aria-label={`${t.settings.defaultModel}: ${provider.name}`} value={provider.default_model ?? ''} disabled={provider.models.length === 0 || providerSaving} onchange={(event) => void setProviderDefaultModel(provider.id, event.currentTarget.value)}>
						<option value="" disabled>{provider.models.length ? t.settings.providerChooseDefault : t.settings.providerEnableFirst}</option>
						{#each provider.models as model (model)}<option value={model}>{model}</option>{/each}
					</select>
				</div>
				<div class="provider-model-rail" role="radiogroup" aria-label={t.settings.defaultModel}>
					{#if provider.models.length === 0}
						<button
							type="button"
							class="provider-model-empty"
							onclick={() => openProviderModels(provider.id)}
						>
							{t.settings.providerNoDefault}
						</button>
					{:else}
						{#each provider.models as model (model)}
							{@const chosen = model === provider.default_model}
							<button
								type="button"
								class="provider-model-pick mono"
								class:is-default={chosen}
								role="radio"
								disabled={providerSaving}
								aria-checked={chosen}
								aria-label={chosen
									? t.settings.providerDefaultModel(model)
									: t.settings.providerPickDefault}
								onclick={() => void setProviderDefaultModel(provider.id, model)}
							>
								<span class="provider-model-mark" aria-hidden="true"></span>
								<span class="provider-model-pick-name">{model}</span>
							</button>
						{/each}
					{/if}
					<button
						type="button"
						class="provider-model-manage"
						aria-label={`${t.settings.providerModels}: ${provider.name}`}
						onclick={() => openProviderModels(provider.id)}
					>
						<span>{t.settings.providerModels}</span>
						<span class="provider-model-manage-count">{t.settings.modelsEnabledCount(provider.models.length)}</span>
						<svg class="provider-manage-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
					</button>
				</div>
			</div>
		{/each}
	</div>
	{#if snapshot.providers.length > 0}
		<ModelLadderCard api={runtime.client} providers={snapshot.providers} {t} />
		<ReaderModelCard
			providers={snapshot.providers}
			chosen={snapshot.settings.reader_model ?? null}
			defaultModel={snapshot.settings.endpoint_default_model}
			patch={(patch) => runtime.patchSettings(patch)}
			claudeCode={runtime.client ? () => runtime.client!.claudeCode() : null}
			{t}
		/>
	{/if}
	<!-- Speech needs no chat endpoint of its own: it has its own service and key (ADR 0073). -->
	<SpeechCard speech={snapshot.settings.speech ?? null} providers={snapshot.providers} patch={(patch) => runtime.patchSpeech(patch)} {t} />
</div>

<style>
	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.provider-mobile-default, .provider-manage-chevron { display: none; }

	.provider-list-head :global(.muted) {
		margin: 0;
		flex: 1;
	}

	.btn-provider-add {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		border: 1.5px dashed var(--line);
		background: var(--sidebar-bg);
		color: var(--accent);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-provider-add:hover {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.btn-provider-add:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.provider-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
	}

	.provider-card:hover,
	.provider-card:focus-within {
		border-color: var(--accent-border);
		box-shadow: var(--shadow-sm);
	}

	.provider-card.is-default {
		border-color: var(--accent-border);
		background: linear-gradient(180deg, var(--accent-tint) 0%, var(--pane) 38px);
		box-shadow: 0 0 0 1px var(--accent-border), var(--shadow-xs);
	}

	.provider-card-identity {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
		color: inherit;
	}

	.provider-card-mark {
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		border: 1px solid;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 15px;
		font-weight: 700;
		flex: 0 0 auto;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}

	.provider-card-logo {
		display: inline-flex;
		flex: 0 0 auto;
	}

	/* A long address gives way to the plan beside it. */
	.provider-card-host-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.provider-plan-chip {
		flex: 0 0 auto;
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--chip);
		border: 1px solid var(--chip-line);
		font-family: var(--font);
		font-size: 11px;
		line-height: 16px;
		color: var(--ink-secondary);
	}

	.provider-badge-default {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 600;
		padding: 1.5px 7px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		border: 1px solid var(--accent-border);
		flex-shrink: 0;
		line-height: 1.3;
	}

	.provider-badge-key {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		font-weight: 500;
		padding: 1.5px 7px;
		border-radius: var(--radius-full);
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
		flex-shrink: 0;
		line-height: 1.3;
	}

	.provider-badge-key.is-set {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok-text);
	}

	.provider-status-dot.is-set {
		background: var(--ok);
		box-shadow: 0 0 4px var(--ok);
	}

	.provider-card-host :global(svg) {
		flex-shrink: 0;
		opacity: 0.75;
	}

	.btn-provider-action {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		line-height: 1.2;
	}

	.btn-provider-action:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-tint);
	}

	.btn-provider-action:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.btn-provider-action.btn-provider-delete {
		background: transparent;
		border-color: transparent;
		color: var(--muted);
		padding: 4px 6px;
	}

	.btn-provider-action.btn-provider-delete:hover {
		color: var(--danger);
		background: var(--danger-bg);
		border-color: var(--danger-line);
	}

	/* The default model is a row you click. Connection and the enable list live behind their own buttons. */
	.provider-model-rail {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-top: 8px;
		border-top: 1px solid var(--line);
	}

	.provider-model-pick,
	.provider-model-empty,
	.provider-model-manage {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 32px;
		padding: 4px 8px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}

	.provider-model-pick:hover,
	.provider-model-empty:hover,
	.provider-model-manage:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.provider-model-pick:focus-visible,
	.provider-model-empty:focus-visible,
	.provider-model-manage:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.provider-model-mark {
		flex: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1.5px solid var(--line-hover);
		background: var(--input-bg);
		box-sizing: border-box;
	}

	.provider-model-pick.is-default {
		color: var(--ink);
		font-weight: 600;
	}

	.provider-model-pick.is-default .provider-model-mark {
		border-color: var(--accent);
		background: radial-gradient(circle, var(--accent) 0 4px, transparent 4.5px);
	}

	.provider-model-pick-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.provider-model-empty {
		color: var(--muted);
		font-size: 12px;
		line-height: 1.4;
	}

	.provider-model-manage {
		color: var(--accent);
		font-weight: 600;
		font-size: 12px;
	}

	.provider-model-manage-count {
		margin-left: auto;
		font-weight: 500;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	@media (max-width: 720px) {
		.settings-tab-pane {
			gap: 12px;
		}
	}

	@media (max-width: 720px) {
		.provider-settings-pane { gap: 20px; }
		.provider-list-head { flex-direction: column; gap: 16px; }
		.provider-list-head .muted { font-size: 14px; line-height: 1.6; }
		.btn-provider-add { width: 100%; min-height: 48px; justify-content: center; padding: 10px 16px; border: 1px solid var(--accent-border); border-radius: var(--radius-md); background: var(--accent-tint); font-size: 15px; }
		.btn-provider-add svg { width: 18px; height: 18px; }
		.provider-card-list { gap: 20px; }
		.provider-card, .provider-card.is-default { position: relative; gap: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--pane); box-shadow: none; overflow: hidden; }
		.provider-card-head { display: contents; }
		.provider-card-identity { align-items: flex-start; gap: 12px; padding: 18px 16px 16px; }
		.provider-card-mark { width: 40px; height: 40px; border-radius: var(--radius-md); font-size: 18px; box-shadow: none; }
		.provider-card-logo { --connector-logo-size: 40px; }
		.provider-name-row { gap: 6px; }
		.provider-card-name { flex: 1 0 100%; font-size: 18px; line-height: 1.4; overflow-wrap: anywhere; }
		.provider-badge-default, .provider-badge-key { padding: 3px 6px; font-size: 11px; }
		.provider-card-host { width: 100%; font-size: 12px; margin-top: 4px; }
		.provider-card-host span { overflow: hidden; text-overflow: ellipsis; }
		.provider-status-dot.is-set { box-shadow: none; }
		.provider-card-acts { order: 3; gap: 0; border-top: 1px solid var(--line); }
		.btn-provider-action { flex: 1; justify-content: center; gap: 6px; min-height: 48px; padding: 8px; border: 0; border-radius: 0; background: transparent; font-size: 13px; }
		.btn-provider-action + .btn-provider-action { border-left: 1px solid var(--line); }
		.btn-provider-action svg { width: 16px; height: 16px; }
		.btn-provider-action.btn-provider-delete { flex: 0 0 52px; min-height: 48px; padding: 8px; border-left: 1px solid var(--line); }
		.provider-mobile-default { display: flex; flex-direction: column; gap: 8px; padding: 0 16px 16px; }
		.provider-mobile-default label { font-size: 12px; font-weight: 500; color: var(--muted); }
		.provider-mobile-default select { width: 100%; min-width: 0; min-height: 48px; padding: 10px 12px; font-family: var(--font); font-size: 16px; color: var(--ink); background: var(--sidebar-bg); border: 1px solid var(--line); border-radius: var(--radius-md); text-overflow: ellipsis; }
		.provider-model-rail { gap: 0; padding: 0; }
		.provider-model-pick, .provider-model-empty { display: none; }
		.provider-model-manage { min-height: 56px; padding: 12px 16px; border-radius: 0; font-size: 15px; color: var(--ink); }
		.provider-model-manage-count { font-size: 12px; }
		.provider-manage-chevron { display: block; flex-shrink: 0; color: var(--muted); }
	}
</style>
