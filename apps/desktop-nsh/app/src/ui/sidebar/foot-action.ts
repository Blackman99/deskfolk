/**
 * The classes of a button in the list's footer row (`.foot-action`), shared by the workspace,
 * tools and settings buttons. `tight` is a list under ~300px (less padding and gap), `iconsOnly` the
 * row with its words gone.
 */
export function footActionClass(opts: { active?: boolean; tight?: boolean; iconsOnly?: boolean }): string {
  const pad = opts.iconsOnly ? "px-2" : opts.tight ? "px-1 gap-1" : "px-[7px] gap-[6px]";
  const look = opts.active
    ? "border-accent-border bg-accent-tint"
    : "border-transparent hover:border-line hover:bg-btn-secondary-hover focus-visible:border-brand";
  return `relative flex-row items-center justify-center shrink-0 h-[36px] border rounded-(--radius-sm) disabled:opacity-[0.35] ${pad} ${look}`;
}

/** The label's and icon's colours for the same states. */
export function footActionInk(active: boolean | undefined): { text: string; tint: string } {
  return active
    ? { text: "text-brand", tint: "tint-brand" }
    : { text: "text-ink-muted group-hover:text-ink", tint: "tint-ink-muted group-hover:tint-ink" };
}

/** The list's footer width (its content box) under which the row tightens, and under which it keeps icons only. */
export const FOOT_TIGHT = 283;
export const FOOT_ICONS_ONLY = 223;
