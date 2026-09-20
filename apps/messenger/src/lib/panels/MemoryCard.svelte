<script lang="ts">
	import type { Bot, Memory } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { DangerAction } from '../overlays/danger-confirm.ts';
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

	/** Rows shown before the list folds. The cap is 20, so this only hides a tail. */
	const VISIBLE = 5;

	type Props = {
		runtime: MessengerRuntime;
		bot: Bot;
		t: Copy;
		openDangerConfirm: (kind: 'skill' | 'memory', run: DangerAction) => void;
		clearDanger: (kind: 'memory') => void;
	};

	let { runtime, bot, t, openDangerConfirm, clearDanger }: Props = $props();

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

<div class="panel-card">
	<div class="panel-card-head">
		<div class="flex items-center gap-2">
			<span class="panel-card-title">{t.sidebar.memories}</span>
			<span class="panel-counter-badge">{memories.length}</span>
		</div>
	</div>
	<div class="panel-card-body flex flex-col gap-3">
		{#if memories.length === 0}
			<p class="memory-empty">{t.sidebar.memoriesEmpty}</p>
		{:else}
			<p class="memory-hint">{t.sidebar.memoryHint}</p>
			{#each shown as memory (memory.id)}
				{@const origin = resolveMemoryOrigin(memory, sessionsById, botsById, t)}
				<div class="memory-row" class:is-off={!memory.enabled}>
					<div class="memory-row-head">
						<span class="memory-subject">{memory.subject}</span>
						<div class="memory-actions">
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
								onclick={() => openEdit(memory)}
								title={t.sidebar.memoryEdit}
								aria-label={t.sidebar.memoryEdit}
							>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
							</button>
							<button
								type="button"
								class="memory-icon-btn is-danger"
								onclick={() => confirmDelete(memory)}
								title={t.sidebar.memoryDelete}
								aria-label={t.sidebar.memoryDelete}
							>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>
							</button>
						</div>
					</div>
					<p class="memory-body">{memory.body}</p>
					<div class="memory-origin">
						<span>{memoryAgeLabel(memory.created_at, t)}</span>
						{#if origin.kind === 'session'}
							<span aria-hidden="true">·</span>
							<button
								type="button"
								class="memory-origin-link"
								title={t.sidebar.memoryJump}
								onclick={() => jump(origin.session.id, origin.messageId)}
							>
								{t.sidebar.memoryFormedIn(origin.label)}
							</button>
						{:else}
							<span aria-hidden="true">·</span>
							<span class="memory-origin-missing">{t.sidebar.memoryOriginMissing}</span>
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
	<div class="modal-backdrop" role="presentation" onclick={closeEdit}></div>
	<div class="modal-dialog memory-modal" role="dialog" aria-modal="true">
		<div class="modal-head">
			<span class="modal-title">{t.sidebar.memoryEdit}</span>
		</div>
		<div class="modal-body flex flex-col gap-3">
			<label class="field">
				<span class="field-label">{t.sidebar.memorySubject}</span>
				<input id="memory-subject" type="text" bind:value={draft.subject} />
				{#if errors.subject}<span class="field-error" role="alert">{errors.subject}</span>{/if}
			</label>
			<label class="field">
				<span class="field-label">{t.sidebar.memoryBody}</span>
				<textarea id="memory-body" rows="4" bind:value={draft.body}></textarea>
				{#if errors.body}<span class="field-error" role="alert">{errors.body}</span>{/if}
			</label>
		</div>
		<div class="modal-foot flex items-center justify-end gap-3">
			<button type="button" class="btn-xs" onclick={closeEdit}>{t.sidebar.memoryCancel}</button>
			<button
				type="button"
				class="btn-xs btn-primary"
				disabled={busy || !memoryDraftDirty(draft, baseline)}
				onclick={() => void save()}
			>
				{t.sidebar.memorySave}
			</button>
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

	.memory-row {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.memory-row.is-off {
		opacity: 0.55;
	}

	.memory-row-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.memory-subject {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.memory-actions {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
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
</style>
