import type { PageLoad } from './$types';
import type { Lang } from '$lib/i18n';

/**
 * Development-only studio for the Open Graph image. Not prerendered, so it is
 * absent from the static build. Open http://localhost:5174/og/zh at a
 * 1200×630 viewport and screenshot it to regenerate static/og-zh.png.
 */
export const prerender = false;

export const load: PageLoad = ({ params }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  return { lang };
};
