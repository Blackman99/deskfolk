<script lang="ts">
	import type { Snippet } from 'svelte';
	import { PLAYBOOK_STEPS, playbookStep, stepsRequiring, stoppedBy, type Playbook, type PlaybookDiff, type PlaybookResolved, type PlaybookStepDiff, type PlaybookStepId } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import Switch from '../Switch.svelte';
	import { paramText, stepDiffers } from './playbook-flow.ts';
	import type { PlaybookSaveError } from './playbooks.svelte.ts';

	/**
	 * One step of an engine on Roles (ADR 0085): what it does, whether it runs in the engine shown and
	 * with what numbers — each change saved at once as that engine's new difference from its built-in,
	 * the built-in's value beside one you changed — and, for a step that makes one of the app's own
	 * calls, that call's model and prompts (`call`, the same panel Roles always had).
	 */
	interface Props {
		step: PlaybookStepId;
		playbook: Playbook;
		builtin: PlaybookResolved;
		engineName: string;
		onsave: (diff: PlaybookDiff) => void;
		onreset: (step: PlaybookStepId) => void;
		saving: boolean;
		error: PlaybookSaveError | null;
		/** The call's model and prompts, for a step that makes one. */
		call?: Snippet;
		/** What the call itself is for, beside what the step does. */
		callHint?: string | null;
		t: Copy;
	}

	let { step, playbook, builtin, engineName, onsave, onreset, saving, error, call, callHint = null, t }: Props = $props();
	const c = $derived(t.playbooks);
	const spec = $derived(playbookStep(step));
	const setting = $derived(playbook.resolved[step]);
	const differs = $derived(stepDiffers(step, playbook.resolved, builtin));
	/** What stands in the way of this step running, when something does; its switch then has no say. */
	const stopper = $derived(stoppedBy(step, playbook.resolved));
	/** A step that another still on cannot do without: running, and no switch while that one is on. */
	const heldOnBy = $derived(spec.onWhile && playbook.resolved[spec.onWhile].on ? spec.onWhile : null);
	const dependents = $derived(stepsRequiring(step).map((id) => c.steps[id]!.name));

	/** The engine's difference with this step changed as asked; the rest of it kept. */
	function withStep(change: { on?: boolean; params?: Record<string, number> }): PlaybookDiff {
		const before = playbook.diff.steps[step] ?? {};
		const next = {
			...before,
			...(change.on === undefined ? {} : { on: change.on }),
			...(change.params ? { params: { ...(before.params ?? {}), ...change.params } } : {}),
		};
		const steps: Partial<Record<PlaybookStepId, PlaybookStepDiff>> = { ...playbook.diff.steps, [step]: next };
		// Switched on, it takes back the step it cannot do without: a save would refuse that one left off.
		if (change.on) {
			for (const other of PLAYBOOK_STEPS) {
				if (other.onWhile !== step || steps[other.id]?.on !== false) continue;
				const { on: _off, ...rest } = steps[other.id]!;
				steps[other.id] = rest;
			}
		}
		return { ...playbook.diff, steps };
	}

	function setOn(on: boolean): void {
		onsave(withStep({ on }));
	}

	function setParam(key: string, raw: string, input: HTMLInputElement): void {
		const param = spec.params.find((candidate) => candidate.key === key)!;
		const value = Math.round(Number(raw));
		if (!Number.isFinite(value)) {
			input.value = String(setting.params[key]);
			return;
		}
		const clamped = Math.min(param.max, Math.max(param.min, value));
		input.value = String(clamped);
		if (clamped === setting.params[key]) return;
		onsave(withStep({ params: { [key]: clamped } }));
	}
</script>

<section class="playbook-step" aria-label={c.steps[step]!.name} data-playbook-step={step}>
	<div class="playbook-step-head">
		<h3 class="playbook-step-name">{c.steps[step]!.name}</h3>
		<p class="playbook-hint">{c.steps[step]!.hint}</p>
		{#if callHint}
			<p class="playbook-hint">{callHint}</p>
		{/if}
	</div>

	<div class="playbook-step-part" data-playbook-part="engine">
		<h4 class="playbook-part-title">{c.runs} · {engineName}</h4>
		<div class="playbook-step-switch">
			{#if stopper}
				<span class="playbook-step-state is-locked" data-playbook-stopped-by={stopper}>{c.stoppedBy(c.steps[stopper]!.name)}</span>
			{:else if heldOnBy}
				<span class="playbook-step-state is-locked" data-playbook-held-on={heldOnBy}>{c.heldOn(c.steps[heldOnBy]!.name)}</span>
			{:else if spec.switchable}
				<Switch disabled={saving}>
					<input type="checkbox" checked={setting.on} disabled={saving} aria-label={c.steps[step]!.name} data-playbook-switch onchange={(event) => setOn(event.currentTarget.checked)} />
				</Switch>
				<span class="playbook-step-state">{setting.on ? c.on : c.off}</span>
				{#if setting.on !== builtin[step].on}
					<span class="playbook-builtin">{c.builtinValue(builtin[step].on ? c.on : c.off)}</span>
				{/if}
			{:else}
				<span class="playbook-step-state is-locked">{c.locked}</span>
			{/if}
		</div>
		{#if dependents.length > 0}
			<p class="playbook-hint" data-playbook-also-stops>{c.alsoStops(dependents.join('、'))}</p>
		{/if}
		{#each spec.params as param (param.key)}
			<label class="playbook-param" class:is-off={!setting.on}>
				<span class="playbook-param-label">{c.params[param.key]}</span>
				<span class="playbook-param-field">
					<input
						type="number"
						inputmode="numeric"
						min={param.min}
						max={param.max}
						step={param.step}
						value={setting.params[param.key]}
						disabled={saving}
						data-playbook-param={param.key}
						onchange={(event) => setParam(param.key, event.currentTarget.value, event.currentTarget)}
					/>
					{#if c.unit[param.unit]}<span class="playbook-param-unit">{c.unit[param.unit]}</span>{/if}
				</span>
				{#if setting.params[param.key] !== builtin[step].params[param.key]}
					<span class="playbook-builtin">{c.builtinValue(paramText(param, builtin[step].params[param.key]!, c.unit))}</span>
				{/if}
			</label>
		{/each}
		{#if differs}
			<button type="button" class="playbook-reset" disabled={saving} data-playbook-reset onclick={() => onreset(step)}>{c.resetStep}</button>
		{/if}
		{#if error}
			<p class="field-error" role="alert">{error === 'conflict' ? c.conflict : c.failed}</p>
		{/if}
	</div>

	{#if call}
		{@render call()}
	{/if}
</section>

<style>
	.playbook-step {
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

	.playbook-step-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.playbook-step-name {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.playbook-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.playbook-step-part {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: 12px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}

	.playbook-part-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.playbook-step-switch {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.playbook-step-state {
		font-size: 12px;
	}

	.playbook-step-state.is-locked {
		color: var(--muted);
	}

	.playbook-param {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 4px 10px;
		font-size: 12px;
	}

	.playbook-param.is-off {
		opacity: 0.6;
	}

	.playbook-param-field {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.playbook-param input {
		width: 76px;
		padding: 4px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg, var(--pane));
		color: inherit;
		font: inherit;
		text-align: right;
	}

	.playbook-param-unit {
		color: var(--muted);
	}

	.playbook-builtin {
		grid-column: 1 / -1;
		color: var(--muted);
		font-size: 11px;
	}

	.playbook-step-switch .playbook-builtin {
		grid-column: auto;
	}

	.playbook-reset {
		align-self: flex-start;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.playbook-reset:hover {
		text-decoration: underline;
	}

	@media (max-width: 720px) {
		.playbook-step {
			padding: 12px;
			box-shadow: none;
		}

		/* The page's head names the step already. */
		.playbook-step-name {
			display: none;
		}
	}
</style>
