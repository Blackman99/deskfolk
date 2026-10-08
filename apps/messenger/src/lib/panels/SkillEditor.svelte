<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import SettingsSubject from './SettingsSubject.svelte';
	import Switch from '../Switch.svelte';
	import { backdropClick } from '../click-outside.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { Copy } from '../copy.ts';
	import type { SkillDraft, SkillFieldErrors } from './create-form.ts';

	/**
	 * The skill sheet. ProfilePane renders it after the pane, not inside the skills tab: a page
	 * inside the sliding section would be pinned to it, and the sheet's state outlives a tab switch.
	 */
	type Props = {
		bot: Bot;
		t: Copy;
		skillEditor: 'add' | string | null;
		skillDraft: SkillDraft;
		skillErrors: SkillFieldErrors;
		skillFailed: boolean;
		skillBusy: boolean;
		closeSkillEditor: () => void;
		saveSkill: () => Promise<void>;
		openDeleteSkillConfirm: (id: string) => void;
	};

	let {
		bot,
		t,
		skillEditor,
		skillDraft = $bindable(),
		skillErrors,
		skillFailed,
		skillBusy,
		closeSkillEditor,
		saveSkill,
		openDeleteSkillConfirm
	}: Props = $props();

	/** A click outside closes the skill editor; a text-selection drag that starts inside never does. */
	const skillBackdrop = backdropClick();

	const PHONE_QUERY = '(max-width: 680px)';
	function onPhone(): boolean {
		return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
	}

	function skillNameCopy(kind: 'empty' | 'conflict' | undefined): string {
		if (kind === 'conflict') return t.sidebar.skillNameConflict;
		return t.sidebar.skillNameEmpty;
	}
</script>

{#if skillEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop skill-modal-backdrop page-on-phone"
		transition:pageSlide={{ instant: !onPhone() }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="skill-modal-title"
		tabindex="-1"
		onmousedowncapture={skillBackdrop.press}
		onclick={(e) => {
			e.stopPropagation();
			if (skillBackdrop.isOutside(e) && !skillBusy) closeSkillEditor();
		}}
		onpointerdown={(e) => e.stopPropagation()}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-dialog skill-modal"
			onclick={(e) => e.stopPropagation()}
			onpointerdown={(e) => e.stopPropagation()}
		>
			<div class="modal-head skill-modal-head">
				<button
					type="button"
					class="modal-back"
					aria-label={t.common.back}
					disabled={skillBusy}
					onclick={closeSkillEditor}
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</button>
				<div class="modal-head-titles">
					<h2 id="skill-modal-title">
						{skillEditor === 'add' ? t.sidebar.skillAdd : t.sidebar.skillEdit}
					</h2>
					<!-- On a phone this page covers the Bot's settings, so it says whose skill this is. -->
					<span class="modal-head-subject"><SettingsSubject variant="line" {bot} {t} /></span>
				</div>
				<button
					type="button"
					class="modal-close"
					title={t.common.close}
					disabled={skillBusy}
					onclick={closeSkillEditor}
				>✕</button>
			</div>
			<div class="modal-body skill-modal-body">
				{#if skillFailed}
					<div class="panel-alert is-error" role="alert">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="8" x2="12" y2="12"></line>
							<line x1="12" y1="16" x2="12.01" y2="16"></line>
						</svg>
						<span>{t.sidebar.saveFailed}</span>
					</div>
				{/if}

				<!-- Card 1: 技能名称与归属 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-name" class="field-label">
							{t.sidebar.skillName} <span class="required-star">*</span>
						</label>
						<span class="skill-owner-badge" title={`${t.routines.owner}: ${bot.name}`}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
								<circle cx="12" cy="7" r="4"></circle>
							</svg>
							<span>{bot.name}</span>
						</span>
					</div>
					<div class="form-group">
						<input
							id="skill-name"
							type="text"
							bind:value={skillDraft.name}
							placeholder="例如：web_search, git_commit"
							disabled={skillBusy}
							aria-invalid={!!skillErrors.name}
						/>
						{#if skillErrors.name}
							<p class="field-error">{skillNameCopy(skillErrors.name)}</p>
						{/if}
					</div>
				</div>

				<!-- Card 2: 触发场景或适用条件 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-description" class="field-label">
							{t.sidebar.skillDescription} <span class="required-star">*</span>
						</label>
						<span class="skill-card-hint">何时自动调用</span>
					</div>
					<div class="form-group">
						<textarea
							id="skill-description"
							bind:value={skillDraft.description}
							rows="3"
							placeholder="描述此技能适用的场景或触发条件，方便模型识别何时使用..."
							disabled={skillBusy}
							aria-invalid={!!skillErrors.description}
						></textarea>
						{#if skillErrors.description}
							<p class="field-error">{t.sidebar.skillDescriptionEmpty}</p>
						{/if}
					</div>
				</div>

				<!-- Card 3: 指令与规则正文 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-body" class="field-label">
							{t.sidebar.skillBody} <span class="required-star">*</span>
						</label>
						<span class="skill-card-hint">Markdown 指令</span>
					</div>
					<div class="form-group">
						<textarea
							id="skill-body"
							class="skill-body-textarea"
							bind:value={skillDraft.body}
							rows="7"
							placeholder="输入具体的 Markdown 指令、规则或提示词内容..."
							disabled={skillBusy}
							aria-invalid={!!skillErrors.body}
						></textarea>
						{#if skillErrors.body}
							<p class="field-error">{t.sidebar.skillBodyEmpty}</p>
						{/if}
					</div>
				</div>

				<!-- Card 4: 依赖的 MCP 工具 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-uses" class="field-label">{t.sidebar.skillUses}</label>
						<span class="skill-card-hint">可选</span>
					</div>
					<div class="form-group">
						<input
							id="skill-uses"
							type="text"
							bind:value={skillDraft.uses}
							placeholder={t.sidebar.skillUsesPlaceholder}
							disabled={skillBusy}
						/>
						<p class="muted field-hint">{t.sidebar.skillUsesHint}</p>
					</div>
				</div>

				<!-- Card 5: 启用状态开关 -->
				<div class="skill-form-card skill-status-card">
					<div class="skill-switch-row">
						<div class="skill-switch-copy">
							<span class="skill-switch-title">{t.sidebar.skillEnabled}</span>
							<span class="skill-switch-desc">
								{skillDraft.enabled ? '已启用，Bot 在匹配任务中将自动读取并执行' : '已停用，Bot 将暂时忽略此技能'}
							</span>
						</div>
						<Switch disabled={skillBusy}>
							<input type="checkbox" bind:checked={skillDraft.enabled} disabled={skillBusy} />
						</Switch>
					</div>
				</div>

				<!-- Card 6: 移动端危险区域 / 删除技能 (仅编辑时显示) -->
				{#if skillEditor !== 'add'}
					<div class="skill-danger-card">
						<button
							type="button"
							class="deny skill-page-delete"
							disabled={skillBusy}
							onclick={() => openDeleteSkillConfirm(skillEditor as string)}
						>
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="3 6 5 6 21 6"></polyline>
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
							</svg>
							<span>{t.sidebar.skillDelete}</span>
						</button>
					</div>
				{/if}
			</div>

			<div class="modal-foot skill-modal-foot">
				<div class="skill-modal-foot-desktop">
					<div class="skill-modal-foot-left">
						{#if skillEditor !== 'add'}
							<button
								type="button"
								class="deny skill-delete-btn"
								disabled={skillBusy}
								onclick={() => openDeleteSkillConfirm(skillEditor as string)}
							>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="3 6 5 6 21 6"></polyline>
									<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
								</svg>
								<span>{t.sidebar.skillDelete}</span>
							</button>
						{/if}
					</div>
					<div class="skill-modal-foot-right">
						<button type="button" class="btn-cancel" disabled={skillBusy} onclick={closeSkillEditor}>
							{t.sidebar.skillCancel}
						</button>
						<button type="button" class="btn-primary" disabled={skillBusy} onclick={() => void saveSkill()}>
							{t.sidebar.skillSave}
						</button>
					</div>
				</div>
				<div class="skill-modal-foot-mobile">
					<button type="button" class="btn-primary skill-page-save" disabled={skillBusy} onclick={() => void saveSkill()}>
						{skillBusy ? t.routines.busy : t.sidebar.skillSave}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Modal Dialog Styles */
	.skill-modal-backdrop {
		z-index: 105;
	}

	.modal-dialog.skill-modal {
		width: 520px;
		max-width: 94vw;
		max-height: 88vh;
		display: flex;
		flex-direction: column;
	}

	.skill-modal-body {
		padding: 18px 22px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
	}

	.skill-form-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.skill-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.skill-card-header .field-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		margin: 0;
	}

	.skill-owner-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		padding: 2px 8px;
		border-radius: var(--radius-full);
	}

	.skill-card-hint {
		font-size: 12px;
		color: var(--muted);
	}

	.skill-form-card .form-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.skill-status-card {
		padding: 12px 14px;
	}

	.skill-switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
	}

	.skill-switch-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.skill-switch-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
	}

	.skill-switch-desc {
		font-size: 12px;
		color: var(--muted);
	}

	.skill-danger-card {
		padding: 4px 0;
	}

	.skill-page-delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		min-height: 44px;
		border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--danger) 5%, transparent);
		color: var(--danger-text, var(--danger, var(--danger)));
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.skill-page-delete:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
	}

	.required-star {
		color: var(--danger);
		font-weight: 700;
	}

	.skill-body-textarea {
		font-family: var(--mono);
		font-size: 13px;
		line-height: 1.5;
		min-height: 140px;
		resize: vertical;
	}

	.skill-modal-foot {
		display: flex;
		align-items: center;
		padding: 12px 20px;
		border-top: 1px solid var(--line);
		background: var(--sidebar-bg);
		gap: 12px;
	}

	.skill-modal-foot-desktop {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
	}

	.skill-modal-foot-mobile {
		display: none;
	}

	.skill-modal-foot-left,
	.skill-modal-foot-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.skill-delete-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.skill-modal-foot-right .btn-primary {
		background: var(--accent);
		color: var(--on-accent);
		border-color: transparent;
		box-shadow: 0 2px 6px color-mix(in srgb, var(--accent) 20%, transparent);
	}

	.skill-modal-foot-right .btn-primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	@media (max-width: 680px) {
		/* Mobile Skill Full Page Editor */
		.modal-dialog.skill-modal {
			background: var(--bg);
		}

		.skill-modal-head {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.skill-modal-body {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding: 16px 12px calc(24px + env(safe-area-inset-bottom));
			display: flex;
			flex-direction: column;
			gap: 14px;
			-webkit-overflow-scrolling: touch;
		}

		.skill-form-card {
			padding: 14px 16px;
			border-radius: var(--radius-lg);
			box-shadow: var(--shadow-xs);
		}

		.skill-form-card input:not([type='checkbox']):not([type='radio']),
		.skill-form-card textarea {
			padding: 10px 12px;
			border: 1px solid var(--line);
			border-radius: var(--radius-md);
			background: var(--input-bg);
			width: 100%;
			min-height: 44px;
			box-sizing: border-box;
			font-size: 16px;
			color: var(--ink);
		}

		.skill-modal-foot {
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
			background: var(--pane);
			border-top: 1px solid var(--line);
			box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.04);
		}

		.skill-modal-foot-desktop {
			display: none;
		}

		.skill-modal-foot-mobile {
			display: flex;
			width: 100%;
		}

		.skill-page-save {
			width: 100%;
			min-height: 48px;
			font-size: 16px;
			font-weight: 600;
			border-radius: var(--radius-md);
		}
	}
</style>
