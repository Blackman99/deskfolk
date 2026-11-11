/**
 * Settings › Lessons (`settings/LessonsSettings.svelte`): the rules the app learned from a failure
 * and checks itself (ADR 0050/0051), one card per lesson with its kind, its badge, what it says,
 * how it did, and the buttons that change it: warn/block, retire, restore.
 *
 * Props: `lessons`; `onPatch(id, patch)` (your edit; resolves with the lesson as saved, rejects when
 * it did not go through). What you changed stays shown until the list is read again.
 */
import type { Lesson, LessonPatch } from "@real-bot/protocol";
import { signal, Text, View } from "nsh";
import { copy } from "../../runtime";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import { tip } from "../tip";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { BADGE_CLASS, BADGE_TEXT, badgeOf, kindOf, lastSeen } from "./lessons-view";

function LessonButton(props: { label: string; testID: string; disabled: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class="cursor-pointer select-none disabled:cursor-default group px-[10px] py-[3px] border border-line rounded-(--radius-full) bg-pane hover:border-accent-border disabled:opacity-[0.6]"
    >
      <Text class="text-[12px] text-ink-secondary group-hover:text-brand">{props.label}</Text>
    </View>
  );
}

export function LessonsSettings(props: {
  lessons: readonly Lesson[];
  onPatch: (id: string, patch: LessonPatch) => Promise<Lesson>;
}) {
  const t = () => copy();
  // What you changed here, until the list is read again.
  const saved = signal<Record<string, Lesson>>({});
  const busy = signal<string | null>(null);
  const failed = signal<string | null>(null);
  const shown = () => props.lessons.map((lesson) => saved()[lesson.id] ?? lesson);

  async function patch(lesson: Lesson, change: LessonPatch): Promise<void> {
    if (busy()) return;
    busy.set(lesson.id);
    failed.set(null);
    try {
      const next = await props.onPatch(lesson.id, change);
      saved.set({ ...saved(), [lesson.id]: next });
    } catch {
      failed.set(lesson.id);
    } finally {
      busy.set(null);
    }
  }

  const row = (lesson: Lesson) => {
    const c = t().lessons;
    const badge = badgeOf(lesson, t());
    const isShell = lesson.detector.tool === "shell";
    const check = lesson.detector.check;
    const seen = lastSeen(lesson);
    const off = busy() !== null;
    return (
      <View testID={`lesson-${lesson.id}`} class={`flex-col gap-[6px] px-3 py-[10px] border border-line rounded-(--radius-md) bg-pane ${lesson.status === "retired" ? "opacity-[0.65]" : ""}`}>
        <View class="flex-row items-center gap-2 min-w-0">
          <Text class={`min-w-0 shrink text-[12px] text-ink line-clamp-1 ${isShell ? "font-mono" : ""}`}>{kindOf(lesson, t())}</Text>
          <View testID={`lesson-${lesson.id}-badge`} class={`shrink-0 px-[7px] py-px border rounded-(--radius-full) ${BADGE_CLASS[badge.tone]}`}>
            <Text class={`text-[11px] font-semibold ${BADGE_TEXT[badge.tone]}`}>{badge.label}</Text>
          </View>
        </View>
        <Text class="text-[13px] leading-[1.45] text-ink-secondary">{lesson.text}</Text>
        <If when={check}>
          {(shownCheck) => (
            <View class="flex-row flex-wrap items-baseline gap-[6px]">
              <Text class="text-[12px] text-ink-muted">{c.checkKind[shownCheck().kind as "exists" | "contains" | "matches"] ?? shownCheck().kind}</Text>
              <Text class="px-1 rounded-(--radius-sm) bg-chip text-[12px] text-ink font-mono">{shownCheck().path ?? ""}</Text>
              <If when={shownCheck().pattern}>
                <Text class="px-1 rounded-(--radius-sm) bg-chip text-[12px] text-ink font-mono">{shownCheck().pattern ?? ""}</Text>
              </If>
            </View>
          )}
        </If>
        <View class="flex-row flex-wrap items-baseline">
          <Text class="text-[11px] leading-[1.45] text-ink-muted">
            {isShell ? c.stats(lesson.hits, lesson.prevented, lesson.recurrences) : c.fromReflection}
          </Text>
          <If when={seen}>
            {(at) => (
              <View tooltip={tip(formatFullTimestamp(at()))}>
                <Text class="text-[11px] leading-[1.45] text-ink-muted">{` · ${c.lastSeen(formatMessageTime(at()))}`}</Text>
              </View>
            )}
          </If>
        </View>
        <View class="flex-row flex-wrap items-center gap-[6px]">
          <If
            when={lesson.status === "retired"}
            else={
              <>
                <If when={isShell}>
                  <LessonButton
                    testID={`lesson-${lesson.id}-mode`}
                    label={lesson.action === "block" ? c.toWarn : c.toBlock}
                    disabled={off}
                    onPress={() => void patch(lesson, { action: lesson.action === "block" ? "warn" : "block" })}
                  />
                </If>
                <LessonButton testID={`lesson-${lesson.id}-retire`} label={c.retire} disabled={off} onPress={() => void patch(lesson, { status: "retired" })} />
              </>
            }
          >
            <If when={isShell || (lesson.action === "checklist" && lesson.confirmed_at)}>
              <LessonButton testID={`lesson-${lesson.id}-restore`} label={c.restore} disabled={off} onPress={() => void patch(lesson, { status: "active" })} />
            </If>
          </If>
          <If when={failed() === lesson.id}>
            <Text role="text" testID={`lesson-${lesson.id}-failed`} class="text-[11px] text-danger-text">
              {c.failed}
            </Text>
          </If>
        </View>
      </View>
    );
  };

  return (
    <View class="flex-col gap-[14px]">
      <SettingsCard testID="lessons-card">
        <SettingsCardHeader title={t().lessons.title} subtitle={t().lessons.subtitle} />
        <View class="flex-col gap-[10px]">{() => shown().map(row)}</View>
      </SettingsCard>
    </View>
  );
}
