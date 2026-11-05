import type { Lang } from '$lib/i18n';
import type { SceneCopy } from './copy';

/**
 * What every chapter's scene is given: its words, how far the reader has scrolled through the
 * chapter (`p`, 0 to 1; 1 throughout with reduced motion) and whether the reader is on it. A scene
 * reads the rest from the stage (`useStage()`: `wide`, `reduced`, `act` for Mochi and Pudding).
 */
export type SceneProps<K extends keyof SceneCopy> = {
  copy: SceneCopy[K];
  p: number;
  active: boolean;
  lang: Lang;
};
