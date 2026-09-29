import { error } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';
import type { Lang } from '$lib/i18n';

export const prerender = true;

export const load: LayoutLoad = ({ params, data }) => {
  if (params.lang !== 'zh' && params.lang !== 'en') error(404, 'Not found');
  const lang: Lang = params.lang;
  return { ...data, lang };
};
