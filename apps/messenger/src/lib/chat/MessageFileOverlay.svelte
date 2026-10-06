<script lang="ts">
	import type { Attachment } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { targetFor } from '../annotations/model.ts';
	import FileIcon from '../overlays/FileIcon.svelte';
	import { fileIconFor } from '../overlays/file-icon.ts';
	import { isPlaceholderAttachment } from '../overlays/artifacts.ts';
	import { holdFullscreenPreview } from '../overlays/fullscreen-preview.ts';
	import { onMount } from 'svelte';

	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** The chip's row; null for a file only named in the message, read from the workspace. */
		attachment: Attachment | null;
		relpath: string;
		/** The message the chip sits on: what an annotation hangs on, when a Bot's does not. */
		messageId: string | null;
		onClose: () => void;
	}

	let { runtime, t, attachment, relpath, messageId, onClose }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	/** A link in the file to another one turns this preview to it, the way the pane does. */
	let picked = $state<{ relpath: string; attachment: Attachment | null } | null>(null);
	const shownPath = $derived(picked?.relpath ?? relpath);
	const shownAttachment = $derived(picked ? picked.attachment : attachment);
	const name = $derived(shownAttachment?.original_filename ?? (shownPath.split('/').pop() || shownPath));
	const owner = $derived(messageId ? snapshot.messages.find((message) => message.id === messageId) : undefined);
	const sessionId = $derived(owner?.session_id ?? runtime.selectedId ?? null);
	/** 挂到谁, the way the conversation's preview decides: the Bot message that handed this path over. */
	const target = $derived(
		targetFor(snapshot.messages, shownPath, owner, { sessionId, taskId: owner?.task_id ?? null })
	);
	const botsById = $derived(new Map(snapshot.bots.map((bot) => [bot.id, bot] as const)));
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');

	let pane = $state<{ requestCloseFromParent: (afterClose?: () => void) => void } | null>(null);
	let release: (() => void) | null = null;

	/**
	 * Escape and the phone's Back take this off the newest-first list of full-window previews and
	 * call this. An unsaved edit asks first and may keep the file open, so it goes back on the list.
	 */
	function close(): void {
		release?.();
		release = holdFullscreenPreview(close);
		if (pane) pane.requestCloseFromParent();
		else onClose();
	}

	onMount(() => {
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		release = holdFullscreenPreview(close);
		return () => {
			release?.();
			release = null;
			document.body.style.overflow = previousOverflow;
		};
	});

	function onBackdrop(ev: MouseEvent): void {
		if (ev.target === ev.currentTarget) close();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="msg-file-overlay" role="presentation" onclick={onBackdrop}>
	<div class="msg-file-frame" role="dialog" aria-modal="true" aria-label={name}>
		<!-- The phone's pane has its own bar, back and name; the desktop's has none, so this is it. -->
		<header class="msg-file-head">
			<FileIcon icon={fileIconFor(shownPath, { isDir: shownAttachment?.is_dir === true })} size={16} />
			<span class="msg-file-name" title={shownPath}>{name}</span>
			<button type="button" class="msg-file-close" aria-label={t.common.close} onclick={close}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
			</button>
		</header>
		<div class="msg-file-body">
			{#await import('../overlays/ArtifactPreview.svelte') then { default: ArtifactPreview }}
				<ArtifactPreview
					bind:this={pane}
					attachment={shownAttachment}
					relpath={shownPath}
					siblings={shownAttachment ? [shownAttachment] : []}
					noTree
					api={runtime.client}
					workspacePath={snapshot.settings.workspace_path}
					{target}
					annotations={snapshot.annotations}
					annotationFileKey={runtime.annotationFileKeys[shownPath] ?? null}
					bots={botsById}
					{locale}
					sessions={snapshot.sessions}
					viewedSessionId={sessionId}
					onLoadAnnotations={(path) => void runtime.loadAnnotations({ relpath: path })}
					onCreateAnnotation={(input) => runtime.createAnnotation(input)}
					onPatchAnnotation={(id, patch) => runtime.patchAnnotation(id, patch)}
					onDeleteAnnotation={(id) => runtime.deleteAnnotation(id)}
					onSendAnnotations={(session, summary, ids) => runtime.sendAnnotations(session, summary, ids)}
					{t}
					{onClose}
					onSelect={(att) => (picked = { relpath: att.workspace_relpath, attachment: isPlaceholderAttachment(att) ? null : att })}
				/>
			{/await}
		</div>
	</div>
</div>

<style>
	/* Under an enlarged picture (1300), which a file in here can open, over everything else. */
	.msg-file-overlay {
		position: fixed;
		inset: 0;
		z-index: 1250;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: color-mix(in srgb, var(--bg) 92%, transparent);
	}

	.msg-file-frame {
		display: flex;
		flex-direction: column;
		width: min(1100px, 100%);
		height: min(88vh, 100%);
		min-height: 0;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.18);
	}

	.msg-file-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 48px;
		padding: 0 8px 0 16px;
		border-bottom: 1px solid var(--line);
		flex-shrink: 0;
	}

	.msg-file-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.msg-file-close {
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		border: 0;
		border-radius: var(--radius-full);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.msg-file-close:hover {
		background: var(--btn-secondary-bg);
		color: var(--ink);
	}

	.msg-file-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.msg-file-body :global(.artifact-pane) {
		flex: 1;
	}

	@media (max-width: 680px) {
		.msg-file-overlay {
			padding: 0;
		}

		.msg-file-frame {
			width: 100%;
			height: 100%;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}

		.msg-file-head {
			display: none;
		}
	}
</style>
