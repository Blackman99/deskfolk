<script lang="ts">
	import { parseModelLines, type FieldErrorKind } from './wizard-save.ts';
	import type { Copy } from './copy.ts';
	import {
		emptyModelAttr,
		type ProviderDraft,
		type ProviderFieldErrors
	} from './provider-form.ts';
	import { THINKING_LEVELS, type ThinkingLevel } from '@real-bot/protocol';
	import Select from './Select.svelte';

	interface Props {
		draft: ProviderDraft;
		errors: ProviderFieldErrors;
		failed: boolean;
		fetching: boolean;
		fetchError: string | null;
		fieldPrefix: string;
		keyPlaceholder?: string;
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
		keyPlaceholder = '',
		t,
		onchange,
		onfetch
	}: Props = $props();

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	function patch(partial: Partial<ProviderDraft>): void {
		onchange({ ...draft, ...partial });
	}

	function patchAttr(
		name: string,
		partial: Partial<{ price: string; thinkingLevels: string; strengths: string }>
	): void {
		const current = draft.modelAttrs[name] ?? emptyModelAttr();
		patch({
			modelAttrs: {
				...draft.modelAttrs,
				[name]: { ...current, ...partial }
			}
		});
	}

	const listedModels = $derived(parseModelLines(draft.modelsText));

	let filterQuery = $state('');
	let expandedModels = $state<Record<string, boolean>>({});

	const filteredModels = $derived.by(() => {
		const q = filterQuery.trim().toLowerCase();
		if (!q) return listedModels;
		return listedModels.filter((name) => {
			if (name.toLowerCase().includes(q)) return true;
			const attrs = draft.modelAttrs[name];
			if (attrs?.strengths?.toLowerCase().includes(q)) return true;
			if (attrs?.thinkingLevels?.toLowerCase().includes(q)) return true;
			return false;
		});
	});

	function isExpanded(name: string): boolean {
		if (name in expandedModels) return Boolean(expandedModels[name]);
		return listedModels.length <= 3;
	}

	function toggleExpand(name: string): void {
		expandedModels = { ...expandedModels, [name]: !isExpanded(name) };
	}

	const allExpanded = $derived(
		filteredModels.length > 0 && filteredModels.every((name) => isExpanded(name))
	);

	function toggleExpandAll(): void {
		const target = !allExpanded;
		const next: Record<string, boolean> = { ...expandedModels };
		for (const name of filteredModels) {
			next[name] = target;
		}
		expandedModels = next;
	}

	function parseLevels(raw: string): string[] {
		return raw
			.split(/[,/\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
	}

	function isLevelActive(raw: string, level: string): boolean {
		const active = parseLevels(raw);
		return active.includes(level);
	}

	function toggleLevel(name: string, level: ThinkingLevel): void {
		const current = draft.modelAttrs[name]?.thinkingLevels ?? THINKING_LEVELS.join(', ');
		let active = parseLevels(current);
		if (active.includes(level)) {
			active = active.filter((l) => l !== level);
		} else {
			active = [...active, level];
		}
		patchAttr(name, { thinkingLevels: active.join(', ') });
	}

	const PRESET_STRENGTHS = ['code', 'writing', 'reasoning', 'chat'];

	function hasStrengthTag(raw: string, tag: string): boolean {
		const list = raw
			.split(/[,/\s]+/)
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		return list.includes(tag.toLowerCase());
	}

	function toggleStrengthTag(name: string, tag: string): void {
		const current = draft.modelAttrs[name]?.strengths ?? '';
		let list = current
			.split(/[,/\s]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (list.some((s) => s.toLowerCase() === tag.toLowerCase())) {
			list = list.filter((s) => s.toLowerCase() !== tag.toLowerCase());
		} else {
			list = [...list, tag];
		}
		patchAttr(name, { strengths: list.join(', ') });
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
		<button
			type="button"
			class="btn-fetch-models-mini"
			disabled={fetching}
			onclick={onfetch}
		>
			{fetching ? t.settings.modelsFetching : `🔄 ${t.settings.modelsFetch}`}
		</button>
	</div>
	<input
		id={`${fieldPrefix}-key`}
		type="password"
		autocomplete="off"
		placeholder={keyPlaceholder}
		value={draft.apiKey}
		oninput={(ev) => patch({ apiKey: (ev.currentTarget as HTMLInputElement).value })}
	/>
	{#if errors.endpointKey}
		<p class="field-error">{t.settings.keyEmpty}</p>
	{/if}
</div>
{#if fetchError}
	<div class="models-fetch-tip">
		<span class="muted">{fetchError}</span>
	</div>
{/if}
<div class="modal-section">
	<label for={`${fieldPrefix}-models`}>
		{t.settings.models}
		{#if listedModels.length > 0}
			<span class="badge-count-inline">{listedModels.length}</span>
		{/if}
	</label>
	<textarea
		id={`${fieldPrefix}-models`}
		class="mono"
		rows="3"
		value={draft.modelsText}
		oninput={(ev) => patch({ modelsText: (ev.currentTarget as HTMLTextAreaElement).value })}
	></textarea>
	<p class="muted">{t.settings.modelsHint}</p>
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
		options={parseModelLines(draft.modelsText)}
		error={!!errors.defaultModel}
		onchange={(value) => patch({ defaultModel: value })}
	/>
	{#if errors.defaultModel}
		<p class="field-error">
			{fieldCopy(
				errors.defaultModel,
				t.settings.defaultModelEmpty,
				t.settings.defaultModelInvalid
			)}
		</p>
	{/if}
</div>
{#if listedModels.length > 0}
	<div class="modal-section model-attrs-section">
		<div class="model-attrs-header-bar">
			<div class="model-attrs-title-group">
				<span class="model-attrs-title">{t.settings.modelAttrsTitle}</span>
				<span class="model-attrs-count-badge">{t.settings.modelAttrsCount(listedModels.length)}</span>
			</div>
			<div class="model-attrs-actions">
				<button
					type="button"
					class="btn-text-action"
					onclick={toggleExpandAll}
				>
					{allExpanded ? t.settings.modelAttrsCollapseAll : t.settings.modelAttrsExpandAll}
				</button>
			</div>
		</div>
		<p class="muted model-attrs-hint">{t.settings.modelAttrsHint}</p>

		{#if listedModels.length > 3}
			<div class="model-attrs-search-bar">
				<span class="search-icon">🔍</span>
				<input
					type="text"
					class="model-search-input"
					placeholder={t.settings.modelAttrsSearchPlaceholder}
					bind:value={filterQuery}
				/>
				{#if filterQuery}
					<button
						type="button"
						class="search-clear-btn"
						onclick={() => (filterQuery = '')}
					>✕</button>
				{/if}
			</div>
		{/if}

		<div class="model-attrs-list">
			{#if filteredModels.length === 0}
				<div class="model-attrs-empty">
					<span>{t.settings.modelAttrsEmptyFilter}</span>
				</div>
			{/if}
			{#each filteredModels as name (name)}
				{@const attrs = draft.modelAttrs[name] ?? emptyModelAttr()}
				{@const expanded = isExpanded(name)}
				{@const isDefault = name === draft.defaultModel}
				{@const hasCustom = Boolean(
					attrs.price.trim() ||
					(attrs.thinkingLevels.trim() && attrs.thinkingLevels.trim() !== THINKING_LEVELS.join(', ')) ||
					attrs.strengths.trim()
				)}
				<div class="model-attr-item" class:is-expanded={expanded} class:has-custom={hasCustom}>
					<!-- Accordion Header -->
					<button
						type="button"
						class="model-attr-item-head"
						onclick={() => toggleExpand(name)}
						aria-expanded={expanded}
					>
						<div class="head-left">
							<span class="toggle-icon">{expanded ? '▼' : '▶'}</span>
							<span class="model-name-label">{name}</span>
							{#if isDefault}
								<span class="model-default-tag">{t.settings.modelAttrsDefaultBadge}</span>
							{/if}
						</div>
						<div class="head-right">
							{#if attrs.price.trim()}
								<span class="attr-pill pill-price">¥{attrs.price}</span>
							{/if}
							{#if attrs.thinkingLevels.trim() && attrs.thinkingLevels.trim() !== THINKING_LEVELS.join(', ')}
								<span class="attr-pill pill-thinking">{attrs.thinkingLevels}</span>
							{/if}
							{#if attrs.strengths.trim()}
								<span class="attr-pill pill-strengths">{attrs.strengths}</span>
							{/if}
							{#if !attrs.price.trim() && (!attrs.thinkingLevels.trim() || attrs.thinkingLevels.trim() === THINKING_LEVELS.join(', ')) && !attrs.strengths.trim()}
								<span class="attr-pill pill-unset">{t.settings.modelAttrsUnset}</span>
							{/if}
						</div>
					</button>

					<!-- Expanded Body -->
					{#if expanded}
						<div class="model-attr-item-body">
							<div class="attr-grid-row">
								<!-- Price column -->
								<div class="attr-col attr-col-price">
									<div class="field-sublabel-row">
										<label for={`${fieldPrefix}-price-${name}`}>{t.settings.modelPrice}</label>
									</div>
									<input
										id={`${fieldPrefix}-price-${name}`}
										type="text"
										inputmode="decimal"
										value={attrs.price}
										placeholder={t.settings.modelPriceHint}
										oninput={(ev) =>
											patchAttr(name, { price: (ev.currentTarget as HTMLInputElement).value })}
									/>
								</div>

								<!-- Thinking Levels column -->
								<div class="attr-col attr-col-thinking">
									<div class="field-sublabel-row">
										<label for={`${fieldPrefix}-think-${name}`}>{t.settings.modelThinking}</label>
										<div class="quick-levels">
											{#each THINKING_LEVELS as level}
												<button
													type="button"
													class="btn-chip level-chip"
													class:active={isLevelActive(attrs.thinkingLevels, level)}
													onclick={() => toggleLevel(name, level)}
												>
													{level}
												</button>
											{/each}
										</div>
									</div>
									<input
										id={`${fieldPrefix}-think-${name}`}
										type="text"
										value={attrs.thinkingLevels}
										placeholder={t.settings.modelThinkingHint}
										oninput={(ev) =>
											patchAttr(name, { thinkingLevels: (ev.currentTarget as HTMLInputElement).value })}
									/>
								</div>
							</div>

							<!-- Strengths row -->
							<div class="attr-full-row">
								<div class="field-sublabel-row">
									<label for={`${fieldPrefix}-strengths-${name}`}>{t.settings.modelStrengths}</label>
									<div class="quick-tags">
										{#each PRESET_STRENGTHS as tag}
											<button
												type="button"
												class="btn-chip tag-chip"
												class:active={hasStrengthTag(attrs.strengths, tag)}
												onclick={() => toggleStrengthTag(name, tag)}
											>
												+{tag}
											</button>
										{/each}
									</div>
								</div>
								<input
									id={`${fieldPrefix}-strengths-${name}`}
									type="text"
									value={attrs.strengths}
									placeholder={t.settings.modelStrengthsHint}
									oninput={(ev) =>
										patchAttr(name, { strengths: (ev.currentTarget as HTMLInputElement).value })}
								/>
							</div>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
