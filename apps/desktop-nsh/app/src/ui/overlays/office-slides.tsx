/**
 * The PowerPoint half of `OfficeViewer.svelte`: one slide at a time (`office-model.ts` `Slide`,
 * made by `app/native/src/office/slides.rs`), every shape an absolutely positioned view in the
 * slide's own points, the whole slide scaled to fit the box it is given (`slideZoom`, the
 * messenger's own: the narrower side decides). The paper stays white in both appearances.
 */
import { Image, Text, View, type JSX } from "nsh";
import { slideZoom } from "../../m/overlays/office/slides.ts";
import { officePictureLive, type DeckModel, type SlideParagraph, type SlideShape } from "./office-model";

const ALIGN = { l: "left", ctr: "center", r: "right", just: "justify" } as const;
const ANCHOR = { t: "flex-start", ctr: "center", b: "flex-end" } as const;

function radius(shape: SlideShape, s: number): number | undefined {
  if (shape.geom === "ellipse") return 9999;
  if (shape.geom === "roundRect") return Math.min(shape.w, shape.h) * s * 0.1667;
  return undefined;
}

function Paragraph(props: { p: SlideParagraph; s: number }) {
  const { p, s } = props;
  const start = Math.max(0, p.marL + Math.min(p.indent, 0));
  const hang = Math.max(p.marL - start, p.size * 0.9) * s;
  return (
    <View style={{ flexDirection: "row", paddingLeft: (p.bullet ? start : p.marL) * s, marginTop: p.before * s }}>
      {p.bullet ? <Text style={{ width: hang, fontSize: p.size * s, color: p.color }}>{p.bullet}</Text> : null}
      <Text
        style={{
          flex: 1,
          textAlign: ALIGN[p.align as keyof typeof ALIGN] ?? "left",
          lineHeight: p.line ? p.size * s * 1.2 * p.line : undefined,
        }}
      >
        {p.runs.map((r) => (
          <Text
            style={{
              fontSize: r.size * s,
              color: r.color,
              fontWeight: r.bold ? "700" : "400",
              fontStyle: r.italic ? "italic" : "normal",
              textDecorationLine: r.underline && r.strike ? "underline line-through" : r.underline ? "underline" : r.strike ? "line-through" : "none",
            }}
          >
            {r.text}
          </Text>
        ))}
      </Text>
    </View>
  );
}

function ShapeView(props: { shape: SlideShape; id: string; s: number }): JSX.Element {
  const { shape, s } = props;
  const frame = { position: "absolute" as const, left: shape.x * s, top: shape.y * s, width: shape.w * s, height: shape.h * s };
  const turn = shape.rot ? { transform: `rotate(${shape.rot}deg)` } : {};
  if (shape.type === "picture") {
    const src = officePictureLive(props.id, shape.src ?? "");
    return (
      <If when={src()} else={<View style={frame} />}>
        <Image src={src() ?? ""} accessibilityLabel={shape.alt} style={{ ...frame, ...turn, objectFit: "fill" }} />
      </If>
    );
  }
  if (shape.geom === "line") {
    const length = Math.hypot(shape.w, shape.h) * s;
    const angle = (Math.atan2(shape.h, shape.w) * 180) / Math.PI * (shape.flipH !== shape.flipV ? -1 : 1);
    const thick = Math.max(0.5, (shape.line?.width ?? 1) * s);
    return (
      <View
        style={{
          position: "absolute",
          left: (shape.x + shape.w / 2) * s - length / 2,
          top: (shape.y + shape.h / 2) * s - thick / 2,
          width: length,
          height: thick,
          backgroundColor: shape.line?.color ?? "#000000",
          transform: `rotate(${angle}deg)`,
        }}
      />
    );
  }
  const text = shape.text;
  return (
    <View
      style={{
        ...frame,
        ...turn,
        backgroundColor: shape.fill,
        borderWidth: shape.line ? shape.line.width * s : 0,
        borderColor: shape.line?.color,
        borderRadius: radius(shape, s),
        overflow: "hidden",
        justifyContent: ANCHOR[(text?.anchor ?? "t") as keyof typeof ANCHOR] ?? "flex-start",
        paddingLeft: (text?.insets[0] ?? 0) * s,
        paddingTop: (text?.insets[1] ?? 0) * s,
        paddingRight: (text?.insets[2] ?? 0) * s,
        paddingBottom: (text?.insets[3] ?? 0) * s,
      }}
    >
      {text ? text.paragraphs.map((p) => <Paragraph p={p} s={s} />) : null}
    </View>
  );
}

/** Slide `index` of `deck`, fitted into `width` x `height`. */
export function SlideView(props: { id: string; deck: DeckModel; index: number; width: number; height: number }) {
  const slide = () => props.deck.slides[props.index];
  const zoom = () => slideZoom({ width: props.width, height: props.height }, { width: props.deck.width, height: props.deck.height });
  const s = () => (zoom() ?? 0) / 100;
  return (
    <If when={zoom() === null ? undefined : slide()}>
      {(current) => (
        <View
          testID={`office-slide-${props.index}`}
          accessibilityLabel={`${props.index + 1}`}
          style={{ width: props.deck.width * s(), height: props.deck.height * s(), backgroundColor: current().background ?? "#ffffff", overflow: "hidden" }}
        >
          {current().shapes.map((shape) => (
            <ShapeView shape={shape} id={props.id} s={s()} />
          ))}
        </View>
      )}
    </If>
  );
}
