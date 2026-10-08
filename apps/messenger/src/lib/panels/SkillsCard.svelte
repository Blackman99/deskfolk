<script lang="ts">
	import type { Skill } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';

	/** The skills tab's list. The editor state lives in ProfilePane: its sheet sits outside the pane. */
	type Props = {
		t: Copy;
		profileSkills: readonly Skill[];
		skillEditor: 'add' | string | null;
		skillFailed: boolean;
		openAddSkill: () => void;
		openEditSkill: (id: string) => void;
		toggleSkillEnabled: (id: string, enabled: boolean) => Promise<void>;
		openDeleteSkillConfirm: (id: string) => void;
	};

	let {
		t,
		profileSkills,
		skillEditor,
		skillFailed,
		openAddSkill,
		openEditSkill,
		toggleSkillEnabled,
		openDeleteSkillConfirm
	}: Props = $props();
</script>

<div class="panel-card skill-card">
	<div class="panel-card-head skill-card-head">
		<div class="flex items-center gap-2">
			<span class="panel-card-title">{t.sidebar.skills}</span>
			<span class="panel-counter-badge">{profileSkills.length}</span>
		</div>
		<button
			type="button"
			class="skill-head-add-btn"
			onclick={openAddSkill}
			title={t.sidebar.skillAdd}
			aria-label={t.sidebar.skillAdd}
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="5" x2="12" y2="19"></line>
				<line x1="5" y1="12" x2="19" y2="12"></line>
			</svg>
			<span>{t.sidebar.skillAdd}</span>
		</button>
	</div>
	<div class="panel-card-body skill-card-body flex flex-col gap-3">
		{#if skillFailed && !skillEditor}
			<p class="field-error" role="alert">{t.sidebar.saveFailed}</p>
		{/if}
		{#if profileSkills.length === 0}
			<div class="skill-empty-card">
				<div class="skill-empty-icon" aria-hidden="true">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
					</svg>
				</div>
				<p class="skill-empty-text">{t.sidebar.skillsEmpty}</p>
				<button type="button" class="btn-primary skill-empty-add-btn" onclick={openAddSkill}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<line x1="12" y1="5" x2="12" y2="19"></line>
						<line x1="5" y1="12" x2="19" y2="12"></line>
					</svg>
					<span>{t.sidebar.skillAdd}</span>
				</button>
			</div>
		{/if}
		{#each profileSkills as skill (skill.id)}
			<div class="skill-row" class:is-disabled={!skill.enabled} class:is-open={skillEditor === skill.id}>
				<button
					type="button"
					class="skill-open"
					aria-label={`${t.sidebar.skillEdit}: ${skill.name}`}
					onclick={() => openEditSkill(skill.id)}
				>
					<div class="skill-row-icon" class:is-disabled={!skill.enabled}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
						</svg>
					</div>
					<div class="skill-row-content">
						<div class="skill-row-title-line">
							<span class="skill-name" title={skill.name}>{skill.name}</span>
							{#if skill.uses && skill.uses.length > 0}
								<span class="skill-uses-badge" title={skill.uses.join(', ')}>MCP</span>
							{/if}
							{#if !skill.enabled}
								<span class="skill-badge-disabled">已停用</span>
							{/if}
						</div>
						<span class="skill-desc" title={skill.description}>{skill.description}</span>
						{#if skill.learning}
							<span class="skill-learning">
								{skill.learning.later === 0
									? t.sidebar.learningNoneYet
									: t.sidebar.learningLater(skill.learning.later, skill.learning.shorter)}
							</span>
						{/if}
					</div>
				</button>
				<div class="skill-row-actions skill-row-actions-desktop">
					<label class="mcp-enable-label" title={t.sidebar.skillEnabled}>
						<input
							type="checkbox"
							aria-label={`${t.sidebar.skillEnabled}: ${skill.name}`}
							checked={skill.enabled}
							onchange={(event) => {
								event.currentTarget.checked = skill.enabled;
								void toggleSkillEnabled(skill.id, !skill.enabled);
							}}
						/>
						<span class="skill-enable-text">{t.sidebar.skillEnabled}</span>
					</label>
					<button
						type="button"
						class="skill-action-btn edit"
						aria-label={`${t.sidebar.skillEdit}: ${skill.name}`}
						title={t.sidebar.skillEdit}
						onclick={() => openEditSkill(skill.id)}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
						</svg>
					</button>
					<button
						type="button"
						class="skill-action-btn delete"
						aria-label={`${t.sidebar.skillDelete}: ${skill.name}`}
						title={t.sidebar.skillDelete}
						onclick={() => openDeleteSkillConfirm(skill.id)}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="3 6 5 6 21 6"></polyline>
							<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
						</svg>
					</button>
				</div>
				<div class="skill-mobile-toggle">
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<label
						class="switch-toggle"
						title={skill.enabled ? t.sidebar.skillEnabled : '已停用'}
						onclick={(e) => e.stopPropagation()}
					>
						<input
							type="checkbox"
							aria-label={`${t.sidebar.skillEnabled}: ${skill.name}`}
							checked={skill.enabled}
							onchange={(event) => {
								event.currentTarget.checked = skill.enabled;
								void toggleSkillEnabled(skill.id, !skill.enabled);
							}}
						/>
						<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
					</label>
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.skill-head-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		line-height: 1;
	}

	.skill-head-add-btn:hover {
		background: var(--line-subtle);
		border-color: var(--accent);
		color: var(--accent);
	}

	.skill-empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 20px 16px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
		text-align: center;
		gap: 8px;
	}

	.skill-empty-icon {
		color: var(--muted);
		opacity: 0.7;
	}

	.skill-empty-text {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}

	.skill-empty-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		margin-top: 2px;
	}

	.skill-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 6px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.skill-row:hover,
	.skill-row:focus-within {
		border-color: var(--accent-border);
		box-shadow: 0 1px 4px rgba(18, 28, 32, 0.04);
	}

	.skill-row.is-disabled {
		opacity: 0.65;
		background: var(--sidebar-bg);
	}

	.skill-row.is-open {
		border-color: var(--accent);
	}

	.skill-open {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
		padding: 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		text-align: left;
		color: var(--ink);
		cursor: pointer;
	}

	.skill-row-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		background: var(--accent-tint);
		color: var(--accent);
		flex-shrink: 0;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.skill-row-icon.is-disabled {
		background: var(--line-subtle);
		color: var(--muted);
	}

	.skill-row-content {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.skill-row-title-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.skill-name {
		font-size: 13px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
		color: var(--ink);
	}

	.skill-open:hover .skill-name {
		color: var(--accent);
	}

	.skill-uses-badge {
		font-size: 10px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		background: var(--line-subtle);
		color: var(--ink-secondary);
		border: 1px solid var(--line);
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.skill-desc {
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}

	.skill-learning {
		font-size: 11px;
		color: var(--muted);
	}

	.skill-row-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.skill-row .mcp-enable-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		color: var(--ink-secondary);
		cursor: pointer;
		user-select: none;
		margin: 0;
		padding-right: 4px;
	}

	.skill-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		padding: 0;
	}

	.skill-action-btn:hover {
		background: var(--line-subtle);
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.skill-action-btn.edit:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.skill-action-btn.delete:hover {
		background: var(--danger-bg);
		border-color: var(--danger-line);
		color: var(--danger);
	}

	.skill-badge-disabled {
		font-size: 11px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		color: var(--muted);
		line-height: 1.3;
	}

	.skill-mobile-toggle {
		display: none;
	}

	.switch-toggle { position: relative; display: inline-flex; align-items: center; margin: 0; cursor: pointer; }
	.switch-toggle input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
	.switch-track { display: block; width: 44px; height: 24px; border-radius: var(--radius-full); background: var(--chip-line, var(--line)); position: relative; transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-toggle input:checked + .switch-track { background: var(--accent); }
	.switch-toggle input:checked + .switch-track .switch-thumb { transform: translateX(20px); }
	.switch-toggle input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }

	@media (max-width: 680px) {
		.skill-card {
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
		}

		.skill-card-head {
			display: none;
		}

		.skill-card-body {
			gap: 10px;
			padding: 0;
		}

		.skill-row-actions-desktop {
			display: none;
		}

		.skill-mobile-toggle {
			display: flex;
			align-items: center;
			margin-left: auto;
			flex-shrink: 0;
		}

		.skill-row {
			padding: 12px 14px;
			border: 1px solid var(--line);
			border-radius: var(--radius-lg);
			background: var(--pane);
			box-shadow: var(--shadow-xs);
		}

		.skill-row-icon {
			width: 36px;
			height: 36px;
			border-radius: var(--radius-md);
		}

		.skill-row-icon svg {
			width: 18px;
			height: 18px;
		}

		.skill-name {
			font-size: 15px;
		}

		.skill-desc {
			font-size: 13px;
			line-height: 1.4;
			line-clamp: 2;
			-webkit-line-clamp: 2;
			display: -webkit-box;
			-webkit-box-orient: vertical;
			white-space: normal;
		}

		.skill-open {
			min-height: 52px;
			padding: 0;
		}

		.skill-open:active {
			opacity: 0.85;
		}

		.skill-empty-card {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 12px;
			padding: 36px 16px;
			border-radius: var(--radius-lg);
			background: var(--pane);
			border: 1px dashed var(--line);
			text-align: center;
		}

		.skill-empty-icon {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 56px;
			height: 56px;
			border-radius: 50%;
			background: var(--sidebar-bg);
			color: var(--muted);
		}

		.skill-empty-text {
			font-size: 14px;
			color: var(--muted);
			margin: 0;
		}

		.skill-empty-add-btn {
			min-height: 44px;
			padding: 0 20px;
			font-size: 14px;
			border-radius: var(--radius-md);
		}
	}
</style>
