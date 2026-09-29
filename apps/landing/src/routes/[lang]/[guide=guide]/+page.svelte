<script lang="ts">
  import DocsShell from '$lib/DocsShell.svelte';
  import type { Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
</script>

<DocsShell {lang} pageKey={data.guide} sourceFile={data.source} toc={data.doc.toc}>
  <article class="markdown-body">
    {@html data.doc.contentHtml}
  </article>
</DocsShell>
