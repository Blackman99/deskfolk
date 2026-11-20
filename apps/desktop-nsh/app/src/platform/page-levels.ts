/**
 * What has pages of its own under one address on the phone's page (`LevelSource` in
 * `page-route.ts`): settings' tab and section, the endpoint editor's pages, a conversation's
 * settings' sections, an enlarged picture, a sheet's sub-list. Each part holds its levels here
 * while it is mounted; the route hears them all, in the order they came, bottom first
 * (`reportLevels`). On the desktop nothing listens, and holding costs nothing.
 */
import { effect, signal, untracked } from "nsh";
import { reportLevels, type LevelSource } from "./page-route";

type Held = {
  key: string;
  /** Pages open now; null while the dialog they lie in is closed (its closing took their entries). */
  depth: () => number | null;
  inModal: boolean;
  stepOut?: () => void;
};

const held = signal<readonly Held[]>([]);
let made = 0;

/** Holds a part's levels while it is up; the returned function lets them go (an unmount). */
export function holdLevels(part: { name: string; depth: () => number | null; inModal: boolean; stepOut?: () => void }): () => void {
  const entry: Held = { key: `${part.name}-${++made}`, depth: part.depth, inModal: part.inModal, stepOut: part.stepOut };
  held.set([...held(), entry]);
  return () => held.set(held().filter((h) => h !== entry));
}

/** The route's side: every part's depth followed and reported together (`pageRoute().install`). */
export function followLevels(): void {
  effect(() => {
    const sources: LevelSource[] = [];
    for (const part of held()) {
      const depth = part.depth();
      if (depth !== null) sources.push({ key: part.key, depth, inModal: part.inModal, stepOut: part.stepOut });
    }
    untracked(() => reportLevels(sources));
  });
}
