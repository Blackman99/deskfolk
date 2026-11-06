/**
 * The Word half of `OfficeViewer.svelte`: the document's blocks (`office-model.ts` `WordModel`,
 * made by `app/native/src/office/word.rs`) on a white page like docx-preview's, drawn by
 * `TextView`'s `document` prop. What `TextView` has no block for comes in as `custom` nodes drawn
 * here: tables (`table`: grid widths, column spans, vertical merges shown as an empty cell, cell
 * shading), centred and right-aligned paragraphs (`aligned`) and coloured runs (`color`).
 * Hyperlinks are shown but never opened (`TextView`'s `links` stays `"report"`).
 */
import { Image, Scroll, Text, View } from "nsh";
import { TextView, type TextViewBlock, type TextViewCustomNode, type TextViewImage } from "nsh/base";
import { narrowWindow } from "../Modal";
import { officePicture } from "./office-model";

const INK = "#171717";
const PAPER = "#ffffff";
const RULE = "#bfbfbf";

type TableData = {
  widths: number[];
  rows: { cells: { span: number; merge: string | null; fill: string | null; blocks: TextViewBlock[] }[] }[];
};

function Blocks(props: { id: string; blocks: TextViewBlock[]; align?: "center" | "right" }) {
  const renderImage = (image: TextViewImage) => {
    const src = officePicture(props.id, image.src);
    return src ? (
      <Image src={src} accessibilityLabel={image.alt} style={{ width: image.width as number | undefined, height: image.height as number | undefined, maxWidth: "100%" }} />
    ) : (
      <Text class="text-[13px]" style={{ color: INK }}>{image.alt ?? ""}</Text>
    );
  };
  const renderCustom = (node: TextViewCustomNode) => {
    if (node.name === "table") return <WordTable id={props.id} data={node.data as TableData} />;
    if (node.name === "aligned") {
      const align = (node.data as { align: "center" | "right" }).align;
      return <Blocks id={props.id} blocks={node.children ?? []} align={align} />;
    }
    if (node.name === "color") {
      const look = node.data as { color: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean };
      const lines = [look.underline ? "underline" : "", look.strike ? "line-through" : ""].filter(Boolean).join(" ");
      return (
        <Text
          style={{
            color: look.color,
            fontWeight: look.bold ? "700" : undefined,
            fontStyle: look.italic ? "italic" : undefined,
            textDecorationLine: (lines || undefined) as "underline" | undefined,
          }}
        >
          {node.text ?? ""}
        </Text>
      );
    }
    return <View />;
  };
  return (
    <TextView
      document={{ blocks: props.blocks }}
      selectable
      classes={{
        root: "gap-[10px] text-[#171717]",
        paragraph: props.align === "center" ? "text-center" : props.align === "right" ? "text-right" : "",
        code: "bg-[#f2f2f2] text-[#171717]",
        codeBlock: "bg-[#f2f2f2] text-[#171717]",
      }}
      renderCustom={renderCustom}
      renderImage={renderImage}
    />
  );
}

/** A table as the document drew it: the grid's widths share the row, a cell spans its columns. */
function WordTable(props: { id: string; data: TableData }) {
  const widthOf = (row: number, cell: number) => {
    const cells = props.data.rows[row]!.cells;
    const first = cells.slice(0, cell).reduce((n, c) => n + c.span, 0);
    const sum = props.data.widths.slice(first, first + cells[cell]!.span).reduce((n, w) => n + w, 0);
    return sum > 0 ? sum : cells[cell]!.span;
  };
  return (
    <View testID="office-table" class="border-t border-l" style={{ borderColor: RULE }}>
      {props.data.rows.map((row, r) => (
        <View class="flex-row">
          {row.cells.map((cell, c) => (
            <View
              class="border-r border-b px-2 py-[6px] min-w-0"
              style={{ borderColor: RULE, flexGrow: widthOf(r, c), flexBasis: 0, backgroundColor: cell.fill ?? undefined }}
            >
              {cell.blocks.length > 0 ? <Blocks id={props.id} blocks={cell.blocks} /> : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function WordView(props: { id: string; blocks: TextViewBlock[] }) {
  const pad = () => (narrowWindow() ? 24 : 56);
  return (
    <Scroll class="flex-1 min-h-0 bg-bg" contentClass="items-center p-4" testID="office-word">
      <View
        testID="office-docpage"
        class="w-full max-w-[816px]"
        style={{ backgroundColor: PAPER, paddingHorizontal: pad(), paddingVertical: pad(), borderRadius: 2 }}
      >
        <Blocks id={props.id} blocks={props.blocks} />
      </View>
    </Scroll>
  );
}
