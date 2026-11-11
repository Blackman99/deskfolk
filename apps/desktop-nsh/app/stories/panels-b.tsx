/**
 * The Bot settings' tabs on one screen: the basics (with the autosave ProfilePane would own), the
 * routines, the memory and the actions. Writer is the runtime's own Bot, so a change to its basics,
 * a routine or archiving it can be read back through the API.
 *
 * The runtime has no way to write a memory (the Bot does, in a turn), so the story puts seven
 * sample memories of Writer into the snapshot and answers their edit and delete itself; the
 * other calls go to the runtime as they are.
 */
import { Scroll, Text, View, computed, effect, signal, untracked } from "nsh";
import type { Bot, Memory, Routine, SessionSummary } from "@real-bot/protocol";
import { Autosave } from "../src/m/autosave.svelte";
import { findPicked } from "../src/m/model-picker";
import { endpointModelPicker, mapCreateBotError, pickerValues, planCreateBot, type CreateBotFieldErrors } from "../src/m/panels/create-form";
import { profileNeedsSave, type ProfileFields } from "../src/m/panels/roster-edit";
import { runnerValueOf } from "../src/m/runner-choice";
import { modelSelectValue } from "../src/m/settings/provider-form";
import { classifySession, presentBotIds } from "../src/m/sidebar/session-groups";
import { copy, runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { narrowWindow } from "../src/ui/Modal";
import { DangerDialog } from "../src/ui/overlays/DangerDialog";
import { BotActionsCard } from "../src/ui/panels/BotActionsCard";
import { MemoryCard, type MemoryCardApi } from "../src/ui/panels/MemoryCard";
import { ProfileBasics } from "../src/ui/panels/ProfileBasics";
import { RoutineCard, type RoutineCardApi } from "../src/ui/panels/RoutineCard";

const fakeMemory = (n: number, over: Partial<Memory> = {}): Memory =>
  ({
    id: `fake-${n}`,
    bot_id: "",
    subject: `记忆 ${n}`,
    body: `第 ${n} 条记忆的内容。`,
    source_session_id: null,
    source_message_id: null,
    learning: null,
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  }) as unknown as Memory;

function botModelValue(row: Bot): string {
  if (!row.model) return "";
  if (row.provider_id) return modelSelectValue(row.provider_id, row.model);
  const match = runtime.snapshot.providers.find((p) => p.models.includes(row.model!));
  return match ? modelSelectValue(match.id, row.model) : row.model;
}

function emptyProfile(row: Bot): ProfileFields {
  return {
    name: row.name,
    duties: row.duties,
    boundaries: row.boundaries,
    avatar: row.avatar ?? "",
    model: botModelValue(row),
    thinkingLevel: row.thinking_level ?? "",
    runner: runnerValueOf(row.runner, row.agent_custom_id),
    agentModel: row.agent_model ?? "",
    agentEffort: row.agent_effort ?? "",
    agentConfigDir: row.agent_config_dir === undefined ? undefined : (row.agent_config_dir ?? ""),
    permissionMode: row.permission_mode === undefined ? undefined : (row.permission_mode ?? ""),
  };
}

/** Answers the sample memories' edit and delete (ids `fake-…`); once per runtime. */
function fakeMemoryCalls(log: (line: string) => void): void {
  const mark = runtime as unknown as { __fakeMemories?: boolean };
  if (mark.__fakeMemories) return;
  mark.__fakeMemories = true;
  const patch = runtime.patchMemory.bind(runtime);
  const remove = runtime.deleteMemory.bind(runtime);
  runtime.patchMemory = async (id, body) => {
    if (!id.startsWith("fake-")) return patch(id, body);
    runtime.snapshot = {
      ...runtime.snapshot,
      memories: runtime.snapshot.memories.map((m) => (m.id === id ? { ...m, ...body, updated_at: new Date().toISOString() } : m)),
    };
    log(`memory-saved:${id}`);
    return null;
  };
  runtime.deleteMemory = async (id) => {
    if (!id.startsWith("fake-")) return remove(id);
    runtime.snapshot = { ...runtime.snapshot, memories: runtime.snapshot.memories.filter((m) => m.id !== id) };
    log(`memory-deleted:${id}`);
    return null;
  };
}

export default function PanelsB() {
  const bot = computed<Bot | null>(() => runtime.snapshot.bots.find((b) => b.name === "Writer") ?? null);
  const direct = computed(() => {
    const b = bot();
    return b ? (runtime.snapshot.sessions.find((s) => classifySession(s) === "you-bot" && presentBotIds(s).includes(b.id)) ?? null) : null;
  });
  const log = signal("—");
  const danger = signal<{ kind: string; run: (isCurrent: () => boolean) => Promise<void> } | null>(null);
  const memoryApi = signal<MemoryCardApi | null>(null);
  const routineApi = signal<RoutineCardApi | null>(null);
  const apiLog = signal("");
  const claudeUnavailable = signal(false);

  // The test host has no network of its own, so what the daemon holds is read from here.
  const probe = signal("");
  const readDaemon = async (name: string, read: (get: <T>(path: string) => Promise<T>) => Promise<string>) => {
    probe.set("");
    const client = runtime.client;
    if (!client) return probe.set(`${name}:no client`);
    probe.set(`${name}:${await read((path) => client.get(path))}`);
  };
  const probeRoutines = () =>
    readDaemon("routines", async (get) => {
      const id = bot()?.id;
      const rows = (await get<{ items: Routine[] }>("/v1/routines")).items.filter((r) => r.bot_id === id);
      return rows
        .map((r) => `${r.title}|${r.schedule.time}|${r.schedule.kind === "weekly" ? r.schedule.weekdays.join(",") : "daily"}|${r.enabled ? "on" : "off"}|${r.instruction}`)
        .join(";");
    });
  const probeBot = () =>
    readDaemon("bot", async (get) => {
      const row = (await get<{ items: Array<Bot & { permission_mode?: string | null }> }>("/v1/bots")).items.find((b) => b.id === bot()?.id);
      return row ? `${row.name}|${row.duties}|${row.archived_at ? "archived" : "active"}|${row.permission_mode ?? ""}` : "missing";
    });
  const probePlaybook = () =>
    readDaemon("playbook", async (get) => {
      const rows = await get<{ items: SessionSummary[] }>("/v1/sessions");
      const row = rows.items.find((s) => s.id === direct()?.id);
      return row?.playbook_id ?? "none";
    });
  const seedRoutine = (title: string, time: string, instruction: string) =>
    void runtime.createRoutine({ bot_id: bot()!.id, title, instruction, schedule: { kind: "daily", time }, enabled: true });
  const clearRoutines = async () => {
    for (const row of runtime.snapshot.routines.filter((r) => r.bot_id === bot()?.id)) await runtime.deleteRoutine(row.id, row.updated_at);
  };

  // The shell selects the Bot's direct (the mute and the engine rows are its).
  effect(() => {
    const d = direct();
    if (d && untracked(() => runtime.selectedId) !== d.id) void runtime.selectSession(d.id);
  });

  // Sample memories of Writer, once the Bot is known.
  let seeded = false;
  effect(() => {
    const b = bot();
    if (!b || seeded) return;
    seeded = true;
    fakeMemoryCalls((line) => log.set(line));
    const source = untracked(() => direct());
    const own = (n: number, over: Partial<Memory> = {}) => fakeMemory(n, { bot_id: b.id, ...over });
    runtime.snapshot = {
      ...runtime.snapshot,
      memories: [
        own(1, { subject: "回复偏好", body: "倾向简短直接，不要铺垫。", source_session_id: source?.id ?? null, source_message_id: "msg-1" }),
        own(2, { subject: "口径", body: "报表以自然周为口径。", learning: { later: 0, shorter: 0 } as Memory["learning"] }),
        own(3, { subject: "已停用的", body: "这一条先不用。", enabled: false }),
        own(4),
        own(5),
        own(6),
        own(7),
        fakeMemory(8, { bot_id: "someone-else", subject: "别人的记忆" }),
      ],
    };
  });

  // The profile's draft and its autosave, as ProfilePane keeps them.
  const draft = signal<ProfileFields | null>(null);
  let baseline: ProfileFields | null = null;
  const errors = signal<CreateBotFieldErrors>({});
  const failed = signal(false);
  const autosave = new Autosave();
  effect(() => {
    const b = bot();
    if (b && !untracked(draft)) {
      draft.set(emptyProfile(b));
      baseline = emptyProfile(b);
    }
  });
  const listedModels = () => endpointModelPicker(runtime.snapshot.providers, copy());
  const unlistedPin = () => {
    const b = bot();
    const value = b ? botModelValue(b) : "";
    return value && !findPicked(listedModels(), value) ? value : null;
  };
  let queued = false;
  async function saveProfile(): Promise<void> {
    const b = bot();
    const sent = untracked(draft);
    if (!b || !sent) return;
    if (autosave.saving) {
      queued = true;
      return;
    }
    if (!baseline || !profileNeedsSave(sent, baseline)) return;
    const plan = planCreateBot(sent, pickerValues(listedModels()));
    if (!plan.ok) {
      errors.set(plan.errors);
      return;
    }
    autosave.saving = true;
    failed.set(false);
    errors.set({});
    const error = await runtime.patchBot(b.id, plan.body);
    autosave.saving = false;
    if (!error) {
      baseline = sent;
      autosave.savedTick += 1;
    } else {
      const mapped = mapCreateBotError(error.status, error.message);
      if ("top" in mapped) failed.set(true);
      else errors.set(mapped);
    }
    if (queued) {
      queued = false;
      void saveProfile();
    }
  }
  const schedule = (delay: number) => {
    errors.set({});
    failed.set(false);
    autosave.schedule(() => void saveProfile(), delay);
  };

  const openDanger = (kind: "skill" | "memory", run: (isCurrent: () => boolean) => Promise<void>) => danger.set({ kind, run });
  const clearDanger = () => danger.set(null);

  return (
    <Scroll class="flex-1 bg-bg">
      <View class={`gap-6 p-6 ${narrowWindow() ? "flex-col" : "flex-row"}`}>
        <If when={bot()}>
          {(b) => (
            <>
              <View class={`gap-4 ${narrowWindow() ? "" : "flex-1 min-w-0"}`}>
                <If when={draft()}>
                  {(d) => (
                    <ProfileBasics
                      profileDraft={d()}
                      onProfileDraftChange={(next) => draft.set(next)}
                      profileErrors={errors()}
                      profileSaving={autosave.saving}
                      profileFailed={failed()}
                      profileSavedTick={autosave.savedTick}
                      profileModelPicker={listedModels()}
                      unlistedPin={unlistedPin()}
                      claudeStatus={null}
                      claudeUnavailable={claudeUnavailable()}
                      onProfileInput={() => schedule(300)}
                      onProfilePick={() => schedule(60)}
                    />
                  )}
                </If>
                <BotActionsCard
                  bot={b()}
                  selectedKind={direct() ? "you-bot" : null}
                  archiveProfile={async () => {
                    const error = await runtime.archiveBot(b().id);
                    log.set(error ? "archive-failed" : "archived");
                  }}
                  restoreProfile={async () => {
                    const error = await runtime.restoreBot(b().id);
                    log.set(error ? "restore-failed" : "restored");
                  }}
                  onDeleteBot={() => log.set("delete-bot")}
                  onClearHistory={() => log.set("clear-history")}
                />
              </View>
              <View class={`gap-4 ${narrowWindow() ? "" : "flex-1 min-w-0"}`}>
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-[13px] font-semibold text-ink">{copy().routines.title}</Text>
                  <If when={narrowWindow()}>
                    <Button testID="routine-header-add" size="sm" icon="plus" disabled={!routineApi()?.canAdd()} onPress={() => routineApi()?.addRoutine()}>
                      {copy().routines.add}
                    </Button>
                  </If>
                </View>
                <RoutineCard bot={b()} onApi={(api) => routineApi.set(api)} />
                <MemoryCard bot={b()} openDangerConfirm={openDanger} clearDanger={clearDanger} onApi={(api) => memoryApi.set(api)} />
                <Button testID="editor-back" size="sm" onPress={() => apiLog.set(`back=${routineApi()?.backFromEditor() || memoryApi()?.backFromEditor()}`)}>
                  Back
                </Button>
              </View>
            </>
          )}
        </If>
      </View>
      <View class="flex-row flex-wrap gap-2 px-6 pb-2">
        <Button testID="tool-probe-routines" size="sm" onPress={() => void probeRoutines()}>routines?</Button>
        <Button testID="tool-probe-bot" size="sm" onPress={() => void probeBot()}>bot?</Button>
        <Button testID="tool-probe-playbook" size="sm" onPress={() => void probePlaybook()}>playbook?</Button>
        <Button testID="tool-claude-unavailable" size="sm" onPress={() => claudeUnavailable.set(!claudeUnavailable())}>claude?</Button>
        <Button testID="tool-seed-a" size="sm" onPress={() => seedRoutine("巡检", "10:00", "看一眼")}>seed a</Button>
        <Button testID="tool-seed-b" size="sm" onPress={() => seedRoutine("手机", "07:00", "")}>seed b</Button>
        <Button testID="tool-clear-routines" size="sm" onPress={() => void clearRoutines()}>clear routines</Button>
      </View>
      <Text testID="probe" class="text-[12px] text-ink-muted px-6 pb-2">{probe()}</Text>
      <Text testID="panels-b-log" class="text-[12px] text-ink-muted px-6 pb-6">{`log=${log()} ${apiLog()}`}</Text>
      <If when={danger()}>
        {(pending) => (
          <DangerDialog
            copy={{ title: copy().sidebar.memoryDelete, body: copy().sidebar.memoryDeleteBody, confirm: copy().sidebar.memoryConfirmDelete, cancel: copy().sidebar.memoryCancel }}
            onDismiss={() => danger.set(null)}
            onConfirm={() => {
              const run = pending().run;
              void run(() => danger() === pending());
              danger.set(null);
            }}
          />
        )}
      </If>
    </Scroll>
  );
}
