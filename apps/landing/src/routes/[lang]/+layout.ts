import type { LayoutLoad } from './$types';
import type { Lang } from '$lib/i18n';

export const prerender = true;

export const load: LayoutLoad = ({ params }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  return { lang };
};
