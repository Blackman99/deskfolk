import type { PageLoad } from './$types';
import type { Lang } from '$lib/i18n';

/**
 * Development-only stage for the promo on the real app: `?app=<demo messenger URL>` goes into the
 * stage's iframes. scripts/film/live.ts opens it and drives everything through `window.__film`.
 */
export const prerender = false;

export const load: PageLoad = ({ params, url }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  return { lang, theme, app: url.searchParams.get('app') };
};
