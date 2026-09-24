<script lang="ts">
  import DocsShell from '$lib/DocsShell.svelte';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
</script>

<DocsShell
  {lang}
  pageKey="remote"
  description={t.docs.remoteIntro}
  tag={t.docs.remoteTag}
  sourceFile={data.source}
  toc={data.doc.toc}
  suffix="/remote"
>
  <article class="markdown-body">
    {@html data.doc.contentHtml}
  </article>
</DocsShell>
