<script lang="ts">
  import DocsShell from '$lib/DocsShell.svelte';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
</script>

<DocsShell
  {lang}
  pageKey="roadmap"
  description={t.docs.roadmapIntro}
  tag={t.docs.roadmapTag}
  sourceFile={data.source}
  toc={data.doc.toc}
  suffix="/roadmap"
>
  <article class="markdown-body">
    {@html data.doc.contentHtml}
  </article>
</DocsShell>
