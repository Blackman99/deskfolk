/**
 * What a turn has run so far (`CommandActivity.svelte`): the finished commands, folded to one line
 * until you open it. The one running now is the bubble's last line, and opening that line shows what
 * it prints; it joins this list when it ends. One command's output opens at a time, and only when
 * you ask for it; a command that printed nothing is a plain line.
 *
 * Output is painted as the messenger paints it (`command-output.ts`'s `outputLang`: a viewed file by
 * its name, JSON and diffs by their look, anything else as a log), in the code colours of chat
 * (`code-colors.tsx`). Output with colour codes of its own is shown plain, without them.
 */
import { computed, effect, Scroll, signal, Text, View, type JSX, type ScrollRef } from "nsh";
import { formatDuration, type CommandRow } from "../../m/chat/command-activity.ts";
import { outputLang } from "../../m/chat/command-output.ts";
import { codeColorsAvailable, codeSurface, codeTheme, colorSpans, highlightCode } from "../code-colors";
import { commandLine, splitProgram } from "../../m/chat/command-line.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** A finished command's output, in the colours of how it reads. */
function OutputText(props: { text: string; command: string | null }) {
  const runs = computed(() => {
    if (!codeColorsAvailable()) return null;
    const lang = outputLang(props.command, props.text);
    return lang === "ansi" ? null : highlightCode(props.text, lang, codeTheme("chat"));
  });
  return (
    <Text
      class={`py-[10px] pr-[14px] text-[11.5px] leading-[1.6] font-mono text-ink ${narrowWindow() ? "pl-[14px]" : "pl-[32px]"}`}
      style={runs() ? { color: codeSurface()?.fg ?? runs()!.fg } : undefined}
    >
      {runs() ? colorSpans(props.text, runs()!) : props.text.replace(ANSI, "")}
    </Text>
  );
}

function isFailed(row: CommandRow): boolean {
  if (row.endedAs) return false;
  return row.ok === false || (row.exitCode !== null && row.exitCode !== 0);
}

function Line(props: { row: CommandRow; openable: boolean; open: boolean }) {
  const t = () => copy();
  const parts = () => splitProgram(commandLine(props.row.command ?? props.row.name));
  const tone = () => (isFailed(props.row) ? "danger" : props.row.endedAs ? "muted" : "ok");
  return (
    <>
      <View class="w-[14px] items-center justify-center shrink-0">
        <Icon
          name={isFailed(props.row) ? "x" : props.row.endedAs ? "square" : "check"}
          size={12}
          class={tone() === "danger" ? "tint-danger" : tone() === "muted" ? "tint-ink-muted" : "tint-ok"}
        />
      </View>
      <Text class="flex-1 min-w-0 text-[12px] font-mono text-ink-muted line-clamp-1">
        <Text class="font-semibold text-ink">{parts().program}</Text>
        {parts().rest}
      </Text>
      <View class="flex-row gap-[8px] shrink-0">
        <If when={props.row.endedAs}>
          <Text class="text-[11px] font-mono text-ink-muted">{props.row.endedAs}</Text>
        </If>
        <If when={isFailed(props.row)}>
          <Text class="text-[11px] font-mono text-danger-text">
            {props.row.exitCode !== null ? t().chat.activity.exit(props.row.exitCode) : t().chat.activity.failed}
          </Text>
        </If>
        <If when={props.row.durationMs !== null}>
          <Text class="text-[11px] font-mono text-ink-muted">{formatDuration(props.row.durationMs!)}</Text>
        </If>
      </View>
      <If when={props.openable} else={<View class="w-[12px] shrink-0" />}>
        <Icon name="chevron-right" size={12} class={`shrink-0 tint-ink-muted ${props.open ? "rotate-90" : ""}`} />
      </If>
    </>
  );
}

export function CommandActivity(props: {
  rows: CommandRow[];
  /** Something short to sit on the commands' line while there is room: the reply's tag and time. */
  beside?: JSX.Element;
  /** The folded line's words, where the rows are not all commands: a subagent's tool calls. */
  countLabel?: (count: number) => string;
}) {
  const t = () => copy();
  const done = () => props.rows.filter((row) => !row.running);
  const failed = () => done().filter(isFailed).length;
  const expanded = signal(false);
  const opened = signal<string | null>(null);

  // The list follows new commands the way a terminal does, unless you have scrolled up to read.
  let list: ScrollRef | undefined;
  let atEnd = true;
  effect(() => {
    void done().length;
    if (atEnd) setTimeout(() => list?.scrollTo({ y: 1_000_000, animated: false }), 0);
  });

  return (
    <If when={done().length}>
      <View testID="command-activity" accessibilityLabel={t().chat.commandActivity} class="items-start gap-[6px] mt-[8px]">
        <View class="flex-row flex-wrap items-center self-stretch gap-x-[14px] gap-y-[6px] max-w-full">
          <View
            role="button"
            testID="command-summary"
            accessibilityState={{ expanded: expanded() }}
            onPress={() => expanded.set(!expanded())}
            class="cursor-pointer select-none group flex-row items-center gap-[6px] max-w-full py-[2px]"
          >
            <Icon name="terminal" size={16} class={expanded() ? "tint-ink-secondary" : "tint-ink-muted group-hover:tint-ink-secondary"} />
            <Text class={`text-[12px] ${expanded() ? "text-ink-secondary" : "text-ink-muted group-hover:text-ink-secondary"}`}>
              {(props.countLabel ?? t().chat.commandCount)(done().length)}
            </Text>
            <If when={failed() > 0}>
              <Text class="text-[12px] text-danger-text">{`· ${t().chat.commandsFailed(failed())}`}</Text>
            </If>
            <Icon name="chevron-right" size={12} class={`opacity-[0.7] tint-ink-muted ${expanded() ? "rotate-90" : ""}`} />
          </View>
          <If when={props.beside}>
            <View class="flex-row flex-1 flex-wrap items-center gap-x-[14px] gap-y-[6px] min-w-0 max-w-full">{props.beside}</View>
          </If>
        </View>
        <If when={expanded()}>
          <View testID="command-card" class="self-stretch overflow-hidden border border-line rounded-(--radius-md) bg-pane" style={{ boxShadow: shadow("xs") }}>
            <Scroll
              ref={(node) => (list = node)}
              class="max-h-[372px]"
              onScroll={(e) => {
                atEnd = e.contentSize.height - e.offset.y - e.size.height < 8;
              }}
            >
              <Each of={done()} key={(row) => row.id}>
                {(row, index) => {
                  const openable = () => Boolean(row().text);
                  const open = () => openable() && opened() === row().id;
                  return (
                    <View testID="command-row" class={index() > 0 ? "border-t border-line-subtle" : ""}>
                      <If
                        when={openable()}
                        else={
                          <View class="flex-row items-center gap-[8px] w-full min-h-[30px] px-[10px]" tooltip={tip(row().command ?? row().name)}>
                            <Line row={row()} openable={false} open={false} />
                          </View>
                        }
                      >
                        <View
                          role="button"
                          testID="command-line"
                          accessibilityState={{ expanded: open() }}
                          tooltip={tip(row().command ?? row().name)}
                          onPress={() => opened.set(opened() === row().id ? null : row().id)}
                          class={`cursor-pointer select-none flex-row items-center gap-[8px] w-full min-h-[30px] px-[10px] hover:bg-row-hover ${open() ? "bg-row-hover" : ""}`}
                        >
                          <Line row={row()} openable open={open()} />
                        </View>
                      </If>
                      <If when={open()}>
                        <Scroll
                          testID="command-output"
                          class="max-h-[230px] border-t border-line-subtle bg-code-bg"
                          style={codeSurface() ? { backgroundColor: codeSurface()!.bg } : undefined}
                        >
                          <OutputText text={row().text} command={row().command ?? null} />
                        </Scroll>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </Scroll>
          </View>
        </If>
      </View>
    </If>
  );
}
