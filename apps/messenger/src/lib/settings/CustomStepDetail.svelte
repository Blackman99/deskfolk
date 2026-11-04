<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		CUSTOM_STEP_ATS,
		CUSTOM_STEP_CALL_ATS,
		CUSTOM_STEP_COMMAND_MAX,
		CUSTOM_STEP_NAME_MAX,
		CUSTOM_STEP_PROMPT_MAX,
		CUSTOM_STEP_RUN_KINDS,
		CUSTOM_STEP_THENS_AT,
		CUSTOM_STEP_TOOLS,
		customStepTimeout,
		type CustomStep,
		type CustomStepAt,
		type CustomStepRunKind,
		type CustomStepThen,
		type CustomStepTool,
		type CustomStepTry,
		type Playbook,
		type PlaybookDiff
	} from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import DangerDialog from '../overlays/DangerDialog.svelte';
	import Select from '../Select.svelte';
	import Switch from '../Switch.svelte';
	import {
		cleanStep,
		diffWithStep,
		diffWithout,
		plainStep,
		sampleOf,
		stepProblem,
		withMoment,
		withPaths,
		withRunKind,
		withTool
	} from './custom-step-form.ts';
	import type { PlaybookSaveError } from './playbooks.svelte.ts';

	/**
	 * One step of your own in an engine on Roles (ADR 0105): when it runs, which calls or files it
	 * looks at, how it judges and what a "no" does. A new step is a draft — held here, not saved —
	 * until Save sends the engine's whole difference with it added; a saved one is edited in place and
	 * Save sends the difference again. The daemon checks it all and its refusal is shown as it said
	 * it. Try judges the step as it stands on a sample, and applies nothing.
	 */
	interface Props {
		/** The step as saved, or the draft. */
		step: CustomStep;
		/** Not saved yet: Save adds it, and there is no Delete but a way out. */
		draft?: boolean;
		/** Whether the engine runs it; false where its moment never comes. Only a saved step has it. */
		running?: boolean;
		playbook: Playbook;
		engineName: string;
		api: MessengerApi | null;
		/** Sends the engine's new difference; resolves to the saved engine, or null when it was not saved. */
		onsave: (diff: PlaybookDiff) => Promise<unknown>;
		/** A draft given up. */
		oncancel?: () => void;
		/** Saved, or removed: the panel's step is no longer a draft, or is gone. */
		ondone?: (what: 'saved' | 'deleted') => void;
		saving: boolean;
		error: PlaybookSaveError | null;
		/** What the daemon said when it refused the difference. */
		message?: string | null;
		/** The model and frame prompt of the call a model step makes. */
		call?: Snippet;
		t: Copy;
	}

	let {
		step,
		draft = false,
		running = true,
		playbook,
		engineName,
		api,
		onsave,
		oncancel,
		ondone,
		saving,
		error,
		message = null,
		call,
		t
	}: Props = $props();
	const c = $derived(t.playbooks.own);
	const own = $derived(playbook.custom_steps ?? []);

	/** What is being edited; another step, or another engine, starts it over. */
	let form = $state<CustomStep>(untrack(() => plainStep(step)));
	let commandText = $state(untrack(() => (step.run.kind === 'command' ? step.run.command : '')));
	let promptText = $state(untrack(() => (step.run.kind === 'model' ? step.run.prompt : '')));
	let pathsText = $state(untrack(() => (step.match?.paths ?? []).join('\n')));
	let tried = $state(false);
	let problem = $state<string | null>(null);
	let confirming = $state(false);
	let sample = $state({ tool: '' as CustomStepTool | '', command: '', paths: '', reply: '' });
	let trying = $state(false);
	let tryResult = $state<CustomStepTry | null>(null);
	let tryFailed = $state(false);

	let seeded = untrack(() => `${playbook.id}/${step.id}`);
	$effect(() => {
		const key = `${playbook.id}/${step.id}`;
		if (key === seeded) return;
		seeded = key;
		untrack(() => {
			form = plainStep(step);
			commandText = step.run.kind === 'command' ? step.run.command : '';
			promptText = step.run.kind === 'model' ? step.run.prompt : '';
			pathsText = (step.match?.paths ?? []).join('\n');
			tried = false;
			problem = null;
			confirming = false;
			sample = { tool: '', command: '', paths: '', reply: '' };
			tryResult = null;
			tryFailed = false;
		});
	});

	const atCall = $derived(CUSTOM_STEP_CALL_ATS.includes(form.at));
	const range = $derived(customStepTimeout(form.at));
	const kind = $derived<CustomStepRunKind>(form.run.kind);
	const shown = $derived(problem ?? (tried && message ? c.rejected(message) : tried && error === 'conflict' ? t.playbooks.conflict : tried && error === 'failed' ? t.playbooks.failed : null));

	const atOptions = $derived(CUSTOM_STEP_ATS.map((at) => ({ value: at, label: c.moments[at] })));
	const thenOptions = $derived(CUSTOM_STEP_THENS_AT[form.at].map((then) => ({ value: then, label: c.thens[then] })));
	const toolOptions = $derived([{ value: '', label: c.tryAny }, ...CUSTOM_STEP_TOOLS.map((tool) => ({ value: tool, label: c.toolNames[tool] }))]);

	function setMoment(at: string): void {
		form = withMoment(form, at as CustomStepAt);
		tryResult = null;
	}

	function setThen(then: string): void {
		form = { ...form, then: then as CustomStepThen };
	}

	function setKind(next: CustomStepRunKind): void {
		form = withRunKind(form, next, { command: commandText, prompt: promptText });
	}

	function setCommand(text: string): void {
		commandText = text;
		if (form.run.kind === 'command') form = { ...form, run: { ...form.run, command: text } };
	}

	function setPrompt(text: string): void {
		promptText = text;
		if (form.run.kind === 'model') form = { ...form, run: { kind: 'model', prompt: text } };
	}

	function setFolder(text: string): void {
		if (form.run.kind !== 'command') return;
		const { cwd: _cwd, ...run } = form.run;
		form = { ...form, run: text ? { ...run, cwd: text } : run };
	}

	function setTimeout_(raw: string): void {
		if (form.run.kind !== 'command') return;
		const { timeout_s: _t, ...run } = form.run;
		const value = Math.round(Number(raw));
		form = { ...form, run: raw.trim() === '' || !Number.isFinite(value) ? run : { ...run, timeout_s: value } };
	}

	function setPaths(text: string): void {
		pathsText = text;
		form = withPaths(form, text);
	}

	/** A saved step's switch is saved at once, as a built-in's is; a draft's waits for Save. */
	async function setOn(on: boolean): Promise<void> {
		form = { ...form, on };
		if (draft) return;
		tried = true;
		await onsave(diffWithStep(playbook.diff, own, { ...plainStep(step), on }));
	}

	function check(): boolean {
		const found = stepProblem(form);
		problem = found ? c.problems[found]! : null;
		return found === null;
	}

	async function save(): Promise<void> {
		tried = true;
		if (!check()) return;
		const saved = await onsave(diffWithStep(playbook.diff, own, form));
		if (saved) {
			form = cleanStep(form);
			ondone?.('saved');
		}
	}

	async function remove(): Promise<void> {
		confirming = false;
		tried = true;
		const saved = await onsave(diffWithout(playbook.diff, own, step.id));
		if (saved) ondone?.('deleted');
	}

	async function runTry(): Promise<void> {
		tryFailed = false;
		tryResult = null;
		if (!check()) return;
		if (!api) {
			tryFailed = true;
			return;
		}
		trying = true;
		try {
			tryResult = await api.tryCustomStep(playbook.id, cleanStep(form), sampleOf(sample));
		} catch {
			tryFailed = true;
		} finally {
			trying = false;
		}
	}
</script>

<section class="own-step" aria-label={form.name || c.blankName} data-custom-step={step.id} data-custom-draft={draft || undefined}>
	<div class="own-head">
		<h3 class="own-title">{form.name || c.blankName}</h3>
		<p class="own-hint">{c.mineTitle} · {engineName}{draft ? ` · ${c.draft}` : ''}</p>
	</div>

	<div class="own-part" data-custom-part="what">
		<label class="own-field">
			<span class="own-label">{c.name}</span>
			<input
				type="text"
				class="own-input"
				maxlength={CUSTOM_STEP_NAME_MAX * 2}
				value={form.name}
				aria-label={c.name}
				data-custom-name
				oninput={(event) => (form = { ...form, name: event.currentTarget.value })}
			/>
			<span class="own-note">{c.nameHint(CUSTOM_STEP_NAME_MAX)}</span>
		</label>
		<div class="own-switch">
			<Switch disabled={saving}>
				<input type="checkbox" checked={form.on} disabled={saving} aria-label={c.on} data-custom-switch onchange={(event) => void setOn(event.currentTarget.checked)} />
			</Switch>
			<span class="own-state">{form.on ? c.on : t.playbooks.off}</span>
		</div>
		{#if !draft && form.on && !running}
			<p class="own-note" data-custom-not-running>{c.notRunning}</p>
		{/if}
	</div>

	<div class="own-part" data-custom-part="moment">
		<div class="own-field">
			<span class="own-label" id="own-moment-{step.id}">{c.moment}</span>
			<Select value={form.at} options={atOptions} ariaLabel={c.moment} onchange={setMoment} />
			<span class="own-note">{c.momentHints[form.at]}</span>
		</div>
		{#if form.at === 'before_effect'}
			<p class="own-note" data-custom-before-note>{c.beforeNote}</p>
		{/if}
	</div>

	<div class="own-part" data-custom-part="match">
		<h4 class="own-part-title">{c.looksAt}</h4>
		{#if atCall}
			<div class="own-field">
				<span class="own-label">{c.tools}</span>
				<div class="own-tools">
					{#each CUSTOM_STEP_TOOLS as tool (tool)}
						<label class="own-tool">
							<input type="checkbox" checked={form.match?.tools?.includes(tool) ?? false} data-custom-tool={tool} onchange={(event) => (form = withTool(form, tool, event.currentTarget.checked))} />
							<span>{c.toolNames[tool]}</span>
						</label>
					{/each}
				</div>
				<span class="own-note">{c.toolsHint}</span>
			</div>
		{/if}
		<label class="own-field">
			<span class="own-label">{c.paths}</span>
			<textarea class="own-text" rows="3" spellcheck="false" aria-label={c.paths} data-custom-paths value={pathsText} oninput={(event) => setPaths(event.currentTarget.value)}></textarea>
			<span class="own-note">{c.pathsHint} {c.pathsAt[form.at]}</span>
		</label>
	</div>

	<div class="own-part" data-custom-part="judges">
		<h4 class="own-part-title">{c.judges}</h4>
		<div class="own-kinds" role="radiogroup" aria-label={c.judges}>
			{#each CUSTOM_STEP_RUN_KINDS as one (one)}
				<button type="button" class="own-kind" role="radio" aria-checked={kind === one} data-custom-kind={one} onclick={() => setKind(one)}>{c.kinds[one]}</button>
			{/each}
		</div>
		<p class="own-note">{c.kindHints[kind]}</p>
		{#if form.run.kind === 'command'}
			<label class="own-field">
				<span class="own-label">{c.command}</span>
				<textarea
					class="own-text mono"
					rows="3"
					spellcheck="false"
					maxlength={CUSTOM_STEP_COMMAND_MAX * 2}
					aria-label={c.command}
					data-custom-command
					value={commandText}
					oninput={(event) => setCommand(event.currentTarget.value)}
				></textarea>
				<span class="own-note">{c.commandHint}</span>
			</label>
			<label class="own-field">
				<span class="own-label">{c.folder}</span>
				<input type="text" class="own-input" aria-label={c.folder} data-custom-folder value={form.run.cwd ?? ''} oninput={(event) => setFolder(event.currentTarget.value)} />
				<span class="own-note">{c.folderHint}</span>
			</label>
			<label class="own-field is-inline">
				<span class="own-label">{c.timeout}</span>
				<span class="own-inline">
					<input
						type="number"
						class="own-input is-number"
						min={range.min}
						max={range.max}
						step="1"
						aria-label={c.timeout}
						data-custom-timeout
						value={form.run.timeout_s ?? range.default}
						onchange={(event) => setTimeout_(event.currentTarget.value)}
					/>
					<span class="own-note">{c.seconds} · {c.timeoutRange(range.min, range.max)}</span>
				</span>
			</label>
		{:else if form.run.kind === 'model'}
			<label class="own-field">
				<span class="own-label">{c.prompt}</span>
				<textarea
					class="own-text"
					rows="6"
					spellcheck="false"
					maxlength={CUSTOM_STEP_PROMPT_MAX * 2}
					aria-label={c.prompt}
					data-custom-prompt
					value={promptText}
					oninput={(event) => setPrompt(event.currentTarget.value)}
				></textarea>
				<span class="own-note">{c.promptHint}</span>
			</label>
			<p class="own-note">{c.modelHint}</p>
			{#if call}
				{@render call()}
			{/if}
		{/if}
	</div>

	<div class="own-part" data-custom-part="then">
		<div class="own-field">
			<span class="own-label">{c.thenTitle}</span>
			<Select value={form.then} options={thenOptions} ariaLabel={c.thenTitle} onchange={setThen} />
			<span class="own-note" data-custom-then-hint>{c.thenHints[form.then]}</span>
		</div>
	</div>

	<div class="own-part" data-custom-part="try">
		<h4 class="own-part-title">{c.tryTitle}</h4>
		<p class="own-note">{c.tryHint}</p>
		{#if atCall}
			<div class="own-field">
				<span class="own-label">{c.tryTool}</span>
				<Select value={sample.tool} options={toolOptions} ariaLabel={c.tryTool} onchange={(value) => (sample.tool = value as CustomStepTool | '')} />
			</div>
			{#if sample.tool === 'shell' || sample.tool === 'mcp'}
				<label class="own-field">
					<span class="own-label">{c.tryCommand}</span>
					<input type="text" class="own-input mono" aria-label={c.tryCommand} data-custom-sample-command bind:value={sample.command} />
				</label>
			{/if}
		{/if}
		{#if form.at === 'turn_end'}
			<label class="own-field">
				<span class="own-label">{c.tryReply}</span>
				<textarea class="own-text" rows="3" aria-label={c.tryReply} data-custom-sample-reply bind:value={sample.reply}></textarea>
			</label>
		{:else}
			<label class="own-field">
				<span class="own-label">{c.tryPaths}</span>
				<textarea class="own-text" rows="2" spellcheck="false" aria-label={c.tryPaths} data-custom-sample-paths bind:value={sample.paths}></textarea>
			</label>
		{/if}
		<div class="own-actions">
			<Button size="sm" disabled={trying} data-custom-try onclick={() => void runTry()}>{trying ? c.trying : c.tryRun}</Button>
		</div>
		{#if tryFailed}
			<p class="field-error" role="alert">{c.tryFailed}</p>
		{/if}
		{#if tryResult}
			<div class="own-result" data-custom-result={tryResult.outcome}>
				<p class="own-outcome">{c.tryOutcome[tryResult.outcome]}{tryResult.exit_code !== null ? ` · ${c.tryExit(tryResult.exit_code)}` : ''}</p>
				{#if tryResult.reason}<p class="own-note" data-custom-result-reason>{tryResult.reason}</p>{/if}
				{#if tryResult.output}
					<span class="own-label">{c.tryOutput}</span>
					<pre class="own-output mono" data-custom-result-output>{tryResult.output}</pre>
				{/if}
				{#if tryResult.sample && Object.keys(tryResult.sample).length > 0}
					<span class="own-label">{c.tryUsed}</span>
					<pre class="own-output mono" data-custom-result-sample>{JSON.stringify(tryResult.sample, null, 2)}</pre>
				{/if}
			</div>
		{/if}
	</div>

	<div class="own-part own-foot" data-custom-part="save">
		{#if shown}
			<p class="field-error" role="alert" data-custom-error>{shown}</p>
		{/if}
		<div class="own-actions">
			<Button size="sm" variant="primary" disabled={saving} data-custom-save onclick={() => void save()}>{c.save}</Button>
			{#if draft}
				<Button size="sm" variant="ghost" disabled={saving} data-custom-cancel onclick={() => oncancel?.()}>{c.cancel}</Button>
			{:else}
				<Button size="sm" variant="danger-soft" disabled={saving} data-custom-delete onclick={() => (confirming = true)}>{c.delete}</Button>
			{/if}
		</div>
	</div>
</section>

{#if confirming}
	<DangerDialog
		copy={{ title: c.deleteTitle(step.name), body: c.deleteBody, confirm: c.confirmDelete, cancel: t.playbooks.cancel }}
		{t}
		onDismiss={() => (confirming = false)}
		onConfirm={() => void remove()}
	/>
{/if}

<style>
	.own-step {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		min-width: 0;
	}

	.own-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.own-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.own-hint,
	.own-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.own-note {
		font-size: 11px;
	}

	.own-part {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}

	.own-part-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.own-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		font-size: 12px;
	}

	.own-field.is-inline {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.own-inline {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.own-label {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.own-input,
	.own-text {
		width: 100%;
		box-sizing: border-box;
		padding: 5px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg, var(--pane));
		color: inherit;
		font: inherit;
		font-size: 12px;
	}

	.own-input.is-number {
		width: 76px;
		text-align: right;
	}

	.own-text {
		min-height: 52px;
		resize: vertical;
		line-height: 1.5;
	}

	.own-switch {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.own-state {
		font-size: 12px;
	}

	.own-tools {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
	}

	.own-tool {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}

	.own-kinds {
		display: inline-flex;
		align-self: flex-start;
		padding: 2px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
	}

	.own-kind {
		padding: 3px 12px;
		border: 0;
		border-radius: calc(var(--radius-sm) - 2px);
		background: transparent;
		color: var(--ink-secondary);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}

	.own-kind[aria-checked='true'] {
		background: var(--pane);
		color: var(--ink);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.own-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.own-result {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.own-outcome {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
	}

	.own-output {
		margin: 0;
		max-height: 200px;
		overflow: auto;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		font-size: 11px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	@media (max-width: 720px) {
		.own-step {
			padding: 12px;
			box-shadow: none;
		}

		/* The page's head names the step already. */
		.own-title {
			display: none;
		}
	}
</style>
