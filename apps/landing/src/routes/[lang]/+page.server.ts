import type { EntryGenerator, PageServerLoad } from './$types';
import { getAppVersion } from '$lib/content.server';

export const prerender = true;

export const entries: EntryGenerator = () => {
  return [{ lang: 'zh' }, { lang: 'en' }];
};

export const load: PageServerLoad = () => {
  return { version: getAppVersion() };
};
