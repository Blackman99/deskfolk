import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import type { Lang } from '$lib/i18n';

export const prerender = true;

export const entries = () => [{ lang: 'zh' }, { lang: 'en' }];

export const load: PageLoad = ({ params }) => {
  if (params.lang !== 'zh' && params.lang !== 'en') error(404, 'Not found');
  const lang: Lang = params.lang;
  return { lang };
};
