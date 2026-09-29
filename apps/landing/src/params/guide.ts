import type { ParamMatcher } from '@sveltejs/kit';
import { isGuide } from '$lib/docs';

export const match: ParamMatcher = (param) => isGuide(param);
