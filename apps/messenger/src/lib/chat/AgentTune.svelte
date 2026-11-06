<script lang="ts">
	import type { ClaudeCodeModel, PatchProjectSessionRequest, ProjectAgent } from '@real-bot/protocol';
	import type { HTMLAttributes } from 'svelte/elements';
	import { claudeModelsOf, loadClaudeModels, modelChoices, modelRowOf, type Choice } from '../claude-models.svelte.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { runnerSource } from '../model-source.ts';
	import TunePicker from './TunePicker.svelte';
	import { effortOn, effortRows, effortsShown, modelRows, tunePatch, type AgentTune } from './project-agent-tune.ts';
	import type { TuneFocus, TuneLevel, TuneRow, TuneTree } from './tune-picker.ts';

	/**
	 * A project session's account, model and thinking level (ADR 0095) in the composer's cascading
	 * picker (`TunePicker.svelte`): the accounts, each account's models, each model's levels. A Codex
	 * session (ADR 0099) has no account to pick: the picker starts at the models Codex lists.
	 */
	type Props = Pick<HTMLAttributes<HTMLDivElement>, `data-${string}`> & {
		t: Copy;
		/** Whose session it is: its name and mark on the picker. */
		agent: ProjectAgent;
		tune: AgentTune;
		/** The agent's own models when it is not Claude Code (Codex's, as it lists them); left out, Claude Code's for the account. */
		models?: ClaudeCodeModel[];
		/** Your accounts, with a second one to pick; null leaves the account out. */
		accounts: Choice[] | null;
		/** A run is going: the account waits for it to end. */
		accountLocked: boolean;
		disabled: boolean;
		client: Pick<MessengerApi, 'claudeCodeModels'> | null;
		onpick: (change: PatchProjectSessionRequest) => void;
	};

	let { t, agent, tune, models: ownModels, accounts, accountLocked, disabled, client, onpick, ...attrs }: Props = $props();
	const agentName = $derived(t.project.agentNames[agent]);

	/** Each column's width, so the field can keep room for every column that may open beside the first. */
	const ACCOUNT: TuneLevel = $derived({ key: 'account', heading: t.project.accountLabel, width: 264, note: accountLocked ? t.project.accountBusy : null });
	const MODEL: TuneLevel = $derived({ key: 'model', heading: t.project.modelLabel, width: 290, details: true });
	const EFFORT: TuneLevel = $derived({ key: 'effort', heading: t.project.effortLabel, width: 140, leaf: true });

	/** The models an account lists. */
	const listOf = (account: string | undefined) => ownModels ?? claudeModelsOf(account || null);
	/** The level the session keeps on a model: its own on its own model, else its own only if that model takes it. */
	const keptOn = (list: ClaudeCodeModel[] | null, model: string) => (model === tune.model ? tune.effort : effortOn(list, model, tune.effort));

	function modelRowsAt(focus: TuneFocus): TuneRow[] {
		return modelRows(listOf(focus.account), tune.model, t.project.modelDefault, t.project.modelDefaultHint(agentName));
	}

	/** Whether a model has levels beside it: one that takes none has none, unless the session keeps one. */
	function takesLevels(focus: TuneFocus, model: string): boolean {
		const list = listOf(focus.account);
		return effortsShown(list, model, keptOn(list, model));
	}

	const tree: TuneTree = {
		start: () => ({ account: tune.account, model: tune.model, effort: tune.effort }),
		levels: (focus) => [accounts ? ACCOUNT : null, MODEL, takesLevels(focus, focus.model ?? '') ? EFFORT : null].filter((level): level is TuneLevel => level !== null),
		// Another account's models may take levels, so with accounts the levels count too.
		room: (focus) => [accounts ? ACCOUNT : null, MODEL, accounts || modelRowsAt(focus).some((row) => takesLevels(focus, row.value)) ? EFFORT : null].filter((level): level is TuneLevel => level !== null),
		rows: (level, focus) => {
			if (level === 'account') return (accounts ?? []).map((row): TuneRow => ({ ...row, disabled: accountLocked && row.value !== tune.account }));
			if (level === 'model') return modelRowsAt(focus);
			const list = listOf(focus.account);
			const model = focus.model ?? '';
			return effortRows(list, model, keptOn(list, model), t.project.effortDefault, t.sidebar.thinkingLevels);
		},
		checked: (level, focus) => (level === 'account' ? tune.account : level === 'model' ? tune.model : keptOn(listOf(focus.account), focus.model ?? '')),
		// Every account has its models; a model the levels it takes.
		opensMore: (level, value, focus) => level === 'account' || (level === 'model' && takesLevels(focus, value)),
		focusAt: (level, value, focus) => {
			if (level === 'account') {
				if (value === focus.account) return focus;
				loadClaudeModels(client, value || null);
				return { account: value, model: tune.model, effort: tune.effort };
			}
			if (level === 'model') return { ...focus, model: value, effort: keptOn(listOf(focus.account), value) };
			return value === focus.effort ? focus : { ...focus, effort: value };
		},
		commit: (level, focus) => {
			const account = focus.account ?? '';
			const picked = level === 'account' ? { account } : level === 'model' ? { account, model: focus.model ?? '' } : { account, model: focus.model ?? '', effort: focus.effort ?? '' };
			const change = tunePatch(tune, picked, listOf(account));
			if (change) onpick(change);
		}
	};

	// What the closed picker says: the model and its level; the account after them, quieter, cut first.
	const nowList = $derived(listOf(tune.account));
	const modelLabel = $derived(modelChoices(nowList, tune.model, t.project.modelDefault).find((row) => row.value === tune.model)?.label ?? tune.model);
	const modelNote = $derived(modelRowOf(nowList, tune.model)?.description || (tune.model ? undefined : t.project.modelDefaultHint(agentName)));
	const effortShown = $derived(effortsShown(nowList, tune.model, tune.effort));
	const effortLabel = $derived(tune.effort ? (t.sidebar.thinkingLevels[tune.effort as keyof typeof t.sidebar.thinkingLevels] ?? tune.effort) : t.project.effortDefault);
	const accountLabel = $derived(accounts?.find((row) => row.value === tune.account)?.label ?? null);
	const triggerTitle = $derived(
		[accountLabel, modelNote ? `${modelLabel} · ${modelNote}` : modelLabel, effortShown ? effortLabel : null].filter(Boolean).join('\n')
	);
</script>

<TunePicker
	{t}
	{tree}
	label={t.project.tuneLabel}
	mark={runnerSource(agent, agentName, t)}
	value={modelLabel}
	level={effortShown ? effortLabel : null}
	aside={accountLabel}
	title={triggerTitle}
	sheetTitle={agentName}
	{disabled}
	{...attrs}
/>
