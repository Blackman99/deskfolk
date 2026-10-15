import { copyFor } from "./copy.ts";

/**
 * How wide a window is still a phone's, for anything that drops down: a choice that would open as a
 * dropdown under its button opens as a sheet from the bottom instead (`BottomSheet.svelte`).
 *
 * The model picker drew the line here first, and the settings pages around most fields do too.
 * Each component makes its own `new MediaQuery(PHONE_SHEET_QUERY)`: one made when this module
 * loads would never see a test's `matchMedia`.
 */
export const PHONE_SHEET_QUERY = "(max-width: 720px)";

/**
 * "Close" in the page's own language, for a field that is handed no copy (`Select`,
 * `MultiSelect`): the shell writes the language onto `<html lang>`.
 */
export function pageCloseLabel(): string {
  return copyFor(document.documentElement.lang.startsWith("en") ? "en" : "zh").common.close;
}

/** What a field is called on the page: the `<label>` that points at it, when there is one. */
export function labelFor(id: string | undefined): string | null {
  if (!id) return null;
  const key = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
  return document.querySelector(`label[for="${key}"]`)?.textContent?.trim() || null;
}
