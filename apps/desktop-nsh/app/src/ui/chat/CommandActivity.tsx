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
import { cleanup, computed, effect, Scroll, signal, Text, View, type JSX, type ScrollRef } from "nsh";
import { formatDuration, type CommandRow } from "../../m/chat/command-activity.ts";
import { outputLang } from "../../m/chat/command-output.ts";
import { codeColorsAvailable, codeSurface, codeTheme, colorSpans, highlightCode, wantCodeColors } from "../code-colors";
import { commandLine, splitProgram } from "../../m/chat/command-line.ts";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { Tip } from "../tip";

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** A finished command's output, in the colours of how it reads. */
function OutputText(props: { text: string; command: string | null }) {
  wantCodeColors();
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
  // Controlled row tooltip: one at a time, dismissed on scroll, click or collapse.
  const openTip = signal<string | null>(null);
  const rowTip = (row: () => CommandRow) => (
    <Tip
      testID={`command-tip-${row().id}`}
      label={row().command ?? row().name}
      open={openTip() === row().id}
      onOpenChange={(e) => {
        const id = row().id;
        if (e.open) openTip.set(id);
        else if (openTip() === id) openTip.set(null);
      }}
      mono
      align="start"
      maxWidth={420}
      maxLines={6}
    />
  );

  // The list follows new commands the way a terminal does, unless you have scrolled up to read. Each
  // time it opens it starts at its end, as the messenger's does.
  let list: ScrollRef | undefined;
  let atEnd = true;
  // From the list's mount to its first layout (the Scroll's `onLayout`).
  let placing = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  const toEnd = () => list?.scrollTo({ y: 1_000_000, animated: false });
  const followEnd = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      if (atEnd) toEnd();
    }, 0);
  };
  cleanup(() => {
    if (pending) clearTimeout(pending);
  });
  // By the count, as the messenger's `use:follow={done.length}`: the rows come as a new array on every
  // read of a subagent (1.5 s) and every event of a turn, and following the array sent the list back
  // to its end each time, past an output you had opened at its foot.
  const count = computed(() => done().length);
  effect(() => {
    void count();
    if (atEnd) followEnd();
  });

  return (
    <If when={done().length}>
      <View testID="command-activity" accessibilityLabel={t().chat.commandActivity} class="items-start gap-[6px] mt-[8px]">
        <View class="flex-row flex-wrap items-center self-stretch gap-x-[14px] gap-y-[6px] max-w-full">
          <View
            role="button"
            testID="command-summary"
            accessibilityState={{ expanded: expanded() }}
            onPress={() => {
              openTip.set(null);
              expanded.set(!expanded());
            }}
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
              testID="command-scroll"
              ref={(node) => {
                list = node;
                atEnd = true;
                placing = true;
              }}
              class="max-h-[372px]"
              // Going to the end once it has its place is also what makes the rows show. NSH (rev 7a2c11e0,
              // upstream main too) looks for the held-back content of a scroll view before a List places the
              // row the scroll view is in, so a card opened in a transcript row stayed an empty box until
              // something else laid the window out again. A scroll command makes it look again. Only the
              // first layout: the card grows when an output opens, and that must not scroll it away.
              onLayout={() => {
                if (!placing) return;
                placing = false;
                toEnd();
              }}
              onScroll={(e) => {
                openTip.set(null);
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
                          <View class="flex-row items-center gap-[8px] w-full min-h-[30px] px-[10px]" tooltip={rowTip(row)}>
                            <Line row={row()} openable={false} open={false} />
                          </View>
                        }
                      >
                        <View
                          role="button"
                          testID="command-line"
                          accessibilityState={{ expanded: open() }}
                          tooltip={rowTip(row)}
                          onPress={() => {
                            openTip.set(null);
                            opened.set(opened() === row().id ? null : row().id);
                          }}
                          class={`cursor-pointer select-none flex-row items-center gap-[8px] w-full min-h-[30px] px-[10px] hover:bg-row-hover ${open() ? "bg-row-hover" : ""}`}
                        >
                          <Line row={row()} openable open={open()} />
                        </View>
                      </If>
                      <If when={open()}>
                        <Scroll
                          testID="command-output"
                          class="max-h-[230px] border-t border-line-subtle bg-chip"
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
