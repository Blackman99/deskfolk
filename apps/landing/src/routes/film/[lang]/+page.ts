import type { PageLoad } from './$types';
import type { Lang } from '$lib/i18n';

export type FilmTheme = 'light' | 'dark';

/**
 * Development-only stage for the promo film: the walkthrough played on a clock at
 * 1920×1080, with an intro, the trust points and an end card. Not prerendered, so it
 * is absent from the static build. `scripts/film/render.ts` drives it frame by frame:
 *   /film/zh                  Chinese, light
 *   /film/en?theme=dark       English, dark
 * Opened in a plain browser it waits; call `window.__film.start()` to watch it play.
 */
export const prerender = false;

export const load: PageLoad = ({ params, url }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  const theme: FilmTheme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  return { lang, theme };
};
