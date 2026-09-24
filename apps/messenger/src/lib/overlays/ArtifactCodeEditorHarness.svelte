<script lang="ts">
	/**
	 * Hands the editor its file the way a conversation's preview does: as a field of an object
	 * that is remade on every snapshot, whether or not the file changed.
	 */
	import ArtifactCodeEditor from './ArtifactCodeEditor.svelte';

	let { code }: { code: string } = $props();

	let preview = $state({ relpath: 'src/app.ts' });
</script>

<button type="button" data-remake onclick={() => (preview = { relpath: preview.relpath })}>remake</button>
<button type="button" data-other onclick={() => (preview = { relpath: 'src/other.ts' })}>other</button>
<ArtifactCodeEditor {code} path={preview.relpath} wrap={false} />
