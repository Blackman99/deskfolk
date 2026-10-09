<script lang="ts">
	import {
		SPEECH_FORMATS,
		SPEECH_LANGUAGES,
		SPEECH_PRESETS,
		isLocalEndpoint,
		speechPreset,
		speechReady,
		type PatchSpeechRequest,
		type SpeechPresetId,
		type SpeechSettings
	} from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import { Autosave } from '../autosave.svelte.ts';
	import type { Copy } from '../copy.ts';
	import AutosaveState from './AutosaveState.svelte';
	import SettingsSwitch from './SettingsSwitch.svelte';

	/**
	 * The speech endpoint the composer's microphone sends to (ADR 0073). Picking a service fills in
	 * its format, address and model; every field saves as it changes, the key when you leave it.
	 */
	interface Props {
		/** As the daemon has it; null until a service is picked. */
		speech: SpeechSettings | null;
		patch: (patch: PatchSpeechRequest) => Promise<unknown | null>;
		t: Copy;
	}

	let { speech, patch, t }: Props = $props();

	const s = $derived(t.speech);
	const autosave = new Autosave();
	let failed = $state(false);
	let baseUrl = $state('');
	let model = $state('');
	let apiKey = $state('');
	/** Fields typed into and not saved yet: the snapshot does not overwrite them. */
	let editing = $state<{ base_url: boolean; model: boolean }>({ base_url: false, model: false });

	$effect(() => {
		const current = speech;
		if (!editing.base_url) baseUrl = current?.base_url ?? '';
		if (!editing.model) model = current?.model ?? '';
	});

	const preset = $derived(speech ? speechPreset(speech.preset) : null);
	const local = $derived(isLocalEndpoint(baseUrl.trim()));
	const presetOptions = $derived(SPEECH_PRESETS.map((row) => ({ value: row.id, label: s.presets[row.id] })));
	const formatOptions = $derived(SPEECH_FORMATS.map((format) => ({ value: format, label: s.formats[format] })));
	const languageOptions = $derived([
		{ value: '', label: s.languageAuto },
		...SPEECH_LANGUAGES.map((code) => ({ value: code, label: s.languages[code] ?? code }))
	]);
	const status = $derived.by(() => {
		if (!speech) return null;
		if (!speech.enabled) return s.off;
		if (speechReady(speech)) return s.ready;
		if (!speech.base_url) return s.missingUrl;
		if (!speech.model) return s.missingModel;
		return s.missingKey;
	});

	async function save(body: PatchSpeechRequest): Promise<boolean> {
		autosave.saving = true;
		failed = false;
		try {
			const error = await patch(body);
			failed = error !== null;
			if (!failed) autosave.savedTick++;
			return !failed;
		} finally {
			autosave.saving = false;
		}
	}

	/** A service fills in its own format, address and model; custom keeps what is there to edit. */
	function choosePreset(id: string): void {
		const next = speechPreset(id as SpeechPresetId);
		autosave.cancel();
		editing = { base_url: false, model: false };
		void save(next.id === 'custom' ? { preset: next.id } : { preset: next.id, format: next.format, base_url: next.base_url, model: next.model });
	}

	function typed(field: 'base_url' | 'model'): void {
		editing = { ...editing, [field]: true };
		autosave.schedule(() => void flush());
	}

	async function flush(): Promise<void> {
		const body: PatchSpeechRequest = {};
		if (editing.base_url) body.base_url = baseUrl.trim();
		if (editing.model) body.model = model.trim();
		if (!Object.keys(body).length) return;
		const done = await save(body);
		if (done) editing = { base_url: false, model: false };
	}

	async function saveKey(): Promise<void> {
		const value = apiKey.trim();
		if (!value) return;
		if (await save({ api_key: value })) apiKey = '';
	}
</script>

<section class="speech-card" aria-label={s.title} data-speech-settings>
	<div class="speech-head">
		<div class="speech-head-text">
			<h3>{s.title}</h3>
			<p>{s.hint}</p>
		</div>
		{#if speech}
			<SettingsSwitch tag="label" class="speech-switch">
				<input
					type="checkbox"
					aria-label={s.enabled}
					checked={speech.enabled}
					disabled={autosave.saving}
					onchange={(event) => void save({ enabled: event.currentTarget.checked })}
				/>
			</SettingsSwitch>
		{/if}
	</div>

	<div class="speech-grid">
		<div class="speech-field">
			<span class="speech-label">{s.service}</span>
			<Select
				value={speech?.preset ?? ''}
				options={presetOptions}
				placeholder={s.service}
				size="sm"
				ariaLabel={s.service}
				disabled={autosave.saving}
				onchange={choosePreset}
			/>
		</div>
		{#if speech}
			{#if speech.preset === 'custom'}
				<div class="speech-field">
					<span class="speech-label">{s.format}</span>
					<Select
						value={speech.format}
						options={formatOptions}
						size="sm"
						ariaLabel={s.format}
						disabled={autosave.saving}
						onchange={(value) => void save({ format: value as SpeechSettings['format'] })}
					/>
				</div>
			{/if}
			<label class="speech-field speech-wide">
				<span class="speech-label">{s.baseUrl}</span>
				<input
					type="text"
					class="mono"
					spellcheck="false"
					autocomplete="off"
					placeholder="https://…/v1"
					bind:value={baseUrl}
					oninput={() => typed('base_url')}
					onblur={() => {
						if (autosave.cancel()) void flush();
					}}
				/>
				<span class="speech-note">{s.baseUrlHint}</span>
			</label>
			<label class="speech-field">
				<span class="speech-label">{s.model}</span>
				<input
					type="text"
					class="mono"
					spellcheck="false"
					autocomplete="off"
					list="speech-model-suggestions"
					bind:value={model}
					oninput={() => typed('model')}
					onblur={() => {
						if (autosave.cancel()) void flush();
					}}
				/>
				<datalist id="speech-model-suggestions">
					{#each preset?.models ?? [] as name (name)}<option value={name}></option>{/each}
				</datalist>
			</label>
			<div class="speech-field">
				<span class="speech-label">{s.language}</span>
				<Select
					value={speech.language ?? ''}
					options={languageOptions}
					size="sm"
					ariaLabel={s.language}
					disabled={autosave.saving}
					onchange={(value) => void save({ language: value || null })}
				/>
			</div>
			<label class="speech-field speech-wide">
				<span class="speech-label">{s.apiKey}</span>
				<span class="speech-key-row">
					<input
						type="password"
						autocomplete="off"
						placeholder={speech.key_set ? s.keySaved : local ? s.keyNotNeeded : ''}
						bind:value={apiKey}
						onblur={() => void saveKey()}
						onkeydown={(event) => {
							if (event.key === 'Enter') void saveKey();
						}}
					/>
					{#if speech.key_set}
						<button type="button" class="speech-key-clear" disabled={autosave.saving} onclick={() => void save({ api_key: '' })}>{s.keyClear}</button>
					{/if}
				</span>
			</label>
		{/if}
	</div>

	{#if speech}
		<div class="speech-foot">
			<span class="speech-status" class:is-ready={speechReady(speech)} data-speech-status>{status}</span>
			<AutosaveState {t} saving={autosave.saving} {failed} saved={autosave.savedTick > 0} />
		</div>
	{:else if failed}
		<p class="speech-error" role="alert">{s.failed}</p>
	{/if}
</section>

<style>
	.speech-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.speech-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.speech-head h3 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.speech-head p {
		margin: 4px 0 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.speech-head :global(.speech-switch) {
		flex-shrink: 0;
		margin-top: 2px;
	}

	.speech-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px 12px;
	}

	.speech-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.speech-wide {
		grid-column: 1 / -1;
	}

	.speech-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.speech-note {
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.speech-field input {
		width: 100%;
		min-width: 0;
		padding: 6px 10px;
		font-size: 13px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		box-sizing: border-box;
	}

	.speech-field input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	.speech-key-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.speech-key-clear {
		flex-shrink: 0;
		padding: 5px 10px;
		font-size: 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink-secondary);
		background: var(--sidebar-bg);
	}

	.speech-key-clear:hover:not(:disabled) {
		color: var(--danger);
		border-color: var(--danger-line);
		background: var(--danger-bg);
	}

	.speech-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	.speech-status {
		font-size: 12px;
		color: var(--warn-text);
	}

	.speech-status.is-ready {
		color: var(--ok-text);
	}

	.speech-error {
		margin: 0;
		font-size: 12px;
		color: var(--danger-text);
	}

	@media (max-width: 720px) {
		.speech-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.speech-field input {
			min-height: 44px;
			font-size: 16px;
		}
	}
</style>
