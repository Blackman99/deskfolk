import { getAppVersion } from '$lib/content.server';
import type { LayoutServerLoad } from './$types';

/** The released version the docs pages set their main-branch content against. */
export const load: LayoutServerLoad = () => ({ version: getAppVersion() });
