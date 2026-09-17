<script lang="ts">
  import DocsShell from '$lib/DocsShell.svelte';
  import { docsPath } from '$lib/docs';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
  const topic = $derived(data.topic);
</script>

<DocsShell
  {lang}
  pageKey={topic}
  description={t.docs.pages[topic].blurb}
  tag={t.docs.manifestoTag}
  sourceFile="CONTEXT.md"
  toc={data.doc.toc}
  suffix={docsPath(topic)}
>
  <article class="markdown-body">
    {@html data.doc.contentHtml}
  </article>
</DocsShell>
