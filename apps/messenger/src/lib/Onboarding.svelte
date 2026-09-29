<script lang="ts">
	import BrandMark from './BrandMark.svelte';
	import AvatarEditor from './AvatarEditor.svelte';
	import { COPY, JAIL_COPY } from './copy.ts';
	import Select from './Select.svelte';
	import WorkspacePicker from './settings/WorkspacePicker.svelte';
	import type { MessengerRuntime } from './runtime.svelte.ts';
	import {
		looksLikeAbsoluteOrHome,
		mapSettingsError,
		parseModelLines,
		type FieldErrorKind,
		type SettingsFieldErrors
	} from './settings/wizard-save.ts';
	import {
		applyProbedModels,
		emptyProviderDraft,
		mapProviderError,
		planCreateProvider,
		type ProviderFieldErrors
	} from './settings/provider-form.ts';
	import {
		botNameErrorCopy,
		mapCreateBotError,
		planCreateBot,
		type CreateBotDraft,
		type CreateBotFieldErrors
	} from './panels/create-form.ts';
	import type { CreateProviderRequest, ProbedModel } from '@real-bot/protocol';

	interface Props {
		runtime: MessengerRuntime;
		onDismiss?: () => void;
		/**
		 * The wizard asking to stay up. Saving the endpoint completes setup, which is what takes the
		 * wizard down, but its last step, the first Bot, comes after that. Held from the save on while
		 * the roster is empty; let go once the Bot is made or the step is skipped.
		 */
		holding?: boolean;
	}

	let { runtime, onDismiss, holding = $bindable(false) }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const t = $derived(COPY[locale]);
	const workspaceReadOnly = $derived(runtime.hosted || runtime.remote);

	let currentStep = $state<1 | 2 | 3 | 4>(1);
	/** Nobody on the roster yet: saving setup leads on to the first Bot instead of into the app. */
	const rosterEmpty = $derived(snapshot.bots.every((bot) => bot.archived_at));
	/** Setup is saved and behind the user; its steps no longer open. */
	const setupSaved = $derived(currentStep === 4);
	const showBotStep = $derived(rosterEmpty || setupSaved);
	$effect.pre(() => {
		if (workspaceReadOnly && currentStep === 1) currentStep = 2;
	});
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
		if (!looksLikeAbsoluteOrHome(ws)) {
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
		if (setupSaved) return;
		if (workspaceReadOnly && step === 1) {
			currentStep = 2;
			return;
		}
		if (step === 1) {
			currentStep = 1;
		} else if (step === 2) {
			if (workspaceReadOnly || runtime.workspacePath.trim()) currentStep = 2;
			else advanceFromStep1();
		} else if (step === 3) {
			if ((workspaceReadOnly || runtime.workspacePath.trim()) && runtime.endpointUrl.trim() && runtime.endpointKey.trim()) {
				currentStep = 3;
			} else if (!workspaceReadOnly && !runtime.workspacePath.trim()) {
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
		if (!workspaceReadOnly) {
			if (!workspace) {
				fieldErrors = { workspace: 'empty' };
				currentStep = 1;
				return;
			}
			if (!looksLikeAbsoluteOrHome(workspace)) {
				fieldErrors = { workspace: 'invalid' };
				currentStep = 1;
				return;
			}
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
		// Either save below can complete setup, and the wizard comes down with it unless held.
		holding = rosterEmpty;
		if (!(await saveSetup(workspace, providerPlan.body))) {
			holding = false;
			return;
		}
		if (holding) enterBotStep();
	}

	/** Writes the workspace and the endpoint; false, with the reason on screen, when either is refused. */
	async function saveSetup(workspace: string, provider: CreateProviderRequest): Promise<boolean> {
		if (!workspaceReadOnly) {
			const workspaceError = await runtime.patchSettings({ workspace_path: workspace });
			if (workspaceError) {
				const mapped = mapSettingsError(workspaceError.message);
				if ('workspace' in mapped) {
					fieldErrors = { workspace: mapped.workspace };
					currentStep = 1;
					return false;
				}
				saveFailed = true;
				return false;
			}
		}
		const existing = snapshot.providers[0];
		const providerError = existing
			? await runtime.patchProvider(existing.id, {
					name: provider.name,
					base_url: provider.base_url,
					api_key: provider.api_key,
					models: provider.models,
					available_models: provider.available_models,
					default_model: provider.default_model
				})
			: await runtime.createProvider(provider);
		if (!providerError) return true;
		const mapped = mapProviderError(providerError.message);
		if ('top' in mapped) {
			saveFailed = true;
			return false;
		}
		fieldErrors = mapped;
		if (mapped.endpoint || mapped.endpointKey) currentStep = 2;
		else currentStep = 3;
		return false;
	}

	let botDraft = $state<CreateBotDraft>({ name: '', duties: '', boundaries: '', avatar: '', model: '' });
	let botErrors = $state<CreateBotFieldErrors>({});
	let botFailed = $state(false);
	let creatingBot = $state(false);

	/**
	 * A suggested first teammate, filled in so one click makes it. No model: it runs on the default
	 * model just chosen, and the profile can pin another later.
	 */
	function enterBotStep(): void {
		botDraft = {
			name: t.onboarding.botNameSuggested,
			duties: t.onboarding.botDutiesSuggested,
			boundaries: t.onboarding.botBoundariesSuggested,
			avatar: '',
			model: ''
		};
		botErrors = {};
		botFailed = false;
		currentStep = 4;
	}

	function onBotInput(): void {
		botErrors = {};
		botFailed = false;
	}

	async function createFirstBot(): Promise<void> {
		if (creatingBot) return;
		botFailed = false;
		botErrors = {};
		const plan = planCreateBot(botDraft);
		if (!plan.ok) {
			botErrors = plan.errors;
			return;
		}
		creatingBot = true;
		const error = await runtime.createBot(plan.body);
		creatingBot = false;
		// Made: the runtime has already opened the new Bot's direct, which is where the wizard lets go to.
		if (!error) {
			holding = false;
			return;
		}
		const mapped = mapCreateBotError(error.status, error.message);
		if ('top' in mapped) botFailed = true;
		else botErrors = mapped;
	}
</script>

<div class="onboarding-screen w-[100vw] h-screen bg-bg flex p-10 overflow-y-auto box-border">
	<div class="onboarding-card">
		<div class="onboarding-hero text-center flex flex-col items-center gap-3">
			<BrandMark size={52} />
			<h1 class="onboarding-title">{t.onboarding.welcome}</h1>
			<p class="onboarding-subtitle m-0 text-13 text-muted max-w-[480px] leading-[1.45]">{t.onboarding.subtitle}</p>
		</div>

		<!-- Step Bar -->
		<div class="onboarding-step-bar" role="tablist" aria-label="Setup steps">
			{#if !workspaceReadOnly}
				<button
					type="button"
					class="step-bar-item"
					class:is-active={currentStep === 1}
					class:is-complete={currentStep > 1}
					disabled={setupSaved}
					onclick={() => goToStep(1)}
				>
					<div class="step-bar-circle">{currentStep > 1 ? '✓' : '1'}</div>
					<span class="step-bar-label">{t.onboarding.step1Title}</span>
				</button>

				<div class="step-bar-line" class:is-complete={currentStep > 1}></div>
			{/if}

			<button
				type="button"
				class="step-bar-item"
				class:is-active={currentStep === 2}
				class:is-complete={currentStep > 2}
				disabled={setupSaved}
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
				class:is-complete={currentStep > 3}
				disabled={setupSaved}
				onclick={() => goToStep(3)}
			>
				<div class="step-bar-circle">{currentStep > 3 ? '✓' : '3'}</div>
				<span class="step-bar-label">{t.onboarding.step3Title}</span>
			</button>

			{#if showBotStep}
				<div class="step-bar-line" class:is-complete={currentStep > 3}></div>

				<!-- Reached only by saving step 3; there is nothing to jump to before that. -->
				<button
					type="button"
					class="step-bar-item"
					class:is-active={currentStep === 4}
					disabled
				>
					<div class="step-bar-circle">4</div>
					<span class="step-bar-label">{t.onboarding.step4Title}</span>
				</button>
			{/if}
		</div>

		{#if saveFailed}
			<div class="onboarding-alert-error">
				<p>{t.settings.saveFailed}</p>
			</div>
		{/if}

		<!-- Step Content -->
		<div class="onboarding-step-content flex flex-col">
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
								runtime.workspacePath = '~/deskfolk-workspace';
								if (fieldErrors.workspace) {
									const next = { ...fieldErrors };
									delete next.workspace;
									fieldErrors = next;
								}
							}}
						>
							{t.onboarding.useDefaultWorkspace}
						</button>
						<p class="jail mt-3 mx-0 mb-0 text-12 text-muted leading-[1.45] bg-line-subtle py-3 px-4 rounded-sm">{JAIL_COPY[locale]}</p>
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

					{#if workspaceReadOnly}
						<p class="muted field-hint">{t.settings.workspaceHostOnly}</p>
					{/if}

					<div class="provider-presets-row flex flex-wrap gap-3">
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
						{#if workspaceReadOnly}
							<div></div>
						{:else}
							<button type="button" class="btn-step-secondary" onclick={() => (currentStep = 1)}>
								← {t.onboarding.prevStep}
							</button>
						{/if}
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
							<div class="model-head-actions flex items-center gap-4">
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
									<div class="models-filter-bar flex gap-3 items-center">
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

								<div class="models-chips-container flex flex-wrap gap-3 max-h-[140px] overflow-y-auto p-1">
									{#each filteredModels as model (model)}
										{@const isSelected = selectedModels.includes(model)}
										<button
											type="button"
											class="model-chip"
											class:is-selected={isSelected}
											onclick={() => toggleModelSelection(model)}
										>
											<span class="model-chip-check text-11 font-bold min-w-5 text-accent">{isSelected ? '✓' : ''}</span>
											<span class="model-chip-text font-mono text-12">{model}</span>
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
							{#if rosterEmpty}
								{t.onboarding.step3Next} →
							{:else}
								{t.onboarding.submit} ✓
							{/if}
						</button>
					</div>
				</div>
			{:else if currentStep === 4}
				<!-- Step 4: First Bot -->
				<div class="step-pane">
					<div class="step-pane-header">
						<h2 class="step-pane-title">{t.onboarding.stepBot}</h2>
						<p class="step-pane-desc">{t.onboarding.botDesc}</p>
					</div>

					{#if botFailed}
						<p class="field-error">{t.sidebar.saveFailed}</p>
					{/if}

					<div class="modal-section">
						<span class="field-head">{t.sidebar.botAvatar}</span>
						<AvatarEditor bind:avatar={botDraft.avatar} name={botDraft.name} {t} onchange={onBotInput} />
					</div>

					<div class="modal-section">
						<label for="onboarding-bot-name">{t.sidebar.botName}</label>
						<input id="onboarding-bot-name" type="text" bind:value={botDraft.name} oninput={onBotInput} />
						{#if botErrors.name}
							<p class="field-error">{botNameErrorCopy(botErrors.name, t.sidebar)}</p>
						{/if}
					</div>

					<div class="modal-section">
						<label for="onboarding-bot-duties">{t.sidebar.botDuties}</label>
						<textarea id="onboarding-bot-duties" rows="3" bind:value={botDraft.duties} oninput={onBotInput}></textarea>
						{#if botErrors.duties}
							<p class="field-error">{t.sidebar.dutiesEmpty}</p>
						{/if}
					</div>

					<div class="modal-section">
						<label for="onboarding-bot-boundaries">{t.sidebar.botBoundaries}</label>
						<textarea id="onboarding-bot-boundaries" rows="2" bind:value={botDraft.boundaries} oninput={onBotInput}></textarea>
						{#if botErrors.boundaries}
							<p class="field-error">{t.sidebar.boundariesEmpty}</p>
						{:else}
							<p class="muted field-hint">{t.onboarding.botModelHint}</p>
						{/if}
					</div>

					<div class="step-nav-footer">
						<button type="button" class="btn-step-secondary" onclick={() => (holding = false)}>
							{t.onboarding.skipBot}
						</button>
						<button type="button" class="btn-step-primary" disabled={creatingBot} onclick={createFirstBot}>
							{t.onboarding.createBot} ✓
						</button>
					</div>
				</div>
			{/if}
		</div>

		<!-- Skip footer link: setup is still to do. Past the save it is, and the Bot step skips itself. -->
		{#if onDismiss && !setupSaved}
			<div class="onboarding-foot flex flex-col items-center gap-5 mt-2">
				<button type="button" class="btn-onboarding-skip" onclick={onDismiss}>
					{t.onboarding.skip}
				</button>
			</div>
		{/if}
	</div>
</div>

<style>

	/*
	 * Centred by its own auto margins, not by the screen's flex alignment: a card taller than the
	 * window (the Bot step is) then starts at the top and scrolls, instead of overflowing both ends
	 * with its top out of reach.
	 */
	.onboarding-card {
		margin: auto;
		width: 620px;
		max-width: 100%;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-lg);
		padding: 28px 32px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		animation: modalScaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
	}

	/*
	 * The provider fields sit in neither a `.modal-body` nor a `.sheet`, where the shared input
	 * styles live, so they rendered as bare browser inputs. Same look as those.
	 */
	#onboarding-provider-name,
	#onboarding-endpoint,
	#onboarding-endpoint-key,
	#onboarding-bot-name,
	#onboarding-bot-duties,
	#onboarding-bot-boundaries {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		background: var(--input-bg);
		color: var(--ink);
		font-size: 14px;
		box-shadow: var(--shadow-xs);
		outline: none;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	#onboarding-provider-name:focus,
	#onboarding-endpoint:focus,
	#onboarding-endpoint-key:focus,
	#onboarding-bot-name:focus,
	#onboarding-bot-duties:focus,
	#onboarding-bot-boundaries:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	#onboarding-bot-duties,
	#onboarding-bot-boundaries {
		min-height: 60px;
		resize: vertical;
		font-family: inherit;
		line-height: 1.45;
	}

	.onboarding-title {
		margin: 0;
		font-size: 24px;
		font-weight: 700;
		color: var(--ink);
		letter-spacing: -0.01em;
	}

	/* Onboarding Step Bar */
	/* The steps sit on the card itself: the box they had around them was a card inside the card. */
	.onboarding-step-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 0;
		position: relative;
	}

	.step-bar-item {
		display: flex;
		align-items: center;
		gap: 8px;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 4px 8px;
		border-radius: var(--radius-md);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		z-index: 2;
	}

	.step-bar-item:hover:not(:disabled) {
		background: var(--row-hover);
	}

	.step-bar-item:disabled {
		cursor: default;
	}

	.step-bar-circle {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background: var(--chip);
		border: 1.5px solid var(--chip-line);
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 12px;
		font-weight: 700;
		transition: 0.2s ease;
		transition-property: var(--transition-props);
		flex-shrink: 0;
	}

	/* The step you are on is ringed in the accent; a finished one is filled with it. Green is for
	   a check that passed, and a step behind you is just done. */
	.step-bar-item.is-active .step-bar-circle {
		background: var(--pane);
		border: 2px solid var(--accent);
		color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	.step-bar-item.is-complete .step-bar-circle {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.step-bar-label {
		font-size: 13px;
		font-weight: 500;
		color: var(--muted);
		transition: color 0.15s ease;
		white-space: nowrap;
	}

	.step-bar-item.is-active .step-bar-label {
		color: var(--ink);
		font-weight: 600;
	}

	.step-bar-item.is-complete .step-bar-label {
		color: var(--ink-secondary);
	}

	.step-bar-line {
		flex: 1;
		height: 2px;
		background: var(--line);
		margin: 0 4px;
		z-index: 1;
		transition: background 0.2s ease;
	}

	.step-bar-line.is-complete {
		background: var(--accent);
	}

	/* The step's content is part of the card under a hairline, not another bordered card in it. */
	.step-pane {
		border-top: 1px solid var(--line-subtle);
		padding-top: 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		animation: modalScaleIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.step-pane-header {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.step-pane-title {
		margin: 0;
		font-size: var(--text-heading);
		font-weight: 650;
		color: var(--ink);
	}

	.step-pane-desc {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
		line-height: 1.45;
	}

	.step-nav-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 6px;
		padding-top: 14px;
		border-top: 1px solid var(--line-subtle);
	}

	.btn-step-primary {
		padding: 8px 18px;
		background: var(--accent);
		color: var(--on-accent);
		border: none;
		border-radius: var(--radius-md);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		box-shadow: 0 2px 6px color-mix(in srgb, var(--accent) 20%, transparent);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-step-primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.btn-step-primary:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.btn-step-secondary {
		padding: 7px 14px;
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-step-secondary:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
		color: var(--ink);
	}

	/*
	 * `:global` because the button being reached for is WorkspacePicker's,
 not ours. Scoped,
 this
	 * matched only the copy we render ourselves,
 and the picker's grew from 32px to 38.25px —
	 * `svelte-check` says nothing,
 because the selector is still in use here.
	 */
	.onboarding-step-content :global(.btn-preset-workspace) {
		align-self: flex-start;
	}

	.preset-chip {
		padding: 5px 12px;
		border-radius: var(--radius-full);
		font-size: 12px;
		font-weight: 500;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--ink-secondary);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		cursor: pointer;
	}

	.preset-chip:hover {
		background: var(--pane);
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.preset-chip.is-active {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
		box-shadow: 0 2px 6px color-mix(in srgb, var(--accent) 25%, transparent);
	}

	.btn-onboarding-skip {
		background: transparent;
		border: none;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
		padding: 4px 8px;
		transition: color 0.15s ease;
	}

	.btn-onboarding-skip:hover {
		color: var(--ink);
		text-decoration: underline;
	}

	.onboarding-alert-error {
		padding: 8px 14px;
		background: var(--danger-bg);
		border: 1px solid var(--danger-line);
		border-radius: var(--radius-md);
		color: var(--danger);
		font-size: 13px;
		font-weight: 500;
	}

	.onboarding-alert-error p {
		margin: 0;
	}

	.models-selector-box {
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.models-filter-input {
		flex: 1;
		padding: 4px 8px !important;
		font-size: 12px !important;
		border: 1px solid var(--line) !important;
		border-radius: var(--radius-sm) !important;
		background: var(--input-bg) !important;
	}

	.model-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		user-select: none;
	}

	.model-chip:hover {
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.model-chip.is-selected {
		background: var(--accent-tint);
		border-color: var(--accent);
		color: var(--accent);
		font-weight: 600;
	}

	.model-custom-add-row {
		display: flex;
		gap: 6px;
		align-items: center;
		margin-top: 2px;
		padding-top: 6px;
		border-top: 1px solid var(--line);
	}

	.custom-model-input {
		flex: 1;
		padding: 4px 8px !important;
		font-size: 12px !important;
		border: 1px solid var(--line) !important;
		border-radius: var(--radius-sm) !important;
		background: var(--input-bg) !important;
		font-family: var(--mono) !important;
	}

	.btn-add-custom {
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 700;
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-add-custom:hover {
		background: var(--accent-tint);
		border-color: var(--accent);
		color: var(--accent);
	}
	/*
	 * The wizard is a page on a phone too: a 620px card inside 40px of padding left 246px of
	 * usable width, and every field in it is full width.
	 */
	@media (max-width: 680px) {
		.onboarding-screen {
			padding: 0;
			align-items: stretch;
		}

		.onboarding-card {
			width: 100%;
			min-height: 100%;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			padding: calc(20px + env(safe-area-inset-top)) 16px calc(20px + env(safe-area-inset-bottom));
		}

		/* A phone has no room for four step names in a row; the current step keeps its name. */
		.step-bar-item:not(.is-active) .step-bar-label {
			display: none;
		}
	}
</style>