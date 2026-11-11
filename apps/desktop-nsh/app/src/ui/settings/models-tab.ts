/**
 * The state of Settings › Models that the settings dialog also reads (`settings/ModelsTab.svelte`
 * exported `sectionTitle()` and `backFromSection()` for `bind:this`): which section is open, and on a
 * phone whether its page is open over the list of sections. The dialog creates one with
 * `createModelsState()`, gives it to `<ModelsTab state={…}>` and calls the two functions for its
 * page head and its Back.
 */
import { signal } from "nsh";
import { widthAtMost } from "../../platform/viewport";

export type ModelsSection = "endpoints" | "speech";

/** The sections, in the order the tabs and the phone's list show them. */
export const MODELS_SECTIONS: readonly ModelsSection[] = ["endpoints", "speech"];

/** The messenger's breakpoint for this page. */
export const modelsPhone = () => widthAtMost(720);

export function createModelsState(label: (of: ModelsSection) => string) {
  const picked = signal<ModelsSection>("endpoints");
  /** On a phone, a section's page is open over the list of them. */
  const opened = signal(false);
  return {
    section: () => picked(),
    opened: () => opened(),
    /** The phone shows the list of sections, not a page. */
    listing: () => modelsPhone() && MODELS_SECTIONS.length > 1 && !opened(),
    open(next: ModelsSection): void {
      picked.set(next);
      opened.set(true);
    },
    /** The open section's name for the page head on a phone; null on the list, and on a wide window. */
    sectionTitle(): string | null {
      return modelsPhone() && MODELS_SECTIONS.length > 1 && opened() ? label(picked()) : null;
    },
    /** Back on a phone from a section's page goes to the list of sections. */
    backFromSection(): boolean {
      if (!modelsPhone() || MODELS_SECTIONS.length < 2 || !opened()) return false;
      opened.set(false);
      return true;
    },
  };
}

export type ModelsState = ReturnType<typeof createModelsState>;
