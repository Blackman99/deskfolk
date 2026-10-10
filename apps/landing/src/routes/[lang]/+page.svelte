<script lang="ts">
  import Hero from '$lib/demo/Hero.svelte';
  import Seo from '$lib/Seo.svelte';
  import { DICT, type Lang } from '$lib/i18n';

  let { data } = $props();
  const lang: Lang = $derived(data.lang);
  const t = $derived(DICT[lang]);
</script>

<Seo {lang} title={t.seo.title} description={t.seo.description} imageAlt={t.seo.imageAlt} softwareSchema />

<Hero {t} {lang} version={data.version} />
