/** Settings › Prompts, Lessons and Notifications: the prompt list and its editor page, the lessons, the three notification cards. */
import type { Lesson, LessonPatch, PromptSummary } from "@real-bot/protocol";
import { effect, ErrorBoundary, Scroll, signal, Text, View, windowSize } from "nsh";
import { copy, runtime } from "../src/runtime";
import { LessonsSettings } from "../src/ui/settings/LessonsSettings";
import { NotificationSettings } from "../src/ui/settings/NotificationSettings";
import { PromptsSettings, type PromptsSettingsApi } from "../src/ui/settings/PromptsSettings";

const TABS = ["prompts", "lessons", "notifications"] as const;
type Tab = (typeof TABS)[number];

const base: Pick<Lesson, "scope" | "scope_id" | "hook" | "evidence" | "hits" | "prevented" | "recurrences" | "created_by" | "confirmed_at" | "created_at" | "updated_at"> = {
  scope: "global",
  scope_id: null,
  hook: "before_tool",
  evidence: [{ turn_id: "t1", at: "2026-10-05T08:30:00.000Z" }] as Lesson["evidence"],
  hits: 4,
  prevented: 2,
  recurrences: 1,
  created_by: "app",
  confirmed_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-05T08:30:00.000Z",
};

const shell = (id: string, head: string, action: "warn" | "block", status: Lesson["status"]): Lesson => ({
  ...base,
  id,
  action,
  status,
  detector: { tool: "shell", signature: head, head, place: "/", error: "timeout" },
  text: `${head} 跑满了超时：别递归扫整棵树。`,
});

const LESSONS: Lesson[] = [
  shell("L-warn", "grep -r", "warn", "active"),
  shell("L-block", "find /", "block", "active"),
  shell("L-old", "du -a", "warn", "retired"),
  {
    ...base,
    id: "L-list",
    hook: "before_submit",
    action: "checklist",
    status: "active",
    confirmed_at: "2026-10-06T08:00:00.000Z",
    detector: { tool: "reflection", signature: "", head: "", place: "", error: "" },
    text: "交付前确认测试跑过。",
  },
  {
    ...base,
    id: "L-check",
    action: "propose_check",
    status: "candidate",
    detector: { tool: "reflection", signature: "", head: "", place: "", error: "", check: { kind: "contains", path: "README.md", pattern: "安装" } as never },
    text: "README 里要有安装一节。",
  },
];

export default function SettingsPrompts() {
  const tab = signal<Tab>("prompts");
  const items = signal<PromptSummary[]>([]);
  const failed = signal(false);
  const log = signal("");
  const lessons = signal<Lesson[]>(LESSONS);
  const apiBox = signal<PromptsSettingsApi | null>(null);
  const api = () => apiBox();

  effect(() => {
    // Read every dependency before any early return: an effect tracks only what it read.
    const connected = runtime.connection === "connected";
    const client = runtime.client;
    void runtime.promptsRevision;
    if (!client || !connected) return;
    void client.listPrompts().then(
      (list) => {
        if (runtime.client !== client) return;
        items.set(list);
        failed.set(false);
      },
      () => failed.set(true),
    );
  });

  // The test process has no network of its own, so what the daemon holds is read back through the app's client.
  const probe = signal("");
  const read = async (what: string, run: () => Promise<unknown>) => {
    try {
      probe.set(`${what}=${JSON.stringify(await run())}`);
    } catch (error) {
      probe.set(`${what}!${String(error)}`);
    }
  };
  const probeButton = (id: string, label: string, run: () => Promise<unknown>) => (
    <View role="button" testID={id} onPress={() => void read(label, run)} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px]">{label}</Text>
    </View>
  );

  const onPatch = async (id: string, patch: LessonPatch): Promise<Lesson> => {
    log.set(`patch:${id}:${JSON.stringify(patch)}`);
    if (id === "L-block" && patch.status === "retired") throw new Error("refused");
    const next = { ...lessons().find((lesson) => lesson.id === id)!, ...patch } as Lesson;
    return next;
  };

  return (
    <View class="flex-col bg-bg" style={{ height: windowSize().height }}>
      <View class="flex-row items-center gap-2 px-6 py-2 border-b border-line">
        {() =>
          TABS.map((name) => (
            <View role="button" testID={`story-tab-${name}`} onPress={() => tab.set(name)} class={`px-2 py-1 border rounded-(--radius-sm) ${tab() === name ? "border-brand" : "border-line"}`}>
              <Text class="text-[12px]">{name}</Text>
            </View>
          ))
        }
        <View role="button" testID="story-back" onPress={() => log.set(`back:${api()?.backFromEditor() ? "editor" : api()?.backFromSection() ? "section" : "none"}`)} class="px-2 py-1 border border-line rounded-(--radius-sm)">
          <Text class="text-[12px]">back</Text>
        </View>
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log()}`}</Text>
        {probeButton("probe-prompts", "prompts", async () => (await runtime.client!.listPrompts()).map((item) => `${item.id}:${item.locales.map((l) => l.state).join("/")}`))}
        {probeButton("probe-text", "text", async () => {
          const detail = await runtime.client!.getPrompt("turn.memory", "zh");
          return { text: detail.text, edited: detail.base_text != null, revisions: detail.revisions.length, same: detail.text === detail.default_text };
        })}
        {probeButton("probe-policy", "policy", async () => {
          const policy = await runtime.client!.getNotificationPolicy();
          return { categories: policy.categories, quiet: policy.quiet_hours.enabled };
        })}
        {probeButton("probe-device", "device", async () => {
          const device = await runtime.client!.getNotificationDevice();
          return { enabled: device.enabled, badge: device.badge, sound: device.sound, preview: device.preview };
        })}
        <Text testID="story-title" class="text-[12px] text-ink-muted">{`title:${api()?.sectionTitle() ?? ""}`}</Text>
      </View>
      <Text testID="story-probe" class="px-6 text-[11px] text-ink-muted">{`probe:${probe()}`}</Text>
      <If when={tab() === "prompts"}>
        <ErrorBoundary fallback={(error) => <Text testID="story-error" class="text-[12px] text-danger-text">{`error:${String(error)} ${(error as Error)?.stack ?? ""}`}</Text>}>
        <PromptsSettings
          items={items()}
          loadFailed={failed()}
          closeSettings={() => log.set("close-settings")}
          openRouting={() => log.set("routing")}
          notices={<Text testID="story-notice" class="text-[12px] text-ink-muted">{copy().prompts.intro.slice(0, 0)}</Text>}
          onReady={(next) => {
            apiBox.set(next);
          }}
        />
        </ErrorBoundary>
      </If>
      <If when={tab() === "lessons"}>
        <Scroll class="flex-1">
          <View class="p-6">
            <LessonsSettings lessons={lessons()} onPatch={onPatch} />
          </View>
        </Scroll>
      </If>
      <If when={tab() === "notifications"}>
        <Scroll class="flex-1">
          <View class="p-6">
            <NotificationSettings />
          </View>
        </Scroll>
      </If>
    </View>
  );
}
