import { error } from '@sveltejs/kit';
import { getManifestoTopic } from '$lib/content.server';
import { MANIFESTO_TOPICS, isManifestoTopic } from '$lib/docs';
import type { PageServerLoad, EntryGenerator } from './$types';
import type { Lang } from '$lib/i18n';

export const prerender = true;

export const entries: EntryGenerator = () => {
  const langs: Lang[] = ['zh', 'en'];
  return langs.flatMap((lang) => MANIFESTO_TOPICS.map((topic) => ({ lang, topic })));
};

export const load: PageServerLoad = ({ params }) => {
  const lang: Lang = params.lang === 'en' ? 'en' : 'zh';
  if (!isManifestoTopic(params.topic)) {
    error(404, 'Unknown manifesto topic');
  }
  const doc = getManifestoTopic(params.topic, lang);
  return {
    lang,
    topic: params.topic,
    doc
  };
};
