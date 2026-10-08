<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { ShellArtifact } from './shell-artifact.svelte.ts';
	// ArtifactPreview.svelte is lazy-loaded below (see the artifactPreview block): it only
	// mounts once a file is actually opened.

	/**
	 * The shell's artifact preview: a column beside the conversation on the workbench, with the
	 * handle that drags its width, and a sheet over the conversation everywhere else. What it shows
	 * and the actions on it are `ShellArtifact`'s; the shell binds the open preview to ask it
	 * before leaving.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		wide: boolean;
		locale: 'zh' | 'en';
		botsById: ReadonlyMap<string, { name: string }>;
		artifact: ShellArtifact;
		previewPane: { requestCloseFromParent: (afterClose?: () => void) => void; closeFind: () => boolean; blocksClose: () => boolean } | null;
	};

	let { runtime, t, wide, locale, botsById, artifact, previewPane = $bindable() }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
</script>

{#if artifact.artifactPreview}
	{#if wide}
		<button
			type="button"
			class="preview-split"
			aria-label={t.stream.artifactResize}
			onpointerdown={artifact.startPreviewResize}
		></button>
	{/if}
	{#await import('./ArtifactPreview.svelte') then { default: ArtifactPreview }}
		<ArtifactPreview
			bind:this={previewPane}
			attachment={artifact.artifactPreview.attachment}
			relpath={artifact.artifactPreview.relpath}
			siblings={artifact.artifactPreview.siblings}
			api={runtime.client}
			workspacePath={snapshot.settings.workspace_path}
			forceTree={artifact.artifactPreview.forceTree}
			taskId={artifact.artifactPreview.taskId}
			target={artifact.artifactPreview.target}
			sheet={!wide}
			annotations={snapshot.annotations}
			annotationFocusId={runtime.annotationFocusId}
			annotationFileKey={runtime.annotationFileKeys[artifact.artifactPreview.relpath] ?? null}
			bots={botsById}
			{locale}
			sessions={snapshot.sessions}
			viewedSessionId={runtime.selectedId}
			onLoadAnnotations={(path) => void runtime.loadAnnotations({ relpath: path })}
			onCreateAnnotation={(input) => runtime.createAnnotation(input)}
			onPatchAnnotation={(id, patch) => runtime.patchAnnotation(id, patch)}
			onDeleteAnnotation={(id) => runtime.deleteAnnotation(id)}
			onSendAnnotations={(sessionId, summary, ids) => runtime.sendAnnotations(sessionId, summary, ids)}
			{t}
			onOpenTerminal={artifact.openTerminalFromPreview}
			onClose={artifact.closeArtifactPreview}
			onSelect={(att) =>
				artifact.openArtifactPath(
					att.workspace_relpath,
					att,
					runtime.previewMessageId,
					runtime.forceArtifactTree,
					runtime.previewTaskId,
					runtime.previewSiblings
				)}
			onSelectWorkspacePath={(path) =>
				artifact.openArtifactPath(
					path,
					undefined,
					runtime.previewMessageId,
					runtime.forceArtifactTree,
					runtime.previewTaskId,
					runtime.previewSiblings
				)}
		/>
	{/await}
{/if}

<style>
	.preview-split {
		width: 8px;
		padding: 0;
		border: 0;
		cursor: col-resize;
		position: relative;
		background: transparent;
		z-index: 2;
	}

	.preview-split::before {
		content: "";
		position: absolute;
		inset: 0 3px;
		background: var(--line);
		border-radius: var(--radius-full);
	}

	.preview-split:hover::before,
	:global(.shell.is-preview-dragging) .preview-split::before {
		background: var(--accent);
		inset: 0 2px;
	}
</style>
