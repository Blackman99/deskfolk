<script lang="ts">
  import type { Lang } from '$lib/i18n';
  import { GITHUB_URL, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SITE_NAME, SITE_URL } from '$lib/site';

  /**
   * Per-page SEO head: title, description, canonical, hreflang alternates,
   * Open Graph, Twitter card and optional JSON-LD.
   */
  let {
    lang,
    title,
    description,
    /** Route suffix after the language segment, e.g. '' or '/manifesto'. */
    suffix = '',
    imageAlt,
    softwareSchema = false
  }: {
    lang: Lang;
    title: string;
    description: string;
    suffix?: string;
    imageAlt?: string;
    softwareSchema?: boolean;
  } = $props();

  const locale = $derived(lang === 'zh' ? 'zh_CN' : 'en_US');
  const altLocale = $derived(lang === 'zh' ? 'en_US' : 'zh_CN');
  const url = $derived(`${SITE_URL}/${lang}${suffix}`);
  const image = $derived(`${SITE_URL}/og-${lang}.png`);

  const jsonLd = $derived(
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      operatingSystem: 'macOS',
      applicationCategory: 'DeveloperApplication',
      description,
      url,
      image,
      inLanguage: lang === 'zh' ? 'zh-CN' : 'en',
      license: 'https://opensource.org/licenses/MIT',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      sameAs: [GITHUB_URL]
    })
  );
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description} />
  <link rel="canonical" href={url} />
  <link rel="alternate" hreflang="zh-CN" href="{SITE_URL}/zh{suffix}" />
  <link rel="alternate" hreflang="en" href="{SITE_URL}/en{suffix}" />
  <link rel="alternate" hreflang="x-default" href="{SITE_URL}/" />

  <meta property="og:type" content="website" />
  <meta property="og:site_name" content={SITE_NAME} />
  <meta property="og:locale" content={locale} />
  <meta property="og:locale:alternate" content={altLocale} />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:url" content={url} />
  <meta property="og:image" content={image} />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content={String(OG_IMAGE_WIDTH)} />
  <meta property="og:image:height" content={String(OG_IMAGE_HEIGHT)} />
  <meta property="og:image:alt" content={imageAlt ?? title} />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={description} />
  <meta name="twitter:image" content={image} />
  <meta name="twitter:image:alt" content={imageAlt ?? title} />

  {#if softwareSchema}
    {@html `<script type="application/ld+json">${jsonLd.replace(/</g, '\\u003c')}</script>`}
  {/if}
</svelte:head>
