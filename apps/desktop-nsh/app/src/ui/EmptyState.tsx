/**
 * What a pane, a card or a list shows when there is nothing in it yet (`EmptyState.svelte`): the
 * faded mark, a title, one line on what to do, and the buttons that do it. Every empty place draws
 * this one. `size` `page` fills a pane; `inline` sits inside a card, a sidebar or a dialog.
 */
import { Image, Text, token, View, type JSX } from "nsh";

/** The faded Deskfolk mark an empty state draws (`BrandMark.svelte`'s `art` variant), as an SVG data URI. */
export function brandArtUri(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<path fill="${token("art-bubble")}" d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z"/>` +
    `<circle cx="25" cy="29" r="10.5" fill="${token("art-front")}" stroke="${token("art-ring")}" stroke-width="1.5"/>` +
    `<circle cx="39.5" cy="29" r="10.5" fill="${token("brand-mustard")}" stroke="${token("art-bubble")}" stroke-width="3"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function EmptyState(props: {
  title: string;
  hint?: string;
  size?: "page" | "inline";
  /** Heading level in the Svelte outline; NSH has one header role, so it only exists for parity. */
  level?: 2 | 3;
  /** A small icon on the mark saying what is missing here (a calendar, a search). */
  badge?: JSX.Element;
  /** The actions under the hint. */
  children?: JSX.Element;
  testID?: string;
}) {
  const inline = () => props.size === "inline";
  const mark = () => (inline() ? 52 : 72);
  return (
    <View
      testID={props.testID ?? "empty-state"}
      class={`items-center max-w-[360px] self-center ${inline() ? "gap-[6px] px-3 py-5" : "gap-2 px-6 py-10"}`}
    >
      <View class="mb-[6px]">
        <Image src={brandArtUri()} style={{ width: mark(), height: mark() }} accessible={false} />
        <If when={props.badge}>
          {(badge) => (
            <View class="absolute right-[-4px] bottom-[-2px] w-[26px] h-[26px] rounded-full bg-pane border border-line items-center justify-center" accessible={false}>
              {badge()}
            </View>
          )}
        </If>
      </View>
      <Text role="header" class={`text-center font-semibold text-ink ${inline() ? "text-[14px]" : "text-[16px]"}`}>
        {props.title}
      </Text>
      <If when={props.hint}>
        {(hint) => (
          <Text class={`text-center text-ink-muted leading-[1.6] ${inline() ? "text-[12px]" : "text-[13px]"}`}>{hint()}</Text>
        )}
      </If>
      <If when={props.children}>
        <View class="flex-row flex-wrap justify-center gap-2 pt-2">{props.children}</View>
      </If>
    </View>
  );
}
