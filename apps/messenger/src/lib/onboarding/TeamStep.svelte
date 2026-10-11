<script lang="ts">
	import { BUILTIN_PLAYBOOK_IDS, type BuiltinPlaybookId } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { templatesFor, type BotTemplateId } from '../bot-templates.ts';
	import { botNameErrorCopy, mapCreateBotError, planCreateBot, type CreateBotDraft, type CreateBotFieldErrors } from '../panels/create-form.ts';
	import type { TeamMember } from '../admin-mutations.svelte.ts';

	/**
	 * First launch's last step (ADR 0085): a way of working — an engine — and the first Bots, from
	 * the templates ready for it. Each ticked template is a draft you can change; making them makes
	 * each Bot in turn with its direct on that engine and, with two or more, a group of them on it
	 * too, led by the template that leads. A Bot made before one failed is not made twice. The global
	 * default engine stays 通用.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** What every Bot made here runs on: set up on Claude Code or another agent, its runner. */
		base: Partial<CreateBotDraft>;
		/** How many Bots are ticked; the footer's button says it. */
		count?: number;
		/** Something is ticked and every ticked draft is filled in: the footer's button can make them. */
		ready?: boolean;
		busy?: boolean;
		/** Everything is made, and the conversation to land in is open. */
		ondone: () => void;
	}

	let { runtime, t, base, count = $bindable(0), ready = $bindable(false), busy = $bindable(false), ondone }: Props = $props();
	const c = $derived(t.templates);

	type Pick = { id: BotTemplateId; on: boolean; lead: boolean; name: string; duties: string; boundaries: string; made: TeamMember['made'] };

	/** Each ticked draft as a request, and what of it is made already. */
	let members = new Map<BotTemplateId, TeamMember>();

	let playbook = $state<BuiltinPlaybookId>('general');
	let picks = $state<Pick[]>([]);
	let editing = $state<BotTemplateId | null>(null);
	/** The draft held back and why: its fields, or a refusal that names no field. */
	let problem = $state<{ id: BotTemplateId; errors: CreateBotFieldErrors; top: boolean } | null>(null);
	let groupFailed = $state(false);

	function pickWay(id: BuiltinPlaybookId): void {
		playbook = id;
		editing = null;
		problem = null;
		groupFailed = false;
		members = new Map();
		picks = templatesFor(id).map((template) => {
			const text = c.templates[template.id]!;
			return { id: template.id, on: template.preselected, lead: template.lead, name: text.name, duties: text.duties, boundaries: text.boundaries, made: null };
		});
	}
	pickWay('general');

	/** Some Bot is made already: its engine is set, so the way no longer changes. */
	const started = $derived(picks.some((pick) => pick.made !== null));
	const failedPick = $derived(problem ? picks.find((pick) => pick.id === problem!.id) : undefined);

	function onInput(id: BotTemplateId): void {
		if (problem?.id === id) problem = null;
	}

	function planOf(pick: Pick) {
		return planCreateBot({ ...base, name: pick.name, duties: pick.duties, boundaries: pick.boundaries, avatar: '', model: base.model ?? '' });
	}

	/** What is wrong with a draft as it stands, or what the Mac said when it refused it. */
	function errorsOf(pick: Pick): CreateBotFieldErrors {
		if (problem?.id === pick.id && !problem.top) return problem.errors;
		const plan = planOf(pick);
		return plan.ok ? {} : plan.errors;
	}

	$effect(() => {
		const on = picks.filter((pick) => pick.on);
		count = on.length;
		ready = on.length > 0 && on.every((pick) => planOf(pick).ok);
	});

	/** Makes what is ticked and not yet made, then the group; true when it all landed. */
	export async function create(): Promise<boolean> {
		if (busy) return false;
		const chosen = picks.filter((pick) => pick.on);
		if (chosen.length === 0) return false;
		problem = null;
		groupFailed = false;
		const team: TeamMember[] = [];
		for (const pick of chosen) {
			const plan = planOf(pick);
			if (!plan.ok) {
				problem = { id: pick.id, errors: plan.errors, top: false };
				editing = pick.id;
				return false;
			}
			const member = members.get(pick.id) ?? { body: plan.body, made: null };
			if (!member.made) member.body = plan.body;
			members.set(pick.id, member);
			team.push(member);
		}
		busy = true;
		try {
			const lead = Math.max(0, chosen.findIndex((pick) => pick.lead));
			const result = await runtime.createTeam({ members: team, playbookId: playbook, groupName: c.groupName[playbook] ?? playbook, lead });
			for (const pick of chosen) pick.made = members.get(pick.id)?.made ?? null;
			if (result.failed !== null) {
				const pick = chosen[result.failed]!;
				const mapped = result.error ? mapCreateBotError(result.error.status, result.error.message) : { top: true as const };
				problem = 'top' in mapped ? { id: pick.id, errors: {}, top: true } : { id: pick.id, errors: mapped, top: false };
				editing = pick.id;
				return false;
			}
			groupFailed = result.groupFailed;
			ondone();
			return true;
		} finally {
			busy = false;
		}
	}
</script>

<div class="team-step" data-team-step>
	<div class="team-part">
		<h3 class="team-title">{c.pick}</h3>
		<p class="team-hint">{c.pickHint}</p>
		<div class="team-ways" role="radiogroup" aria-label={c.pick}>
			{#each BUILTIN_PLAYBOOK_IDS as id (id)}
				<button
					type="button"
					class="team-way"
					role="radio"
					aria-checked={playbook === id}
					class:is-active={playbook === id}
					data-team-way={id}
					disabled={busy || started}
					onclick={() => pickWay(id)}
				>
					<span class="team-way-label">{t.playbooks.builtin[id]}</span>
					<span class="team-way-desc">{t.playbooks.builtinHint[id]}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="team-part">
		<h3 class="team-title">{c.team}</h3>
		<p class="team-hint">{c.teamHint}</p>
		<ul class="team-list">
			{#each picks as pick (pick.id)}
				<li class="team-bot" class:is-on={pick.on} data-team-template={pick.id}>
					<div class="team-bot-row">
						<input type="checkbox" bind:checked={pick.on} disabled={busy || pick.made !== null} aria-label={pick.name} data-team-pick={pick.id} />
						<div class="team-bot-text">
							<span class="team-bot-name">
								{pick.name}
								{#if pick.lead && count > 1 && pick.on}<span class="team-lead">{c.lead}</span>{/if}
								{#if pick.made}<span class="team-made" aria-hidden="true">✓</span>{/if}
							</span>
							{#if pick.on && editing !== pick.id && !planOf(pick).ok}
								<span class="team-bot-duties is-error">{c.incomplete}</span>
							{:else}
								<span class="team-bot-duties">{pick.duties.split('\n')[0]}</span>
							{/if}
						</div>
						<button type="button" class="team-edit" disabled={busy || pick.made !== null} aria-expanded={editing === pick.id} onclick={() => (editing = editing === pick.id ? null : pick.id)}>
							{editing === pick.id ? c.done : c.edit}
						</button>
					</div>
					{#if editing === pick.id}
						{@const errors = errorsOf(pick)}
						<div class="team-fields">
							<label>
								<span>{t.sidebar.botName}</span>
								<input type="text" bind:value={pick.name} oninput={() => onInput(pick.id)} data-team-name={pick.id} />
								{#if errors.name}<span class="field-error">{botNameErrorCopy(errors.name, t.sidebar)}</span>{/if}
							</label>
							<label>
								<span>{t.sidebar.botDuties}</span>
								<textarea rows="4" bind:value={pick.duties} oninput={() => onInput(pick.id)}></textarea>
								{#if errors.duties}<span class="field-error">{t.sidebar.dutiesEmpty}</span>{/if}
							</label>
							<label>
								<span>{t.sidebar.botBoundaries}</span>
								<textarea rows="4" bind:value={pick.boundaries} oninput={() => onInput(pick.id)}></textarea>
								{#if errors.boundaries}<span class="field-error">{t.sidebar.boundariesEmpty}</span>{/if}
							</label>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if count === 0}
			<p class="team-hint">{c.none}</p>
		{/if}
		{#if problem && failedPick}
			<p class="field-error" role="alert">{c.failed(failedPick.name.trim() || c.templates[failedPick.id]!.name)}</p>
		{/if}
		{#if groupFailed}
			<p class="field-error" role="alert">{c.groupFailed}</p>
		{/if}
	</div>
</div>

<style>
	.team-step {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.team-part {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.team-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
	}

	.team-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	/* Pick one, as connecting the app picks how. */
	.team-ways {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
	}

	.team-way {
		display: flex;
		flex-direction: column;
		gap: 4px;
		text-align: left;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		cursor: pointer;
	}

	.team-way.is-active {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}

	.team-way-label {
		font-size: 14px;
		font-weight: 600;
	}

	.team-way-desc {
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.team-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.team-bot {
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.team-bot.is-on {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
	}

	.team-bot-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.team-bot-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.team-bot-name {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 13px;
		font-weight: 600;
	}

	.team-lead {
		padding: 0 6px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		line-height: 16px;
	}

	.team-made {
		color: var(--ok);
	}

	.team-bot-duties {
		overflow: hidden;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.team-bot-duties.is-error {
		color: var(--danger);
	}

	.team-edit {
		flex: none;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.team-edit:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.team-fields {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--line-subtle);
	}

	.team-fields label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	/* As onboarding's own fields, which sit in no modal body or sheet either. */
	.team-fields input,
	.team-fields textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		background: var(--input-bg);
		color: var(--ink);
		font-size: 14px;
		font-family: inherit;
		box-shadow: var(--shadow-xs);
		outline: none;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.team-fields textarea {
		min-height: 60px;
		resize: vertical;
		line-height: 1.45;
	}

	.team-fields input:focus,
	.team-fields textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	@media (max-width: 520px) {
		.team-ways {
			grid-template-columns: 1fr;
		}
	}
</style>
