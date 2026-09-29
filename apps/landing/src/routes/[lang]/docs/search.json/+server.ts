import { json } from '@sveltejs/kit';
import { getSearchIndex } from '$lib/content.server';
import type { EntryGenerator, RequestHandler } from './$types';

export const prerender = true;

export const entries: EntryGenerator = () => [{ lang: 'zh' }, { lang: 'en' }];

export const GET: RequestHandler = ({ params }) => json(getSearchIndex(params.lang === 'en' ? 'en' : 'zh'));
