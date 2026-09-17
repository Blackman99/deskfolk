import type { PageLoad } from './$types';
import type { Lang } from '$lib/i18n';

export type BrandVariant = 'og' | 'social' | 'hero';
export type BrandTheme = 'light' | 'dark';

/**
 * Development-only studio for brand images. Not prerendered, so it is absent
 * from the static build. Open it in a browser at the variant's exact size and
 * screenshot it:
 *   /og/zh                                 1200×630  Open Graph image (static/og-zh.png)
 *   /og/en?variant=social                  1280×640  GitHub social preview (docs/assets/social-preview.png)
 *   /og/en?variant=hero&theme=light|dark   1600×900  README hero montage (docs/assets/readme-hero-*.png)
 */
export const prerender = false;

export const load: PageLoad = ({ params, url }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  const v = url.searchParams.get('variant');
  const variant: BrandVariant = v === 'social' || v === 'hero' ? v : 'og';
  const theme: BrandTheme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  return { lang, variant, theme };
};
