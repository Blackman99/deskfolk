<script lang="ts">
	import type { Bot, Memory } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { DangerAction } from '../overlays/danger-confirm.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import {
		draftFromMemory,
		mapMemoryError,
		memoryAgeLabel,
		memoryDraftDirty,
		planMemory,
		reconcileMemoryDraft,
		resolveMemoryOrigin,
		type MemoryDraft,
		type MemoryFieldErrors
	} from './memory-form.ts';

	/** Rows shown before the list folds on desktop. The cap is 20, so this only hides a tail. */
	const VISIBLE = 5;
	const PHONE_QUERY = '(max-width: 680px)';

	type Props = {
		runtime: MessengerRuntime;
		bot: Bot;
		t: Copy;
		openDangerConfirm: (kind: 'skill' | 'memory', run: DangerAction) => void;
		clearDanger: (kind: 'memory') => void;
	};

	let { runtime, bot, t, openDangerConfirm, clearDanger }: Props = $props();

	function onPhone(): boolean {
		return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
	}

	const snapshot = $derived(runtime.snapshot);
	const memories = $derived(snapshot.memories.filter((m) => m.bot_id === bot.id));
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const sessionsById = $derived(new Map(snapshot.sessions.map((s) => [s.id, s] as const)));

	let expanded = $state(false);
	const shown = $derived(expanded ? memories : memories.slice(0, VISIBLE));

	let editing = $state<string | null>(null);
	let draft = $state<MemoryDraft>({ subject: '', body: '' });
	let baseline = $state<MemoryDraft>({ subject: '', body: '' });
	let errors = $state<MemoryFieldErrors>({});
	let busy = $state(false);

	/** The shell's Back closes this page before it leaves the memory section. */
	export function backFromEditor(): boolean {
		if (!editing || busy) return Boolean(editing);
		closeEdit();
		return true;
	}

	// The Bot can rewrite a memory while this pane is open; a live update must not eat your edit.
	$effect(() => {
		if (!editing) return;
		const live = snapshot.memories.find((m) => m.id === editing);
		if (!live) {
			editing = null;
			return;
		}
		const next = reconcileMemoryDraft(draft, baseline, live);
		// Only write when the value actually moved, or the effect re-triggers on its own write.
		if (memoryDraftDirty(draft, next.draft)) draft = next.draft;
		if (memoryDraftDirty(baseline, next.baseline)) baseline = next.baseline;
	});

	function openEdit(memory: Memory): void {
		editing = memory.id;
		draft = draftFromMemory(memory);
		baseline = draftFromMemory(memory);
		errors = {};
	}

	function closeEdit(): void {
		editing = null;
		errors = {};
	}

	async function save(): Promise<void> {
		if (!editing || busy) return;
		const plan = planMemory(draft, t);
		if (!plan.ok) {
			errors = plan.errors;
			return;
		}
		busy = true;
		const failure = await runtime.patchMemory(editing, plan.body);
		busy = false;
		if (failure) {
			errors = mapMemoryError(failure.status, t);
			return;
		}
		closeEdit();
	}

	function confirmDelete(memory: Memory): void {
		openDangerConfirm('memory', async (isCurrent) => {
			await runtime.deleteMemory(memory.id);
			if (isCurrent()) clearDanger('memory');
		});
	}

	function jump(sessionId: string, messageId: string | null): void {
		void runtime.selectSession(sessionId, messageId ? { messageId } : undefined);
	}
</script>

<svelte:window
	onkeydowncapture={(e) => {
		if (editing && e.key === 'Escape' && !busy) {
			e.preventDefault();
			e.stopImmediatePropagation();
			closeEdit();
		}
	}}
/>

<div class="panel-card memory-card">
	<div class="panel-card-head memory-card-head">
		<div class="flex items-center gap-2">
			<span class="panel-card-title">{t.sidebar.memories}</span>
			<span class="panel-counter-badge">{memories.length}</span>
		</div>
	</div>
	<div class="panel-card-body memory-card-body flex flex-col gap-3">
		{#if memories.length === 0}
			<div class="memory-empty-card">
				<div class="memory-empty-icon" aria-hidden="true">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
						<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
					</svg>
				</div>
				<p class="memory-empty">{t.sidebar.memoriesEmpty}</p>
			</div>
		{:else}
			<p class="memory-hint memory-hint-desktop">{t.sidebar.memoryHint}</p>
			{#each shown as memory (memory.id)}
				{@const origin = resolveMemoryOrigin(memory, sessionsById, botsById, t)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="memory-row"
					class:is-off={!memory.enabled}
					class:is-editing={editing === memory.id}
					onclick={() => { if (onPhone()) openEdit(memory); }}
				>
					<div class="memory-row-head">
						<button
							type="button"
							class="memory-subject-btn"
							onclick={() => openEdit(memory)}
							title={t.sidebar.memoryEdit}
						>
							<span class="memory-subject">{memory.subject}</span>
							{#if !memory.enabled}
								<span class="memory-badge-disabled">已停用</span>
							{/if}
						</button>
						<div class="memory-actions memory-actions-desktop">
							<label class="memory-toggle" title={t.sidebar.memoryEnabled}>
								<input
									type="checkbox"
									checked={memory.enabled}
									onchange={(ev) =>
										void runtime.patchMemory(memory.id, {
											enabled: (ev.currentTarget as HTMLInputElement).checked
										})}
								/>
							</label>
							<button
								type="button"
								class="memory-icon-btn"
								onclick={(e) => {
									e.stopPropagation();
									openEdit(memory);
								}}
								title={t.sidebar.memoryEdit}
								aria-label={t.sidebar.memoryEdit}
							>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
							</button>
							<button
								type="button"
								class="memory-icon-btn is-danger"
								onclick={(e) => {
									e.stopPropagation();
									confirmDelete(memory);
								}}
								title={t.sidebar.memoryDelete}
								aria-label={t.sidebar.memoryDelete}
							>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
							</button>
						</div>
						<div class="memory-mobile-toggle">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<label
								class="switch-toggle"
								title={memory.enabled ? t.sidebar.memoryEnabled : '已停用'}
								onclick={(e) => e.stopPropagation()}
							>
								<input
									type="checkbox"
									aria-label={`${t.sidebar.memoryEnabled}: ${memory.subject}`}
									checked={memory.enabled}
									onchange={(ev) =>
										void runtime.patchMemory(memory.id, {
											enabled: (ev.currentTarget as HTMLInputElement).checked
										})}
								/>
								<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
							</label>
						</div>
					</div>
					<p class="memory-body">{memory.body}</p>
					<div class="memory-origin">
						<span class="memory-age-badge">{memoryAgeLabel(memory.created_at, t)}</span>
						{#if origin.kind === 'session'}
							<span aria-hidden="true" class="origin-dot">·</span>
							<button
								type="button"
								class="memory-origin-link"
								title={t.sidebar.memoryJump}
								onclick={(e) => {
									e.stopPropagation();
									jump(origin.session.id, origin.messageId);
								}}
							>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="origin-icon" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
								<span>{t.sidebar.memoryFormedIn(origin.label)}</span>
							</button>
						{:else}
							<span aria-hidden="true" class="origin-dot">·</span>
							<span class="memory-origin-missing">{t.sidebar.memoryOriginMissing}</span>
						{/if}
						{#if memory.learning}
							<span aria-hidden="true" class="origin-dot">·</span>
							<span class="memory-learning">
								{memory.learning.later === 0
									? t.sidebar.learningNoneYet
									: t.sidebar.learningLater(memory.learning.later, memory.learning.shorter)}
							</span>
						{/if}
					</div>
				</div>
			{/each}
			{#if memories.length > VISIBLE}
				<button type="button" class="memory-more" onclick={() => (expanded = !expanded)}>
					{expanded ? t.sidebar.memoryCollapse : t.sidebar.memoryShowAll(memories.length)}
				</button>
			{/if}
		{/if}
	</div>
</div>

{#if editing}
	{@const editingMemory = snapshot.memories.find((m) => m.id === editing)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop memory-modal-backdrop page-on-phone"
		transition:pageSlide={{ instant: !onPhone() }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="memory-modal-title"
		tabindex="-1"
		onclick={(e) => {
			e.stopPropagation();
			if (e.target === e.currentTarget && !busy) closeEdit();
		}}
		onpointerdown={(e) => e.stopPropagation()}
		onkeydown={(e) => {
			if (e.key === 'Escape' && !busy) {
				e.stopImmediatePropagation();
				closeEdit();
			}
		}}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-dialog memory-modal"
			onclick={(e) => e.stopPropagation()}
			onpointerdown={(e) => e.stopPropagation()}
		>
			<div class="modal-head memory-modal-head">
				<button
					type="button"
					class="modal-back"
					aria-label={t.common.back}
					disabled={busy}
					onclick={closeEdit}
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</button>
				<h2 id="memory-modal-title">{t.sidebar.memoryEdit}</h2>
				<button
					type="button"
					class="modal-close"
					title={t.common.close}
					disabled={busy}
					onclick={closeEdit}
				>✕</button>
			</div>
			<div class="modal-body memory-modal-body">
				<!-- Card 1: 记忆主题 -->
				<div class="memory-form-card">
					<div class="memory-card-header">
						<label for="memory-subject" class="memory-field-label">{t.sidebar.memorySubject} <span class="required-star">*</span></label>
						<span class="memory-owner-badge" title={`${t.routines.owner}: ${bot.name}`}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
								<circle cx="12" cy="7" r="4"></circle>
							</svg>
							<span>{bot.name}</span>
						</span>
					</div>
					<div class="form-group">
						<input
							id="memory-subject"
							type="text"
							bind:value={draft.subject}
							disabled={busy}
							aria-invalid={!!errors.subject}
							placeholder="例如：用户的回复偏好、核心业务口径"
						/>
						{#if errors.subject}<p class="field-error" role="alert">{errors.subject}</p>{/if}
					</div>
				</div>

				<!-- Card 2: 记住了什么 -->
				<div class="memory-form-card">
					<div class="memory-card-header">
						<label for="memory-body" class="memory-field-label">{t.sidebar.memoryBody} <span class="required-star">*</span></label>
						<span class="memory-card-hint">长期有效的事实或偏好</span>
					</div>
					<div class="form-group">
						<textarea
							id="memory-body"
							rows="4"
							bind:value={draft.body}
							disabled={busy}
							aria-invalid={!!errors.body}
							placeholder="输入具体的记忆结论..."
						></textarea>
						{#if errors.body}<p class="field-error" role="alert">{errors.body}</p>{/if}
					</div>
				</div>

				<!-- Card 3: 来源与演进信息 -->
				{#if editingMemory}
					{@const origin = resolveMemoryOrigin(editingMemory, sessionsById, botsById, t)}
					<div class="memory-form-card memory-origin-card">
						<div class="memory-card-header">
							<span class="memory-field-label">形成来源与更新</span>
							<span class="memory-age-text">{memoryAgeLabel(editingMemory.created_at, t)}</span>
						</div>
						<div class="memory-origin-details">
							{#if origin.kind === 'session'}
								<button
									type="button"
									class="memory-origin-action-btn"
									title={t.sidebar.memoryJump}
									onclick={() => {
										closeEdit();
										jump(origin.session.id, origin.messageId);
									}}
								>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
									<span>{t.sidebar.memoryFormedIn(origin.label)}</span>
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="arrow-icon"><polyline points="9 18 15 12 9 6"></polyline></svg>
								</button>
							{:else}
								<div class="memory-origin-missing-pill">
									<span>{t.sidebar.memoryOriginMissing}</span>
								</div>
							{/if}
							{#if editingMemory.learning}
								<div class="memory-learning-pill">
									<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
									<span>
										{editingMemory.learning.later === 0
											? t.sidebar.learningNoneYet
											: t.sidebar.learningLater(editingMemory.learning.later, editingMemory.learning.shorter)}
									</span>
								</div>
							{/if}
						</div>
					</div>

					<!-- Card 4: 记忆状态开关 -->
					<div class="memory-form-card memory-status-card">
						<div class="memory-switch-row">
							<div class="memory-switch-copy">
								<span class="memory-switch-title">{t.sidebar.memoryEnabled}</span>
								<span class="memory-switch-desc">
									{editingMemory.enabled ? '已启用，Bot 每轮对话都将参考此事实' : '已停用，Bot 将暂时不读取此记忆'}
								</span>
							</div>
							<label class="switch-toggle" class:is-disabled={busy}>
								<input
									type="checkbox"
									checked={editingMemory.enabled}
									disabled={busy}
									onchange={(ev) => {
										if (editingMemory) {
											void runtime.patchMemory(editingMemory.id, {
												enabled: (ev.currentTarget as HTMLInputElement).checked
											});
										}
									}}
								/>
								<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
							</label>
						</div>
					</div>

					<!-- Card 5: 危险区域 / 删除记忆 -->
					<div class="memory-danger-card">
						<button
							type="button"
							class="deny memory-page-delete"
							disabled={busy}
							onclick={() => {
								const m = editingMemory;
								closeEdit();
								confirmDelete(m);
							}}
						>
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="3 6 5 6 21 6"></polyline>
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
							</svg>
							<span>{t.sidebar.memoryDelete}</span>
						</button>
					</div>
				{/if}
			</div>
			<div class="modal-foot memory-modal-foot">
				<div class="memory-modal-foot-desktop">
					<button
						type="button"
						disabled={busy || !memoryDraftDirty(draft, baseline)}
						onclick={() => void save()}
					>
						{t.sidebar.memorySave}
					</button>
					<button type="button" disabled={busy} onclick={closeEdit}>{t.sidebar.memoryCancel}</button>
				</div>
				<div class="memory-modal-foot-mobile">
					<button
						type="button"
						class="btn-primary memory-page-save"
						disabled={busy || !memoryDraftDirty(draft, baseline)}
						onclick={() => void save()}
					>
						{busy ? t.routines.busy : t.sidebar.memorySave}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.memory-empty,
	.memory-hint {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.memory-empty-card {
		display: none;
	}

	.memory-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		transition: all 0.15s ease;
	}

	.memory-row.is-off {
		opacity: 0.65;
	}

	.memory-row-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.memory-subject-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
	}

	.memory-subject {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.memory-badge-disabled {
		font-size: 10.5px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		color: var(--muted);
		line-height: 1.3;
		flex-shrink: 0;
	}

	.memory-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}

	.memory-mobile-toggle {
		display: none;
	}

	.memory-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.memory-icon-btn:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.memory-icon-btn.is-danger:hover {
		color: var(--danger);
	}

	.memory-body {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink-secondary);
	}

	.memory-origin {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
	}

	.memory-origin-link {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		border: 0;
		background: transparent;
		padding: 0;
		font: inherit;
		color: var(--muted);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.memory-origin-link:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.memory-origin-missing {
		opacity: 0.8;
	}

	.memory-more {
		align-self: flex-start;
		border: 0;
		background: transparent;
		padding: 2px 0;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--muted);
		cursor: pointer;
	}

	.memory-more:hover {
		color: var(--accent);
	}

	.memory-modal-backdrop {
		z-index: 105;
	}

	.modal-dialog.memory-modal {
		width: 480px;
		max-width: 94vw;
		max-height: 88vh;
	}

	.memory-modal-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px 20px;
		overflow-y: auto;
	}

	.memory-form-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.memory-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.memory-field-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
		margin: 0;
	}

	.required-star {
		color: var(--danger);
		font-weight: 700;
	}

	.memory-owner-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		font-weight: 500;
		color: var(--muted);
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		padding: 2px 8px;
		border-radius: 999px;
	}

	.memory-card-hint {
		font-size: 11.5px;
		color: var(--muted);
	}

	.memory-form-card .form-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.memory-form-card input,
	.memory-form-card textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--input-bg);
		padding: 8px 12px;
		font-size: 13.5px;
		color: var(--ink);
		font-family: inherit;
	}

	.memory-form-card input:focus,
	.memory-form-card textarea:focus {
		border-color: var(--accent);
		outline: none;
	}

	.memory-origin-details {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.memory-origin-action-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 10px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--sidebar-bg);
		color: var(--ink-secondary);
		font-size: 12.5px;
		text-align: left;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.memory-origin-action-btn:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.memory-origin-action-btn .arrow-icon {
		margin-left: auto;
		opacity: 0.6;
	}

	.memory-origin-missing-pill,
	.memory-learning-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		color: var(--muted);
	}

	.memory-status-card {
		padding: 12px 14px;
	}

	.memory-switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
	}

	.memory-switch-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.memory-switch-title {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink);
	}

	.memory-switch-desc {
		font-size: 11.5px;
		color: var(--muted);
	}

	.memory-danger-card {
		padding: 4px 0;
	}

	.memory-page-delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		min-height: 44px;
		border: 1px solid rgba(239, 68, 68, 0.25);
		border-radius: var(--radius-md);
		background: rgba(239, 68, 68, 0.05);
		color: var(--danger-text, var(--danger, #ef4444));
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.memory-page-delete:hover:not(:disabled) {
		background: rgba(239, 68, 68, 0.1);
		border-color: rgba(239, 68, 68, 0.4);
	}

	.memory-modal-foot {
		display: flex;
		align-items: center;
		padding: 12px 20px;
		border-top: 1px solid var(--line);
		background: var(--sidebar-bg);
		gap: 10px;
	}

	.memory-modal-foot-desktop {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		width: 100%;
	}

	.memory-modal-foot-mobile {
		display: none;
	}

	.switch-toggle { position: relative; display: inline-flex; align-items: center; margin: 0; cursor: pointer; }
	.switch-toggle input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
	.switch-track { display: block; width: 44px; height: 24px; border-radius: 9999px; background: var(--chip-line, var(--line)); position: relative; transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-toggle input:checked + .switch-track { background: var(--accent); }
	.switch-toggle input:checked + .switch-track .switch-thumb { transform: translateX(20px); }
	.switch-toggle input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
	.switch-toggle.is-disabled { opacity: 0.55; cursor: default; }

	@media (max-width: 680px) {
		.memory-card {
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
		}

		.memory-card-head {
			display: none;
		}

		.memory-hint-desktop {
			display: none;
		}

		.memory-card-body {
			gap: 10px;
			padding: 0;
		}

		.memory-actions-desktop {
			display: none;
		}

		.memory-mobile-toggle {
			display: flex;
			align-items: center;
			margin-left: auto;
			flex-shrink: 0;
		}

		.memory-row {
			padding: 12px 14px;
			border: 1px solid var(--line);
			border-radius: var(--radius-lg, 12px);
			background: var(--pane);
			box-shadow: var(--shadow-xs);
			cursor: pointer;
		}

		.memory-row:active {
			background: var(--row-hover);
		}

		.memory-subject-btn {
			cursor: pointer;
		}

		.memory-subject {
			font-size: 15px;
			font-weight: 600;
		}

		.memory-body {
			font-size: 13.5px;
			line-height: 1.5;
		}

		.memory-origin {
			font-size: 12px;
		}

		.memory-empty-card {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 12px;
			padding: 36px 16px;
			border-radius: var(--radius-lg, 12px);
			background: var(--pane);
			border: 1px dashed var(--line);
			text-align: center;
		}

		.memory-empty-icon {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 56px;
			height: 56px;
			border-radius: 50%;
			background: var(--sidebar-bg);
			color: var(--muted);
		}

		.memory-empty {
			font-size: 14px;
			color: var(--muted);
			margin: 0;
		}

		/* Mobile Memory Full Page Editor */
		.modal-dialog.memory-modal {
			background: var(--bg);
		}

		.memory-modal-head {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.memory-modal-body {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding: 16px 12px calc(24px + env(safe-area-inset-bottom));
			display: flex;
			flex-direction: column;
			gap: 14px;
			-webkit-overflow-scrolling: touch;
		}

		.memory-form-card {
			padding: 14px 16px;
			border-radius: var(--radius-lg, 12px);
			box-shadow: var(--shadow-xs);
		}

		.memory-form-card input,
		.memory-form-card textarea {
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

		.memory-form-card textarea {
			min-height: 100px;
		}

		.memory-modal-foot {
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
			background: var(--pane);
			border-top: 1px solid var(--line);
			box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.04);
		}

		.memory-modal-foot-desktop {
			display: none;
		}

		.memory-modal-foot-mobile {
			display: flex;
			width: 100%;
		}

		.memory-page-save {
			width: 100%;
			min-height: 48px;
			font-size: 16px;
			font-weight: 600;
			border-radius: var(--radius-md);
		}
	}
</style>
