import { error } from '@sveltejs/kit';
import { publishedAssets, readAsset } from '$lib/content.server';
import type { EntryGenerator, RequestHandler } from './$types';

export const prerender = true;

/** Only the images a published page shows are copied out of docs/assets/. */
export const entries: EntryGenerator = () => publishedAssets().map((file) => ({ file }));

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp'
};

export const GET: RequestHandler = ({ params }) => {
  const type = TYPES[params.file.split('.').pop()?.toLowerCase() ?? ''];
  const bytes = type ? readAsset(params.file) : null;
  if (!type || !bytes) error(404, 'Not found');
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': type } });
};
