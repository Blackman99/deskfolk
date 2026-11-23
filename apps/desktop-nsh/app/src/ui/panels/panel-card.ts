/** The classes of the drawer's cards (`.panel-card`, `.panel-card-head`, `.panel-card-title`, `.panel-counter-badge` in `styles/drawers.css`). */
export const PANEL_CARD = "bg-pane border border-line rounded-(--radius-lg) min-w-0";
/**
 * A card run edge to edge (`flush`: the Bot's settings on a wider window, with no gutter round
 * them): no side borders and no corners, only a line under it. One below another adds `border-t`.
 */
export const PANEL_SECTION = "bg-pane border-b border-line min-w-0";
export const PANEL_CARD_HEAD = "flex-row items-center justify-between px-4 py-3 border-b border-line-subtle bg-pane rounded-t-(--radius-lg)";
export const PANEL_CARD_TITLE = "text-[12px] font-semibold text-ink-muted";
export const PANEL_CARD_BODY = "p-4";
export const PANEL_COUNTER = "px-[7px] py-[2px] rounded-full bg-chip border border-chip-line";
/** A field's error line (`.field-error`). */
export const FIELD_ERROR = "text-[12px] font-medium text-danger-text";
/** A boxed text field (aligned with `provider-fields.tsx`'s `fieldClass`). */
export const FIELD = "w-full px-3 py-2 rounded-(--radius-md) border border-line bg-input-bg text-ink text-[14px] focus:border-field-focus-border disabled:opacity-[0.45]";
