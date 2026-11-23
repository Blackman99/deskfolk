/**
 * The app's controllable tooltip bubble (the pointer's hint on desktops), given as an element's
 * `tooltip` prop:
 *
 * - Simple / uncontrolled hints: `<View tooltip={tip("Pin")}>` or `<View tooltip={tip(cmd, { mono: true })}>`.
 * - Reactive / controlled hints (keep the element mounted across state changes):
 *   `<View tooltip={<Tip label={cmd} open={open()} onOpenChange={...} mono />} />`.
 *
 * Bounded in width (`maxWidth`, and always within the viewport's safe area) and lines (`maxLines`)
 * so long shell commands, descriptions, or file paths wrap cleanly instead of overflowing the screen.
 * Empty or whitespace-only labels never show a blank bubble.
 */
import { Text, View, type JSX, type ViewProps } from "nsh";
import { Tooltip, type Align, type OpenChangeReason, type Placement } from "nsh/base";
import { shadow } from "./styles";

/** Default maximum outer bubble width in points (further capped by the viewport safe area). */
export const TIP_DEFAULT_MAX_WIDTH = 360;
/** Default maximum wrapped lines before ellipsizing. */
export const TIP_DEFAULT_MAX_LINES = 6;
/** Default inset kept from the viewport safe-area edges, in points. */
export const TIP_DEFAULT_MARGIN = 8;
/** Default gap between the anchor and the tooltip bubble, in points. */
export const TIP_DEFAULT_OFFSET = 6;
/** Horizontal padding + border of the bubble (`px-[9px]` + 1px border on both sides). */
const BUBBLE_CHROME_X = 20;
/** Minimum generous character budget before pre-truncating multi-kilobyte clamped labels. */
const MIN_CLAMPED_CHARS = 1200;

export type TipTone = "surface" | "inverted";

export type TipOptions = {
  /** Controlled open state. When omitted, hover and keyboard focus manage visibility. */
  open?: boolean | null;
  /** Initial open state when uncontrolled. */
  defaultOpen?: boolean;
  /** Called when hover, keyboard focus, or Escape asks to open or close the tooltip. */
  onOpenChange?: (event: { open: boolean; reason: OpenChangeReason }) => void;
  /** Called once the tooltip opens. */
  onOpen?: () => void;
  /** Called once the tooltip closes. */
  onClose?: () => void;
  /** Suppresses showing the tooltip without tearing down its element. */
  disabled?: boolean;
  /** Preferred side of the anchor (default `"top"`). */
  placement?: Placement;
  /** Alignment along that side (default `"center"`). */
  align?: Align;
  /** Gap between anchor and bubble in points (default 6). */
  offset?: number;
  /** Inset kept from the viewport safe-area edges in points (default 8). */
  margin?: number;
  /** Hover rest delay in milliseconds (default 500; `Infinity` = controlled-only). */
  delay?: number;
  /** Maximum outer bubble width in points (default 360; `null` = viewport area only). */
  maxWidth?: number | null;
  /** Maximum lines of text before ellipsizing (default 6; `0` or `null` = unclamped). */
  maxLines?: number | null;
  /** Render the label in monospace (for shell commands, paths, code). */
  mono?: boolean;
  /** Surface styling: `"surface"` (default, elevated theme card) or `"inverted"` (ink fill). */
  tone?: TipTone;
  /** Extra classes on the tooltip bubble. */
  class?: string;
  /** Extra classes on the tooltip text. */
  textClass?: string;
  /** Test identifier on the tooltip bubble. */
  testID?: string;
  /** Layout callback on the tooltip bubble. */
  onLayout?: ViewProps["onLayout"];
};

export type TipProps = TipOptions & {
  /** Plain text shown inside the bubble (ignored when `children` is provided). */
  label?: string | null;
  /** Custom content inside the bounded bubble. */
  children?: JSX.Element;
};

/**
 * Formats a tooltip label for display: trims surrounding whitespace, and when line-clamped keeps
 * huge multi-kilobyte commands within a generous character budget so text layout stays instant.
 */
export function formatTipLabel(label: string | null | undefined, maxLines: number | null | undefined = TIP_DEFAULT_MAX_LINES): string {
  const trimmed = (label ?? "").trim();
  if (!trimmed) return "";
  if (maxLines === null || maxLines === 0) return trimmed;
  const lines = maxLines ?? TIP_DEFAULT_MAX_LINES;
  const budget = Math.max(MIN_CLAMPED_CHARS, lines * 240);
  return trimmed.length > budget ? `${trimmed.slice(0, budget - 1).trimEnd()}…` : trimmed;
}

/**
 * Controllable tooltip component. Always returns `<Tooltip>` directly so NSH adopts it as the
 * anchor's hint overlay without an extra wrapper.
 */
export function Tip(props: TipProps) {
  const maxLines = () => {
    if (props.maxLines === null || props.maxLines === 0) return 0;
    return props.maxLines ?? TIP_DEFAULT_MAX_LINES;
  };
  const label = () => formatTipLabel(props.label, props.maxLines);
  const hasContent = () => props.children !== undefined && props.children !== null && props.children !== false || label().length > 0;
  const disabled = () => Boolean(props.disabled) || !hasContent();
  const inverted = () => props.tone === "inverted";
  const contentMaxWidth = () => {
    if (props.maxWidth === null) return undefined;
    const outer = props.maxWidth ?? TIP_DEFAULT_MAX_WIDTH;
    return Math.max(40, outer - BUBBLE_CHROME_X);
  };
  const surfaceClass = () => (inverted() ? "bg-ink border-transparent" : "bg-pane border-line");
  const textToneClass = () => (inverted() ? "text-pane" : "text-ink");
  const textStyle = () => {
    const width = contentMaxWidth();
    const lines = maxLines();
    return {
      ...(width !== undefined ? { maxWidth: width } : {}),
      ...(lines > 0 ? { numberOfLines: lines, textOverflow: "ellipsis" as const } : {}),
    };
  };

  return (
    <Tooltip
      open={props.open}
      defaultOpen={props.defaultOpen}
      onOpenChange={props.onOpenChange}
      onOpen={props.onOpen}
      onClose={props.onClose}
      disabled={disabled()}
      placement={props.placement ?? "top"}
      align={props.align ?? "center"}
      offset={props.offset ?? TIP_DEFAULT_OFFSET}
      margin={props.margin ?? TIP_DEFAULT_MARGIN}
      delay={props.delay ?? 500}
      testID={props.testID}
      onLayout={props.onLayout}
      class={`max-w-full rounded-(--radius-sm) border px-[9px] py-[5px] ${surfaceClass()} ${props.class ?? ""}`}
      style={{ boxShadow: shadow("md") }}
    >
      <If
        when={props.children !== undefined && props.children !== null && props.children !== false}
        else={
          <Text
            class={`max-w-full text-[12px] leading-[1.45] text-left ${props.mono ? "font-mono" : ""} ${textToneClass()} ${props.textClass ?? ""}`}
            style={textStyle()}
          >
            {label()}
          </Text>
        }
      >
        <View class="max-w-full min-w-0" style={contentMaxWidth() !== undefined ? { maxWidth: contentMaxWidth() } : undefined}>
          {props.children}
        </View>
      </If>
    </Tooltip>
  );
}

/**
 * Convenience helper for `<View tooltip={tip("Pin")}>` and `<View tooltip={tip(cmd, { mono: true })}>`.
 * Returns `undefined` for empty labels unless controlled via `options.open`.
 */
export function tip(label: string | null | undefined, options?: TipOptions): JSX.Element {
  if (!label?.trim() && options?.open === undefined) return undefined;
  return <Tip label={label} {...options} />;
}
