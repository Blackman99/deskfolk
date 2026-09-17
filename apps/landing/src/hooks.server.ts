import type { Handle } from '@sveltejs/kit';

/** Stamp the document language per route so prerendered HTML carries the right `lang`. */
export const handle: Handle = async ({ event, resolve }) => {
  const lang = event.params.lang === 'en' ? 'en' : 'zh-CN';
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%lang%', lang)
  });
};
