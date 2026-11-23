/**
 * Controllable tooltips (`Tip` / `tip`) and the command lists that host long commands and skill
 * descriptions (`CommandActivity`, `ProjectCommandMenu`): measures each shown tooltip's actual
 * bounds so tests can verify width wrapping, line clamping, viewport clamping, and controlled open.
 */
import { signal, Scroll, Text, View } from "nsh";
import type { ClaudeCodeCommand } from "@real-bot/protocol";
import type { CommandRow } from "../src/m/chat/command-activity.ts";
import { CommandActivity } from "../src/ui/chat/CommandActivity";
import { ProjectCommandMenu } from "../src/ui/chat/ProjectCommandMenu";
import { Tip, tip } from "../src/ui/tip";

export const LONG_PROSE =
  "How to write and run a dynamic workflow script with the `run_workflow` tool: a Python script that orchestrates many agents with `agent`, `parallel`, `pipeline`, and `phase`. Use when a task splits into many independent or staged pieces of agent work (fan out over files, modules, bugs, or review angles, then aggregate), or when the user asks for a workflow. Don't use for a single delegated task (use a subagent) or for legacy workflow files (see migrate-workflows).";

export const LONG_UNBROKEN =
  "https://example.invalid/" + "very-long-segment-without-any-spaces/".repeat(12) + "end";

export const MANY_LINES = Array.from({ length: 24 }, (_, i) => `line ${i + 1}: echo running step ${i + 1} with extra arguments`).join("\n");

export const LONG_COMMAND =
  "cd /Users/example/projects/deskfolk && bun test --preload ./scripts/spec-setup.ts apps/desktop-nsh/app/src/ui/tip.test.tsx && git status --short && echo " +
  "long-shell-output-command-parameter-".repeat(8);

const COMMAND_ROWS: CommandRow[] = [
  ...Array.from({ length: 14 }, (_, i) => ({
    id: `c:${i + 1}`,
    turnId: "t",
    name: "shell",
    command: `echo step-${i + 1} ${"arg-".repeat(12)}`,
    running: false,
    exitCode: 0,
    durationMs: 50,
    text: `step-${i + 1} ok`,
  })),
  { id: "c:15", turnId: "t", name: "shell", command: "pnpm typecheck", running: false, exitCode: 0, durationMs: 420, text: "" },
  { id: "c:16", turnId: "t", name: "shell", command: LONG_COMMAND, running: false, exitCode: 0, durationMs: 1200, text: "all tests passed\n" },
];

const SLASH_COMMANDS: ClaudeCodeCommand[] = [
  { name: "compact", description: "Clear history", argument_hint: "", aliases: [] },
  { name: "run-workflow", description: LONG_PROSE, argument_hint: "", aliases: [] },
  { name: "empty", description: "   ", argument_hint: "", aliases: [] },
];

export default function TipStory() {
  const sizes = signal<Record<string, string>>({});
  const record = (name: string) => (e: { bounds: { size: { width: number; height: number } } }) => {
    const { width, height } = e.bounds.size;
    sizes.update((cur) => ({ ...cur, [name]: `${Math.round(width)}x${Math.round(height)}` }));
  };

  const controlledOpen = signal(false);
  const controlledDisabled = signal(false);
  const controlledEvents = signal<string[]>([]);
  const activeSlash = signal(0);
  const pickedSlash = signal("—");

  return (
    <Scroll class="flex-1 bg-bg" contentStyle={{ padding: 24, gap: 16 }}>
      <View class="gap-3">
        <View class="flex-row flex-wrap items-center gap-3">
          <View
            testID="anchor-short"
            tooltip={tip("Pin", { testID: "tip-short", onLayout: record("short") })}
            class="px-3 py-2 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">short</Text>
          </View>
          <View
            testID="anchor-long"
            tooltip={tip(LONG_PROSE, { testID: "tip-long", onLayout: record("long") })}
            class="px-3 py-2 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">long</Text>
          </View>
          <View
            testID="anchor-unbroken"
            tooltip={tip(LONG_UNBROKEN, { testID: "tip-unbroken", mono: true, onLayout: record("unbroken") })}
            class="px-3 py-2 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">unbroken</Text>
          </View>
          <View
            testID="anchor-lines"
            tooltip={tip(MANY_LINES, { testID: "tip-lines", mono: true, maxLines: 4, onLayout: record("lines") })}
            class="px-3 py-2 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">lines</Text>
          </View>
          <View
            testID="anchor-empty"
            tooltip={<Tip testID="tip-empty" label="   " />}
            class="px-3 py-2 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">empty</Text>
          </View>
          <View
            testID="anchor-controlled"
            tooltip={
              <Tip
                testID="tip-controlled"
                label="Controlled tooltip body"
                open={controlledOpen()}
                disabled={controlledDisabled()}
                onOpenChange={(e) => {
                  controlledEvents.update((list) => [...list, `${e.open ? "open" : "close"}:${e.reason}`]);
                  controlledOpen.set(e.open);
                }}
                onLayout={record("controlled")}
              />
            }
            class="px-3 py-2 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">controlled</Text>
          </View>
        </View>

        <View class="flex-row flex-wrap items-center gap-2">
          <View
            role="button"
            testID="toggle-controlled"
            onPress={() => controlledOpen.set(!controlledOpen())}
            class="cursor-pointer select-none px-2 py-1 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">toggle-open</Text>
          </View>
          <View
            role="button"
            testID="toggle-disabled"
            onPress={() => controlledDisabled.set(!controlledDisabled())}
            class="cursor-pointer select-none px-2 py-1 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">toggle-disabled</Text>
          </View>
          <View
            role="button"
            testID="away"
            onPress={() => undefined}
            class="cursor-pointer select-none px-2 py-1 rounded-(--radius-sm) bg-pane border border-line"
          >
            <Text class="text-[12px] text-ink">away</Text>
          </View>
        </View>

        <Text testID="tip-sizes" class="text-[11px] font-mono text-ink-muted">
          {`sizes:${JSON.stringify(sizes())}`}
        </Text>
        <Text testID="tip-events" class="text-[11px] font-mono text-ink-muted">
          {`events:${controlledEvents().join(",")}`}
        </Text>
        <Text testID="slash-picked" class="text-[11px] font-mono text-ink-muted">
          {`picked:${pickedSlash()}`}
        </Text>

        <View testID="story-commands" class="w-full max-w-[640px]">
          <CommandActivity rows={COMMAND_ROWS} />
        </View>

        <ProjectCommandMenu
          agentName="Antigravity"
          status={SLASH_COMMANDS}
          matches={SLASH_COMMANDS}
          active={activeSlash()}
          onHover={(i) => activeSlash.set(i)}
          onPick={(c) => pickedSlash.set(c.name)}
        />
      </View>
    </Scroll>
  );
}
