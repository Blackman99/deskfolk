/**
 * The Deskfolk mark: a message bubble holding two stacked teammates, the mascots Mochi (white) and
 * Pudding (mustard), Pudding ringed in the bubble's colour so it cuts into Mochi. Colours come from
 * the theme tokens, so the mark steps lighter in dark mode.
 *
 * `art` is the faded mark an empty state draws: a tint bubble, a ringed pane-coloured circle, and
 * only the mustard teammate left solid.
 */
import { Image, token } from "nsh";

export function brandMarkSvg(size: number, variant: "mark" | "art", colors: { bubble: string; front: string; mustard: string; ring: string }): string {
  const art = variant === "art";
  const front = art ? ` fill="${colors.front}" stroke="${colors.ring}" stroke-width="1.5"` : ` fill="${colors.front}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">` +
    `<path fill="${colors.bubble}" d="M22 6h20a16 16 0 0 1 16 16v14a16 16 0 0 1-16 16H24.5L11 61.5c-1.2 1-2.9.1-2.7-1.4L9.6 50A16 16 0 0 1 6 40V22A16 16 0 0 1 22 6Z"/>` +
    `<circle cx="25" cy="29" r="10.5"${front}/>` +
    `<circle cx="39.5" cy="29" r="10.5" fill="${colors.mustard}" stroke="${colors.bubble}" stroke-width="3"/>` +
    `</svg>`
  );
}

export function BrandMark(props: { size?: number; variant?: "mark" | "art"; testID?: string }) {
  const size = () => props.size ?? 24;
  const src = () => {
    const art = props.variant === "art";
    return `data:image/svg+xml,${encodeURIComponent(
      brandMarkSvg(size(), art ? "art" : "mark", {
        bubble: token(art ? "art-bubble" : "brand-bubble"),
        front: token(art ? "art-front" : "brand-front"),
        mustard: token("brand-mustard"),
        ring: token("art-ring"),
      }),
    )}`;
  };
  return <Image testID={props.testID} src={src()} style={{ width: size(), height: size(), flexShrink: 0 }} accessible={false} />;
}
