import { documentSource, getDocumentContent } from '$lib/content.server';
import type { PageServerLoad, EntryGenerator } from './$types';
import type { Lang } from '$lib/i18n';

export const prerender = true;

export const entries: EntryGenerator = () => {
  return [
    { lang: 'zh' },
    { lang: 'en' }
  ];
};

export const load: PageServerLoad = ({ params }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  return {
    lang,
    source: documentSource('remote', lang),
    doc: getDocumentContent('remote', lang)
  };
};
