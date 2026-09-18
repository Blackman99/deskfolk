<script lang="ts">
	import type { FieldErrorKind } from './wizard-save.ts';
	import type { Copy } from './copy.ts';
	import {
		PRESET_STRENGTHS,
		addAttrStrength,
		addDraftModel,
		emptyModelAttr,
		hasCustomAttrs,
		pickerModels,
		probeSignature,
		setDraftModels,
		toggleAttrStrength,
		toggleAttrThinkingLevel,
		toggleDraftModel,
		type ModelAttrDraft,
		type ProviderDraft,
		type ProviderFieldErrors
	} from './provider-form.ts';
	import { THINKING_LEVELS } from '@real-bot/protocol';
	import Select from './Select.svelte';

	interface Props {
		draft: ProviderDraft;
		errors: ProviderFieldErrors;
		failed: boolean;
		fetching: boolean;
		fetchError: string | null;
		fieldPrefix: string;
		/** Set when editing: whether the daemon already holds a key for this endpoint. */
		keySet?: boolean;
		t: Copy;
		onchange: (draft: ProviderDraft) => void;
		onfetch: () => void;
	}

	let {
		draft,
		errors,
		failed,
		fetching,
		fetchError,
		fieldPrefix,
		keySet,
		t,
		onchange,
		onfetch
	}: Props = $props();

	const TOOLBAR_MIN_ROWS = 6;
	const PRESET_KEYS = new Set<string>(PRESET_STRENGTHS);

	let filterQuery = $state('');
	let filterMode = $state<'all' | 'enabled'>('all');
	let expanded = $state<Record<string, boolean>>({});
	let manualOpen = $state(false);
	let manualName = $state('');
	let strengthEditing = $state<string | null>(null);
	let strengthText = $state('');

	const rows = $derived(pickerModels(draft));
	const enabled = $derived(new Set(draft.models));
	const available = $derived(new Set(draft.availableModels));
	const canProbe = $derived(probeSignature(draft, Boolean(keySet)) !== null);
	const showToolbar = $derived(rows.length > TOOLBAR_MIN_ROWS);
	const visibleRows = $derived.by(() => {
		const q = filterQuery.trim().toLowerCase();
		return rows.filter((name) => {
			if (filterMode === 'enabled' && !enabled.has(name)) return false;
			return q.length === 0 || name.toLowerCase().includes(q);
		});
	});

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	function patch(partial: Partial<ProviderDraft>): void {
		onchange({ ...draft, ...partial });
	}

	function attrOf(name: string): ModelAttrDraft {
		return draft.modelAttrs[name] ?? emptyModelAttr();
	}

	function patchAttr(name: string, next: ModelAttrDraft): void {
		if (next === draft.modelAttrs[name]) return;
		patch({ modelAttrs: { ...draft.modelAttrs, [name]: next } });
	}

	function toggleExpanded(name: string): void {
		expanded = { ...expanded, [name]: !expanded[name] };
	}

	function selectVisible(): void {
		const merged = [...draft.models];
		for (const name of visibleRows) if (!merged.includes(name)) merged.push(name);
		onchange(setDraftModels(draft, merged));
	}

	function submitManual(): void {
		const next = addDraftModel(draft, manualName);
		if (next === draft) return;
		onchange(next);
		manualName = '';
	}

	function openStrengthInput(name: string): void {
		strengthEditing = name;
		strengthText = '';
	}

	function submitStrength(name: string): void {
		patchAttr(name, addAttrStrength(attrOf(name), strengthText));
		strengthEditing = null;
		strengthText = '';
	}

	function customStrengths(attr: ModelAttrDraft): string[] {
		return attr.strengths.filter((tag) => !PRESET_KEYS.has(tag.toLowerCase()));
	}

	function hasStrength(attr: ModelAttrDraft, tag: string): boolean {
		return attr.strengths.some((item) => item.toLowerCase() === tag.toLowerCase());
	}

	function emptyHint(): string {
		if (fetching) return t.settings.modelsFetchingHint;
		if (canProbe && !fetchError) return t.settings.modelsAutoFetchHint;
		return t.settings.modelsEmptyHint;
	}
</script>

{#if failed}
	<p class="field-error">{t.settings.saveFailed}</p>
{/if}
<div class="modal-section">
	<label for={`${fieldPrefix}-name`}>{t.settings.providerName}</label>
	<input
		id={`${fieldPrefix}-name`}
		type="text"
		placeholder="OpenAI"
		value={draft.name}
		oninput={(ev) => patch({ name: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.name}
		<p class="field-error">{t.settings.providerNameEmpty}</p>
	{/if}
</div>
<div class="modal-section">
	<label for={`${fieldPrefix}-url`}>{t.settings.endpoint}</label>
	<input
		id={`${fieldPrefix}-url`}
		type="text"
		class="mono"
		inputmode="url"
		autocapitalize="off"
		autocorrect="off"
		spellcheck="false"
		placeholder="https://api.openai.com/v1"
		value={draft.baseUrl}
		oninput={(ev) => patch({ baseUrl: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.endpoint}
		<p class="field-error">
			{fieldCopy(errors.endpoint, t.settings.endpointEmpty, t.settings.endpointInvalid)}
		</p>
	{/if}
</div>
<div class="modal-section">
	<div class="field-head-row">
		<label for={`${fieldPrefix}-key`}>{t.settings.endpointKey}</label>
		{#if keySet !== undefined}
			<span class="key-status-badge" class:is-set={keySet}>
				{keySet ? t.settings.keySet : t.settings.keyUnset}
			</span>
		{/if}
	</div>
	<input
		id={`${fieldPrefix}-key`}
		type="password"
		autocomplete="off"
		placeholder={keySet ? '••••••••' : ''}
		value={draft.apiKey}
		oninput={(ev) => patch({ apiKey: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.endpointKey}
		<p class="field-error">{t.settings.keyEmpty}</p>
	{/if}
</div>

<div class="modal-section">
	<div class="field-head-row">
		<span class="field-head model-picker-head" id={`${fieldPrefix}-models-label`}>
			{t.settings.models}
			{#if rows.length > 0}
				<span class="badge-count-inline">
					{t.settings.modelsCounts(draft.models.length, draft.availableModels.length)}
				</span>
			{/if}
		</span>
		<button
			type="button"
			class="btn-fetch-models-mini"
			disabled={fetching || !canProbe}
			onclick={onfetch}
		>
			{#if fetching}
				{t.settings.modelsFetching}
			{:else}
				↻ {draft.availableModels.length > 0 ? t.settings.modelsRefetch : t.settings.modelsFetch}
			{/if}
		</button>
	</div>
	{#if fetchError}
		<div class="models-fetch-tip">{fetchError}</div>
	{/if}
	<div class="model-picker" class:has-error={Boolean(errors.models)}>
		{#if rows.length === 0}
			<div class="model-picker-empty">
				<p class="muted">{emptyHint()}</p>
			</div>
		{:else}
			{#if showToolbar}
				<div class="model-picker-toolbar">
					<input
						type="search"
						class="model-picker-search"
						placeholder={t.settings.modelsSearchPlaceholder}
						aria-label={t.settings.modelsSearchPlaceholder}
						bind:value={filterQuery}
					/>
					<div class="segmented" role="group" aria-label={t.settings.models}>
						<button
							type="button"
							class:active={filterMode === 'all'}
							aria-pressed={filterMode === 'all'}
							onclick={() => (filterMode = 'all')}
						>
							{t.settings.modelsFilterAll}
						</button>
						<button
							type="button"
							class:active={filterMode === 'enabled'}
							aria-pressed={filterMode === 'enabled'}
							onclick={() => (filterMode = 'enabled')}
						>
							{t.settings.modelsFilterEnabled} {draft.models.length}
						</button>
					</div>
					<button type="button" class="btn-xs" onclick={selectVisible}>
						{t.settings.modelsSelectAll}
					</button>
					<button type="button" class="btn-xs" onclick={() => onchange(setDraftModels(draft, []))}>
						{t.settings.modelsDeselectAll}
					</button>
				</div>
			{/if}
			<ul class="model-picker-list" aria-labelledby={`${fieldPrefix}-models-label`}>
				{#if visibleRows.length === 0}
					<li class="model-picker-none muted">
						{filterMode === 'enabled' && filterQuery.trim().length === 0
							? t.settings.modelsEnabledEmpty
							: t.settings.modelAttrsEmptyFilter}
					</li>
				{/if}
				{#each visibleRows as name (name)}
					{@const on = enabled.has(name)}
					{@const attr = attrOf(name)}
					{@const open = on && Boolean(expanded[name])}
					{@const customTags = customStrengths(attr)}
					<li class="model-row" class:is-on={on} class:is-open={open}>
						<div class="model-row-line">
							<button
								type="button"
								role="checkbox"
								aria-checked={on}
								class="model-row-toggle"
								onclick={() => onchange(toggleDraftModel(draft, name))}
							>
								<span class="model-row-box" aria-hidden="true">{on ? '✓' : ''}</span>
								<span class="model-row-name mono">{name}</span>
								{#if name === draft.defaultModel}
									<span class="model-default-tag">{t.settings.modelAttrsDefaultBadge}</span>
								{/if}
								{#if !available.has(name)}
									<span class="model-custom-tag">{t.settings.modelCustomBadge}</span>
								{/if}
							</button>
							{#if on}
								<button
									type="button"
									class="model-row-attrs"
									class:has-custom={hasCustomAttrs(attr)}
									aria-expanded={open}
									aria-label={t.settings.modelAttrsToggle(name)}
									onclick={() => toggleExpanded(name)}
								>
									{#if attr.price.trim()}
										<span class="attr-pill pill-price">{attr.price.trim()}</span>
									{/if}
									{#if attr.thinkingLevels.length !== THINKING_LEVELS.length}
										<span class="attr-pill pill-thinking">{attr.thinkingLevels.join('/')}</span>
									{/if}
									{#each attr.strengths as tag (tag)}
										<span class="attr-pill pill-strengths">{tag}</span>
									{/each}
									<span class="model-row-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
								</button>
							{/if}
						</div>
						{#if open}
							<div class="model-row-body">
								<div class="attr-field">
									<label for={`${fieldPrefix}-price-${name}`} title={t.settings.modelPriceTitle}>
										{t.settings.modelPrice}
									</label>
									<input
										id={`${fieldPrefix}-price-${name}`}
										class="attr-price-input"
										type="number"
										inputmode="decimal"
										min="0"
										step="any"
										placeholder={t.settings.modelPriceHint}
										value={attr.price}
										oninput={(ev) =>
											patchAttr(name, { ...attr, price: (ev.currentTarget as HTMLInputElement).value })}
									/>
								</div>
								<div class="attr-field">
									<span class="attr-field-label">{t.settings.modelThinking}</span>
									<div class="chip-row" role="group" aria-label={t.settings.modelThinking}>
										{#each THINKING_LEVELS as level (level)}
											<button
												type="button"
												class="btn-chip"
												class:active={attr.thinkingLevels.includes(level)}
												aria-pressed={attr.thinkingLevels.includes(level)}
												onclick={() => patchAttr(name, toggleAttrThinkingLevel(attr, level))}
											>
												{level}
											</button>
										{/each}
									</div>
								</div>
								<div class="attr-field attr-field-strengths">
									<span class="attr-field-label">{t.settings.modelStrengths}</span>
									<div class="chip-row" role="group" aria-label={t.settings.modelStrengths}>
										{#each PRESET_STRENGTHS as tag (tag)}
											<button
												type="button"
												class="btn-chip"
												class:active={hasStrength(attr, tag)}
												aria-pressed={hasStrength(attr, tag)}
												onclick={() => patchAttr(name, toggleAttrStrength(attr, tag))}
											>
												{tag}
											</button>
										{/each}
										{#each customTags as tag (tag)}
											<button
												type="button"
												class="btn-chip active is-custom"
												aria-label={t.settings.modelStrengthRemove(tag)}
												onclick={() => patchAttr(name, toggleAttrStrength(attr, tag))}
											>
												{tag} ×
											</button>
										{/each}
										{#if strengthEditing === name}
											<!-- svelte-ignore a11y_autofocus -->
											<input
												type="text"
												class="chip-input mono"
												autofocus
												placeholder={t.settings.modelStrengthsAddPlaceholder}
												bind:value={strengthText}
												onkeydown={(ev) => {
													if (ev.key === 'Enter') {
														ev.preventDefault();
														submitStrength(name);
													} else if (ev.key === 'Escape') {
														ev.preventDefault();
														strengthEditing = null;
													}
												}}
												onblur={() => submitStrength(name)}
											/>
										{:else}
											<button
												type="button"
												class="btn-chip is-add"
												onclick={() => openStrengthInput(name)}
											>
												+ {t.settings.modelStrengthsAdd}
											</button>
										{/if}
									</div>
								</div>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div class="model-picker-foot">
			{#if manualOpen}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					type="text"
					class="model-manual-input mono"
					autofocus
					placeholder={t.settings.modelsAddManualPlaceholder}
					aria-label={t.settings.modelsAddManual}
					bind:value={manualName}
					onkeydown={(ev) => {
						if (ev.key === 'Enter') {
							ev.preventDefault();
							submitManual();
						} else if (ev.key === 'Escape') {
							ev.preventDefault();
							manualOpen = false;
							manualName = '';
						}
					}}
				/>
				<button type="button" class="btn-xs" onclick={submitManual}>
					{t.settings.modelsAddConfirm}
				</button>
			{:else}
				<button type="button" class="btn-text-action" onclick={() => (manualOpen = true)}>
					+ {t.settings.modelsAddManual}
				</button>
			{/if}
		</div>
	</div>
	{#if errors.models}
		<p class="field-error">{t.settings.modelsEmpty}</p>
	{/if}
</div>

<div class="modal-section">
	<label for={`${fieldPrefix}-default`}>{t.settings.defaultModel}</label>
	<Select
		id={`${fieldPrefix}-default`}
		value={draft.defaultModel}
		placeholder={t.settings.defaultModelEmpty}
		emptyLabel={t.settings.defaultModelEmpty}
		options={draft.models}
		error={!!errors.defaultModel}
		onchange={(value) => patch({ defaultModel: value })}
	/>
	{#if errors.defaultModel}
		<p class="field-error">
			{fieldCopy(errors.defaultModel, t.settings.defaultModelEmpty, t.settings.defaultModelInvalid)}
		</p>
	{/if}
</div>
