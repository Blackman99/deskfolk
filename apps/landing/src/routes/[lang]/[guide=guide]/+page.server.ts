import { documentSource, getDocumentContent } from '$lib/content.server';
import { GUIDES, type Guide } from '$lib/docs';
import type { PageServerLoad, EntryGenerator } from './$types';
import type { Lang } from '$lib/i18n';

export const prerender = true;

export const entries: EntryGenerator = () => {
  const langs: Lang[] = ['zh', 'en'];
  return langs.flatMap((lang) => GUIDES.map((guide) => ({ lang, guide })));
};

export const load: PageServerLoad = ({ params }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  const guide = params.guide as Guide;
  return {
    lang,
    guide,
    source: documentSource(guide, lang),
    doc: getDocumentContent(guide, lang)
  };
};
