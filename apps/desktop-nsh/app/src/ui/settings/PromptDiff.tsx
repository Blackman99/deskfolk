/**
 * A diff of a prompt as the editor shows it (the `diffText` snippet and `.prompt-diff` of
 * `settings/PromptEditor.svelte`): a changed line with the part that changed marked, so a space
 * added or taken out shows. Lines are `markChanges(changedLines(before, after))`.
 *
 * Props: `lines`; `full` (the comparison view: no box of its own, no height cap); `testID`.
 * The lines are `${testID}-line-${n}`, a marked part `${testID}-mark-${n}`.
 */
import { Scroll, Text, View } from "nsh";
import type { MarkedLine } from "../../m/settings/prompts-view.ts";

const LINE: Record<string, string> = { del: "bg-danger-bg", add: "bg-ok-bg", gap: "", same: "" };
const INK: Record<string, string> = { del: "text-danger-text line-through", add: "text-ok-text", gap: "text-ink-muted", same: "text-ink-secondary" };
const MARK: Record<string, string> = { del: "bg-danger-line", add: "bg-ok-line", gap: "", same: "" };

function LineText(props: { line: MarkedLine; testID: string }) {
  const line = () => props.line;
  return (
    <Text class={`text-[12px] leading-[1.5] font-mono ${INK[line().kind] ?? ""}`}>
      <If when={line().kind === "gap"} else={<LineBody line={line()} testID={props.testID} />}>⋯</If>
    </Text>
  );
}

function LineBody(props: { line: MarkedLine; testID: string }) {
  const line = () => props.line;
  return (
    <If when={line().mark} else={line().text || " "}>
      {(mark) => (
        <>
          {line().text.slice(0, mark().start)}
          <Text testID={`${props.testID}-mark`} class={`${MARK[line().kind] ?? ""}`}>
            {line().text.slice(mark().start, mark().end)}
          </Text>
          {line().text.slice(mark().end)}
        </>
      )}
    </If>
  );
}

export function PromptDiff(props: { lines: readonly MarkedLine[]; full?: boolean; testID?: string; maxHeight?: number }) {
  const id = () => props.testID ?? "prompt-diff";
  const rows = () =>
    props.lines.map((line, at) => (
      <View testID={`${id()}-line-${at}`} accessibilityLabel={line.kind} class={LINE[line.kind] ?? ""}>
        <LineText line={line} testID={`${id()}-line-${at}`} />
      </View>
    ));
  const box = () => (
    <View testID={id()} class={`flex-col border border-line rounded-(--radius-md) bg-pane ${props.full ? "px-[10px] py-2" : "px-2 py-[6px]"}`}>
      {() => rows()}
    </View>
  );
  return <If when={props.maxHeight} else={box()}>{(max) => <Scroll style={{ maxHeight: max() }}>{box()}</Scroll>}</If>;
}

