<script lang="ts">
	import { COPY, JAIL_COPY } from './copy.ts';
	import Select from './Select.svelte';
	import WorkspacePicker from './WorkspacePicker.svelte';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import {
		mapSettingsError,
		parseModelLines,
		type FieldErrorKind,
		type SettingsFieldErrors
	} from './wizard-save.ts';
	import {
		applyProbedModels,
		emptyProviderDraft,
		mapProviderError,
		planCreateProvider,
		type ProviderFieldErrors
	} from './provider-form.ts';
	import type { ProbedModel } from '@real-bot/protocol';

	interface Props {
		runtime: MessengerRuntime;
		onDismiss?: () => void;
	}

	let { runtime, onDismiss }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const t = $derived(COPY[locale]);

	let currentStep = $state<1 | 2 | 3>(1);
	let fieldErrors = $state<SettingsFieldErrors & ProviderFieldErrors>({});
	let saveFailed = $state(false);
	let providerName = $state('Default');
	let activePreset = $state<string>('');
	let fetchingModels = $state(false);
	let fetchError = $state<string | null>(null);
	/** What the endpoint actually returned; saved with the endpoint so Settings can show it again. */
	let probedModels = $state<string[]>([]);
	let probedCatalog = $state<ProbedModel[]>([]);
	let availableDiscoveredModels = $state<string[]>([
		'gpt-4o',
		'gpt-4o-mini',
		'deepseek-chat',
		'deepseek-reasoner',
		'claude-3-5-sonnet',
		'llama3'
	]);
	let modelFilterQuery = $state('');
	let showManualModelEdit = $state(false);
	let customModelInput = $state('');

	const selectedModels = $derived(parseModelLines(runtime.endpointModelsText));
	const allKnownModels = $derived(
		Array.from(new Set([...selectedModels, ...availableDiscoveredModels]))
	);
	const filteredModels = $derived(
		modelFilterQuery.trim()
			? allKnownModels.filter((m) =>
					m.toLowerCase().includes(modelFilterQuery.trim().toLowerCase())
				)
			: allKnownModels
	);

	const PRESETS = [
		{
			id: 'openai',
			name: 'OpenAI',
			url: 'https://api.openai.com/v1',
			models: ['gpt-4o', 'gpt-4o-mini'],
			defaultModel: 'gpt-4o'
		},
		{
			id: 'deepseek',
			name: 'DeepSeek',
			url: 'https://api.deepseek.com/v1',
			models: ['deepseek-chat', 'deepseek-reasoner'],
			defaultModel: 'deepseek-chat'
		},
		{
			id: 'openrouter',
			name: 'OpenRouter',
			url: 'https://openrouter.ai/api/v1',
			models: ['anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
			defaultModel: 'anthropic/claude-3.5-sonnet'
		},
		{
			id: 'ollama',
			name: 'Ollama',
			url: 'http://localhost:11434/v1',
			models: ['llama3', 'qwen2.5'],
			defaultModel: 'llama3'
		},
		{
			id: 'custom',
			name: '自定义',
			url: '',
			models: [],
			defaultModel: ''
		}
	] as const;

	function applyPreset(preset: (typeof PRESETS)[number]): void {
		activePreset = preset.id;
		if (preset.id !== 'custom') {
			providerName = preset.name;
			runtime.endpointUrl = preset.url;
			availableDiscoveredModels = Array.from(new Set([...preset.models, ...availableDiscoveredModels]));
			runtime.endpointModelsText = preset.models.join('\n');
			runtime.endpointDefaultModel = preset.defaultModel;
		} else {
			providerName = t.onboarding.presetCustom;
		}
		if (fieldErrors.endpoint) {
			const next = { ...fieldErrors };
			delete next.endpoint;
			fieldErrors = next;
		}
		if (fieldErrors.models) {
			const next = { ...fieldErrors };
			delete next.models;
			fieldErrors = next;
		}
		if (fieldErrors.defaultModel) {
			const next = { ...fieldErrors };
			delete next.defaultModel;
			fieldErrors = next;
		}
		if (runtime.endpointUrl && runtime.endpointKey) {
			void fetchModels();
		}
	}

	let autoFetchTimer: ReturnType<typeof setTimeout> | null = null;
	function onEndpointOrKeyInput(): void {
		if (fieldErrors.endpoint) {
			const next = { ...fieldErrors };
			delete next.endpoint;
			fieldErrors = next;
		}
		if (fieldErrors.endpointKey) {
			const next = { ...fieldErrors };
			delete next.endpointKey;
			fieldErrors = next;
		}
		if (autoFetchTimer) clearTimeout(autoFetchTimer);
		if (runtime.endpointUrl.trim().startsWith('http') && runtime.endpointKey.trim()) {
			autoFetchTimer = setTimeout(() => {
				void fetchModels();
			}, 700);
		}
	}

	async function fetchModels(): Promise<void> {
		const baseUrl = runtime.endpointUrl.trim();
		const apiKey = runtime.endpointKey.trim();
		if (!baseUrl) {
			fetchError = t.settings.endpointEmpty;
			return;
		}
		fetchingModels = true;
		fetchError = null;
		const res = await runtime.probeModels(baseUrl, apiKey);
		fetchingModels = false;
		if (!res.ok) {
			fetchError = `${t.settings.modelsFetchFailed} (${res.error})`;
			return;
		}
		if (res.models.length > 0) {
			probedModels = res.models;
			probedCatalog = res.catalog ?? [];
			availableDiscoveredModels = res.models;
			const current = parseModelLines(runtime.endpointModelsText);
			const matching = current.filter((m) => res.models.includes(m));
			const nextSelected = matching.length > 0 ? matching : res.models.slice(0, 3);
			runtime.endpointModelsText = nextSelected.join('\n');
			if (!nextSelected.includes(runtime.endpointDefaultModel)) {
				runtime.endpointDefaultModel = nextSelected[0] ?? '';
			}
		}
	}

	function advanceFromStep1(): void {
		const ws = runtime.workspacePath.trim();
		if (!ws) {
			fieldErrors = { ...fieldErrors, workspace: 'empty' };
			return;
		}
		if (!ws.startsWith('/') && ws !== '~' && !ws.startsWith('~/')) {
			fieldErrors = { ...fieldErrors, workspace: 'invalid' };
			return;
		}
		const errs = { ...fieldErrors };
		delete errs.workspace;
		fieldErrors = errs;
		currentStep = 2;
	}

	function advanceFromStep2(): void {
		const ep = runtime.endpointUrl.trim();
		const key = runtime.endpointKey.trim();
		let hasErr = false;
		const errs = { ...fieldErrors };
		if (!ep) {
			errs.endpoint = 'empty';
			hasErr = true;
		} else if (!ep.startsWith('http://') && !ep.startsWith('https://')) {
			errs.endpoint = 'invalid';
			hasErr = true;
		} else {
			delete errs.endpoint;
		}
		if (!key) {
			errs.endpointKey = 'empty';
			hasErr = true;
		} else {
			delete errs.endpointKey;
		}
		fieldErrors = errs;
		if (hasErr) return;
		currentStep = 3;
		if (availableDiscoveredModels.length <= 6 && runtime.endpointUrl && runtime.endpointKey) {
			void fetchModels();
		}
	}

	function goToStep(step: 1 | 2 | 3): void {
		if (step === 1) {
			currentStep = 1;
		} else if (step === 2) {
			if (runtime.workspacePath.trim()) currentStep = 2;
			else advanceFromStep1();
		} else if (step === 3) {
			if (runtime.workspacePath.trim() && runtime.endpointUrl.trim() && runtime.endpointKey.trim()) {
				currentStep = 3;
			} else if (!runtime.workspacePath.trim()) {
				currentStep = 1;
				advanceFromStep1();
			} else {
				currentStep = 2;
				advanceFromStep2();
			}
		}
	}

	function toggleModelSelection(model: string): void {
		const current = parseModelLines(runtime.endpointModelsText);
		let next: string[];
		if (current.includes(model)) {
			next = current.filter((m) => m !== model);
		} else {
			next = [...current, model];
		}
		runtime.endpointModelsText = next.join('\n');
		if (!next.includes(runtime.endpointDefaultModel)) {
			runtime.endpointDefaultModel = next[0] ?? '';
		}
		if (fieldErrors.models && next.length > 0) {
			const errs = { ...fieldErrors };
			delete errs.models;
			fieldErrors = errs;
		}
		if (fieldErrors.defaultModel && runtime.endpointDefaultModel) {
			const errs = { ...fieldErrors };
			delete errs.defaultModel;
			fieldErrors = errs;
		}
	}

	function selectAllModels(): void {
		runtime.endpointModelsText = filteredModels.join('\n');
		if (!runtime.endpointDefaultModel && filteredModels.length > 0) {
			runtime.endpointDefaultModel = filteredModels[0];
		}
	}

	function deselectAllModels(): void {
		runtime.endpointModelsText = '';
		runtime.endpointDefaultModel = '';
	}

	function addCustomModel(): void {
		const name = customModelInput.trim();
		if (!name) return;
		if (!availableDiscoveredModels.includes(name)) {
			availableDiscoveredModels = [name, ...availableDiscoveredModels];
		}
		toggleModelSelection(name);
		customModelInput = '';
	}

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	async function handleComplete(): Promise<void> {
		saveFailed = false;
		fieldErrors = {};
		const workspace = runtime.workspacePath.trim();
		if (!workspace) {
			fieldErrors = { workspace: 'empty' };
			currentStep = 1;
			return;
		}
		if (!workspace.startsWith('/') && workspace !== '~' && !workspace.startsWith('~/')) {
			fieldErrors = { workspace: 'invalid' };
			currentStep = 1;
			return;
		}
		const providerPlan = planCreateProvider(
			applyProbedModels(
				{
					...emptyProviderDraft(),
					name: providerName || 'Default',
					baseUrl: runtime.endpointUrl,
					apiKey: runtime.endpointKey,
					models: parseModelLines(runtime.endpointModelsText),
					availableModels: probedModels,
					defaultModel: runtime.endpointDefaultModel
				},
				{ models: probedModels, catalog: probedCatalog }
			),
			!snapshot.settings.wizard_complete
		);
		if (!providerPlan.ok) {
			fieldErrors = providerPlan.errors;
			if (fieldErrors.endpoint || fieldErrors.endpointKey || fieldErrors.name) currentStep = 2;
			else if (fieldErrors.models || fieldErrors.defaultModel) currentStep = 3;
			return;
		}
		const workspaceError = await runtime.patchSettings({ workspace_path: workspace });
		if (workspaceError) {
			const mapped = mapSettingsError(workspaceError.message);
			if ('workspace' in mapped) {
				fieldErrors = { workspace: mapped.workspace };
				currentStep = 1;
				return;
			}
			saveFailed = true;
			return;
		}
		const existing = snapshot.providers[0];
		const providerError = existing
			? await runtime.patchProvider(existing.id, {
					name: providerPlan.body.name,
					base_url: providerPlan.body.base_url,
					api_key: providerPlan.body.api_key,
					models: providerPlan.body.models,
					available_models: providerPlan.body.available_models,
					default_model: providerPlan.body.default_model
				})
			: await runtime.createProvider(providerPlan.body);
		if (!providerError) return;
		const mapped = mapProviderError(providerError.message);
		if ('top' in mapped) {
			saveFailed = true;
			return;
		}
		fieldErrors = mapped;
		if (mapped.endpoint || mapped.endpointKey) currentStep = 2;
		else currentStep = 3;
	}
</script>

<div class="onboarding-screen">
	<div class="onboarding-card">
		<div class="onboarding-hero">
			<div class="onboarding-icon-box">
				<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2a3 3 0 0 0-3 3v1a6 6 0 0 0-6 6v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a6 6 0 0 0-6-6V5a3 3 0 0 0-3-3z"></path>
					<circle cx="9" cy="13" r="1.5" fill="currentColor"></circle>
					<circle cx="15" cy="13" r="1.5" fill="currentColor"></circle>
					<path d="M10 17h4"></path>
				</svg>
			</div>
			<h1 class="onboarding-title">{t.onboarding.welcome}</h1>
			<p class="onboarding-subtitle">{t.onboarding.subtitle}</p>
		</div>

		<!-- Step Bar -->
		<div class="onboarding-step-bar" role="tablist" aria-label="Setup steps">
			<button
				type="button"
				class="step-bar-item"
				class:is-active={currentStep === 1}
				class:is-complete={currentStep > 1}
				onclick={() => goToStep(1)}
			>
				<div class="step-bar-circle">{currentStep > 1 ? '✓' : '1'}</div>
				<span class="step-bar-label">{t.onboarding.step1Title}</span>
			</button>

			<div class="step-bar-line" class:is-complete={currentStep > 1}></div>

			<button
				type="button"
				class="step-bar-item"
				class:is-active={currentStep === 2}
				class:is-complete={currentStep > 2}
				onclick={() => goToStep(2)}
			>
				<div class="step-bar-circle">{currentStep > 2 ? '✓' : '2'}</div>
				<span class="step-bar-label">{t.onboarding.step2Title}</span>
			</button>

			<div class="step-bar-line" class:is-complete={currentStep > 2}></div>

			<button
				type="button"
				class="step-bar-item"
				class:is-active={currentStep === 3}
				onclick={() => goToStep(3)}
			>
				<div class="step-bar-circle">3</div>
				<span class="step-bar-label">{t.onboarding.step3Title}</span>
			</button>
		</div>

		{#if saveFailed}
			<div class="onboarding-alert-error">
				<p>{t.settings.saveFailed}</p>
			</div>
		{/if}

		<!-- Step Content -->
		<div class="onboarding-step-content">
			{#if currentStep === 1}
				<!-- Step 1: Workspace -->
				<div class="step-pane">
					<div class="step-pane-header">
						<h2 class="step-pane-title">{t.onboarding.stepWorkspace}</h2>
						<p class="step-pane-desc">{t.onboarding.workspaceDesc}</p>
					</div>

					<div class="modal-section">
						<p class="field-head" id="onboarding-workspace-label">{t.settings.workspace}</p>
						<WorkspacePicker
							id="onboarding-workspace"
							path={runtime.workspacePath}
							chooseLabel={t.settings.workspaceChoose}
							changeLabel={t.settings.workspaceChange}
							emptyLabel={t.settings.workspaceUnsetValue}
							unavailableLabel={t.settings.workspacePickerUnavailable}
							dialogTitle={t.settings.workspaceChoose}
							onChange={(next) => {
								runtime.workspacePath = next;
								if (fieldErrors.workspace) {
									const nextErrors = { ...fieldErrors };
									delete nextErrors.workspace;
									fieldErrors = nextErrors;
								}
							}}
						/>
						<button
							type="button"
							class="btn-preset-workspace"
							onclick={() => {
								runtime.workspacePath = '~/real-bot-workspace';
								if (fieldErrors.workspace) {
									const next = { ...fieldErrors };
									delete next.workspace;
									fieldErrors = next;
								}
							}}
						>
							{t.onboarding.useDefaultWorkspace}
						</button>
						<p class="jail">{JAIL_COPY[locale]}</p>
						{#if fieldErrors.workspace}
							<p class="field-error">
								{fieldCopy(
									fieldErrors.workspace,
									t.settings.workspaceEmpty,
									t.settings.workspaceInvalid
								)}
							</p>
						{/if}
					</div>

					<div class="step-nav-footer">
						<div></div>
						<button type="button" class="btn-step-primary" onclick={advanceFromStep1}>
							{t.onboarding.step1Next} →
						</button>
					</div>
				</div>
			{:else if currentStep === 2}
				<!-- Step 2: Provider & Auth -->
				<div class="step-pane">
					<div class="step-pane-header">
						<h2 class="step-pane-title">{t.onboarding.stepProvider}</h2>
						<p class="step-pane-desc">{t.onboarding.providerDesc}</p>
					</div>

					<div class="provider-presets-row">
						{#each PRESETS as preset}
							<button
								type="button"
								class="preset-chip"
								class:is-active={activePreset === preset.id}
								onclick={() => applyPreset(preset)}
							>
								{preset.id === 'custom' ? t.onboarding.presetCustom : preset.name}
							</button>
						{/each}
					</div>

					<div class="modal-section">
						<label for="onboarding-provider-name">{t.settings.providerName}</label>
						<input
							id="onboarding-provider-name"
							type="text"
							bind:value={providerName}
						/>
						{#if fieldErrors.name}
							<p class="field-error">{t.settings.providerNameEmpty}</p>
						{/if}
					</div>

					<div class="modal-section">
						<label for="onboarding-endpoint">{t.settings.endpoint}</label>
						<input
							id="onboarding-endpoint"
							type="text"
							placeholder="https://api.openai.com/v1"
							bind:value={runtime.endpointUrl}
							oninput={onEndpointOrKeyInput}
						/>
						{#if fieldErrors.endpoint}
							<p class="field-error">
								{fieldCopy(
									fieldErrors.endpoint,
									t.settings.endpointEmpty,
									t.settings.endpointInvalid
								)}
							</p>
						{/if}
					</div>

					<div class="modal-section">
						<div class="field-head-row">
							<label for="onboarding-endpoint-key">{t.settings.endpointKey}</label>
							<button
								type="button"
								class="btn-fetch-models-mini"
								disabled={fetchingModels}
								onclick={fetchModels}
							>
								{fetchingModels ? t.settings.modelsFetching : `🔄 ${t.settings.modelsFetch}`}
							</button>
						</div>
						<input
							id="onboarding-endpoint-key"
							type="password"
							autocomplete="off"
							placeholder={t.settings.keyEmpty}
							bind:value={runtime.endpointKey}
							oninput={onEndpointOrKeyInput}
						/>
						{#if fieldErrors.endpointKey}
							<p class="field-error">{t.settings.keyEmpty}</p>
						{/if}
					</div>

					{#if fetchError}
						<div class="models-fetch-tip">
							<span class="muted">{fetchError}</span>
						</div>
					{/if}

					<div class="step-nav-footer">
						<button type="button" class="btn-step-secondary" onclick={() => (currentStep = 1)}>
							← {t.onboarding.prevStep}
						</button>
						<button type="button" class="btn-step-primary" onclick={advanceFromStep2}>
							{t.onboarding.step2Next} →
						</button>
					</div>
				</div>
			{:else if currentStep === 3}
				<!-- Step 3: Models & Default Model -->
				<div class="step-pane">
					<div class="step-pane-header">
						<h2 class="step-pane-title">{t.onboarding.step3Title}</h2>
						<p class="step-pane-desc">{t.onboarding.stepModelsDesc}</p>
					</div>

					<!-- Models Selector -->
					<div class="modal-section">
						<div class="field-head-row">
							<label for="endpoint-models">{t.settings.modelsSelectTitle}</label>
							<div class="model-head-actions">
								<button
									type="button"
									class="btn-text-action"
									onclick={() => (showManualModelEdit = !showManualModelEdit)}
								>
									{showManualModelEdit ? t.settings.modelsListToggle : t.settings.modelsManualToggle}
								</button>
							</div>
						</div>

						{#if showManualModelEdit}
							<textarea
								id="endpoint-models"
								class="mono"
								rows="3"
								placeholder="gpt-4o"
								bind:value={runtime.endpointModelsText}
							></textarea>
						{:else}
							<div class="models-selector-box">
								{#if allKnownModels.length > 4}
									<div class="models-filter-bar">
										<input
											type="text"
											class="models-filter-input"
											placeholder={t.settings.modelsSearchPlaceholder}
											bind:value={modelFilterQuery}
										/>
										<button type="button" class="btn-xs" onclick={selectAllModels}>{t.settings.modelsSelectAll}</button>
										<button type="button" class="btn-xs" onclick={deselectAllModels}>{t.settings.modelsDeselectAll}</button>
									</div>
								{/if}

								<div class="models-chips-container">
									{#each filteredModels as model (model)}
										{@const isSelected = selectedModels.includes(model)}
										<button
											type="button"
											class="model-chip"
											class:is-selected={isSelected}
											onclick={() => toggleModelSelection(model)}
										>
											<span class="model-chip-check">{isSelected ? '✓' : ''}</span>
											<span class="model-chip-text">{model}</span>
										</button>
									{/each}
								</div>

								<div class="model-custom-add-row">
									<input
										type="text"
										class="custom-model-input"
										placeholder={t.settings.modelsAddCustom}
										bind:value={customModelInput}
										onkeydown={(e) => {
											if (e.key === 'Enter') {
												e.preventDefault();
												addCustomModel();
											}
										}}
									/>
									<button type="button" class="btn-add-custom" onclick={addCustomModel}>+</button>
								</div>
							</div>
						{/if}

						{#if fieldErrors.models}
							<p class="field-error">{t.settings.modelsEmpty}</p>
						{/if}
					</div>

					<!-- Default Model Dropdown -->
					<div class="modal-section">
						<label for="onboarding-default-model">{t.settings.defaultModel}</label>
						<Select
							id="onboarding-default-model"
							bind:value={runtime.endpointDefaultModel}
							placeholder={t.settings.defaultModelEmpty}
							emptyLabel={t.settings.defaultModelEmpty}
							options={selectedModels}
							error={!!fieldErrors.defaultModel}
							onchange={() => {
								if (fieldErrors.defaultModel) {
									const next = { ...fieldErrors };
									delete next.defaultModel;
									fieldErrors = next;
								}
							}}
						/>
						{#if fieldErrors.defaultModel}
							<p class="field-error">
								{fieldCopy(
									fieldErrors.defaultModel,
									t.settings.defaultModelEmpty,
									t.settings.defaultModelInvalid
								)}
							</p>
						{/if}
					</div>

					<div class="step-nav-footer">
						<button type="button" class="btn-step-secondary" onclick={() => (currentStep = 2)}>
							← {t.onboarding.prevStep}
						</button>
						<button type="button" class="btn-step-primary" onclick={handleComplete}>
							{t.onboarding.submit} ✓
						</button>
					</div>
				</div>
			{/if}
		</div>

		<!-- Skip footer link -->
		{#if onDismiss}
			<div class="onboarding-foot">
				<button type="button" class="btn-onboarding-skip" onclick={onDismiss}>
					{t.onboarding.skip}
				</button>
			</div>
		{/if}
	</div>
</div>
