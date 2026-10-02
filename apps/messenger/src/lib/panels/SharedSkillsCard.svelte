<script lang="ts">
	import type { SharedSkill, Skill } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';

	/** The slice of the API this card uses (ADR 0052). */
	export type SharedSkillsApi = {
		listSharedSkills: () => Promise<{ items: SharedSkill[]; available: boolean }>;
		shareSkill: (skillId: string) => Promise<SharedSkill>;
		setSharedSkillEnabled: (id: string, enabled: boolean) => Promise<SharedSkill>;
		unshareSkill: (id: string) => Promise<void>;
	};

	interface Props {
		api: SharedSkillsApi | null;
		botId: string;
		/** This Bot's own skills. */
		skills: readonly Skill[];
		t: Copy;
	}

	let { api, botId, skills, t }: Props = $props();

	let shared = $state<SharedSkill[]>([]);
	let available = $state(false);
	let busy = $state<string | null>(null);
	/** A first press only asks: a skill can hold what the Bot learned about you (ADR 0021). */
	let confirming = $state<string | null>(null);
	let failed = $state(false);

	async function load(): Promise<void> {
		if (!api) return;
		try {
			const page = await api.listSharedSkills();
			shared = page.items;
			available = page.available;
		} catch {
			available = false;
		}
	}

	// Again whenever this Bot's skills change: an edit above may make a shared copy out of date.
	$effect(() => {
		void botId;
		void skills.map((skill) => `${skill.id}:${skill.updated_at}`).join();
		void load();
	});
	/** The update waiting on you, with the body it would share: what changed is yours to read first. */
	let reviewing = $state<string | null>(null);

	const sharedBySource = $derived(new Map(shared.filter((row) => row.source_skill_id).map((row) => [row.source_skill_id!, row])));
	const fromOthers = $derived(shared.filter((row) => row.source_bot_id !== botId));

	async function act(key: string, run: () => Promise<unknown>): Promise<void> {
		if (busy) return;
		busy = key;
		failed = false;
		try {
			await run();
			await load();
		} catch {
			failed = true;
		} finally {
			busy = null;
		}
	}
</script>

{#if available}
	<div class="panel-card shared-skills-card">
		<div class="panel-card-head">
			<span class="panel-card-title">{t.sharedSkills.title}</span>
		</div>
		<div class="panel-card-body flex flex-col gap-3">
			<p class="shared-skills-hint">{t.sharedSkills.hint}</p>
			{#if failed}
				<p class="field-error" role="alert">{t.sharedSkills.failed}</p>
			{/if}
			{#if skills.length > 0}
				<ul class="shared-skills-list" aria-label={t.sharedSkills.ownTitle}>
					{#each skills as skill (skill.id)}
						{@const copy = sharedBySource.get(skill.id)}
						<li class="shared-skill-row" data-skill={skill.id}>
							<span class="shared-skill-name" title={skill.name}>{skill.name}</span>
							{#if copy}
								<span class="shared-skill-state">
									{copy.enabled ? (copy.source_changed ? t.sharedSkills.changedSince : t.sharedSkills.sharedState) : t.sharedSkills.sharedOff}
								</span>
								{#if copy.source_changed && reviewing !== skill.id}
									<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => (reviewing = skill.id)}>{t.sharedSkills.update}</button>
								{/if}
								<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => act(copy.id, () => api!.setSharedSkillEnabled(copy.id, !copy.enabled))}>
									{copy.enabled ? t.sharedSkills.turnOff : t.sharedSkills.turnOn}
								</button>
								<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => act(copy.id, () => api!.unshareSkill(copy.id))}>{t.sharedSkills.unshare}</button>
								{#if reviewing === skill.id}
									<div class="shared-skill-review">
										<span class="shared-skill-state">{t.sharedSkills.updateHint}</span>
										<pre class="shared-skill-body">{skill.body}</pre>
										<div class="shared-skill-review-actions">
											<button type="button" class="shared-skill-button is-primary" disabled={busy !== null} onclick={() => { reviewing = null; void act(skill.id, () => api!.shareSkill(skill.id)); }}>{t.sharedSkills.confirmUpdate}</button>
											<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => (reviewing = null)}>{t.sharedSkills.cancel}</button>
										</div>
									</div>
								{/if}
							{:else if confirming === skill.id}
								<span class="shared-skill-state">{t.sharedSkills.confirmHint}</span>
								<button type="button" class="shared-skill-button is-primary" disabled={busy !== null} onclick={() => { confirming = null; void act(skill.id, () => api!.shareSkill(skill.id)); }}>{t.sharedSkills.confirm}</button>
								<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => (confirming = null)}>{t.sharedSkills.cancel}</button>
							{:else}
								<button type="button" class="shared-skill-button is-primary" disabled={busy !== null} onclick={() => (confirming = skill.id)}>{t.sharedSkills.share}</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if fromOthers.length > 0}
				<span class="shared-skills-subtitle">{t.sharedSkills.othersTitle}</span>
				<ul class="shared-skills-list">
					{#each fromOthers as row (row.id)}
						<li class="shared-skill-row" class:is-off={!row.enabled} data-shared={row.id}>
							<span class="shared-skill-name" title={row.description}>{row.name}</span>
							<span class="shared-skill-state">{row.source_bot_name ? t.sharedSkills.from(row.source_bot_name) : t.sharedSkills.fromGone}</span>
							<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => act(row.id, () => api!.setSharedSkillEnabled(row.id, !row.enabled))}>
								{row.enabled ? t.sharedSkills.turnOff : t.sharedSkills.turnOn}
							</button>
							<button type="button" class="shared-skill-button" disabled={busy !== null} onclick={() => act(row.id, () => api!.unshareSkill(row.id))}>{t.sharedSkills.unshare}</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
{/if}

<style>
	.shared-skills-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.shared-skills-subtitle {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.shared-skills-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.shared-skill-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px 8px;
		padding: 7px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
	}

	.shared-skill-row.is-off {
		opacity: 0.6;
	}

	.shared-skill-name {
		flex: 1 1 140px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		color: var(--ink);
	}

	.shared-skill-state {
		font-size: 11px;
		color: var(--muted);
	}

	.shared-skill-button {
		padding: 2px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 12px;
		cursor: pointer;
	}

	.shared-skill-review {
		flex-basis: 100%;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.shared-skill-body {
		margin: 0;
		max-height: 220px;
		overflow: auto;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		font-size: 12px;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--ink);
	}

	.shared-skill-review-actions {
		display: flex;
		gap: 6px;
	}

	.shared-skill-button.is-primary {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.shared-skill-button:hover:not(:disabled) {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.shared-skill-button:disabled {
		cursor: default;
		opacity: 0.6;
	}
</style>
