/**
 * The Office preview (`OfficeViewer`): the three samples in `native/tests/fixtures/` (their bytes,
 * `office-samples.ts`), a package that is not Office (`broken.docx`), a zip bomb (`bomb.xlsx`, one
 * 33 MB entry) and a file the runtime does not have (`path`: it answers 404).
 * The artifacts job mounts the viewer later; this story is the caller.
 */
import { signal, Text, View } from "nsh";
import { Button } from "../src/ui/Button";
import { OfficeViewer } from "../src/ui/overlays/OfficeViewer";
import type { OfficeKind } from "../src/ui/overlays/office-model";
import { BIG, BOMB, BROKEN, DOCX, PPTX, RICH_DOCX, RICH_PPTX, XLSX } from "./office-samples";

const FILES = {
  word: { base64: DOCX, kind: "word", title: "sample.docx" },
  sheet: { base64: XLSX, kind: "spreadsheet", title: "sample.xlsx" },
  deck: { base64: PPTX, kind: "presentation", title: "sample.pptx" },
  richword: { base64: RICH_DOCX, kind: "word", title: "rich.docx" },
  richdeck: { base64: RICH_PPTX, kind: "presentation", title: "rich.pptx" },
  broken: { base64: BROKEN, kind: "word", title: "broken.docx" },
  big: { base64: BIG, kind: "spreadsheet", title: "big.xlsx" },
  bomb: { base64: BOMB, kind: "spreadsheet", title: "bomb.xlsx" },
  missing: { path: "no/such/file.pptx", kind: "presentation", title: "missing.pptx" },
} satisfies Record<string, { path?: string; base64?: string; kind: OfficeKind; title: string }>;

export default function Office() {
  const open = signal<keyof typeof FILES>("word");
  const file = () => FILES[open()];
  return (
    <View class="flex-1 gap-3 p-6 bg-bg">
      <View class="flex-row flex-wrap gap-2">
        {(Object.keys(FILES) as (keyof typeof FILES)[]).map((name) => (
          <Button testID={`story-open-${name}`} size="sm" onPress={() => open.set(name)}>{name}</Button>
        ))}
        <Text testID="story-open" class="text-[12px] text-ink-muted self-center">{open()}</Text>
      </View>
      <View class="flex-1 min-h-0 border border-line rounded-(--radius-md) overflow-hidden">
        <OfficeViewer path={(file() as { path?: string }).path} base64={(file() as { base64?: string }).base64} kind={file().kind} title={file().title} />
      </View>
    </View>
  );
}
