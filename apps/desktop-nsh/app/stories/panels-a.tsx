/**
 * The conversation settings' parts on one screen: the head (a group's identity, a Bot), the Bot's
 * tabs, the skills list and its editor, the shared skills and the mute row. The Bot and the group
 * are the runtime's own (Writer, 周报小组); the skills are sample data held here.
 */
import { Scroll, Text, View, computed, effect, signal, untracked } from "nsh";
import type { Bot, SessionSummary, SharedSkill, Skill } from "@real-bot/protocol";
import { emptySkillDraft, planSkill, type SkillDraft, type SkillFieldErrors } from "../src/m/panels/create-form";
import type { GroupDetailDraft } from "../src/m/panels/group-edit";
import { narrowWindow } from "../src/ui/Modal";
import { runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { BotTabNav, type BotTab } from "../src/ui/panels/BotTabNav";
import { EditorOwnerBadge } from "../src/ui/panels/EditorOwnerBadge";
import { EditorSwitchRow } from "../src/ui/panels/EditorSwitchRow";
import { RequiredStar } from "../src/ui/panels/RequiredStar";
import { SessionMuteRow } from "../src/ui/panels/SessionMuteRow";
import { SettingsHead } from "../src/ui/panels/SettingsHead";
import { SettingsSubject } from "../src/ui/panels/SettingsSubject";
import { SharedSkillsCard } from "../src/ui/panels/SharedSkillsCard";
import { SkillEditor } from "../src/ui/panels/SkillEditor";
import { SkillsCard } from "../src/ui/panels/SkillsCard";
import { Switch } from "../src/ui/Switch";

const skill = (id: string, name: string, enabled: boolean, extra: Partial<Skill> = {}): Skill =>
  ({
    id,
    name,
    description: `${name} 的适用场景`,
    body: `# ${name}\n\n步骤一。`,
    uses: [],
    enabled,
    updated_at: "2026-11-01T00:00:00.000Z",
    ...extra,
  }) as unknown as Skill;

/** What the sharing API would hold: Writer's `summarize` shared and out of date, Editor's `proofread` shared with Writer. */
function fakeSharedApi(skills: () => readonly Skill[]) {
  const rows = signal<SharedSkill[]>([
    {
      id: "sh-1", name: "summarize", description: "", body: "old", uses: [], source_skill_id: "sk-1", source_bot_id: "bot-writer", source_bot_name: "Writer",
      enabled: true, source_changed: true, confirmed_at: "", created_at: "", updated_at: "",
    },
    {
      id: "sh-2", name: "proofread", description: "校对", body: "x", uses: [], source_skill_id: "ed-1", source_bot_id: "bot-editor", source_bot_name: "Editor",
      enabled: true, source_changed: false, confirmed_at: "", created_at: "", updated_at: "",
    },
  ]);
  return {
    listSharedSkills: async () => ({ items: rows(), available: true }),
    shareSkill: async (skillId: string) => {
      const own = skills().find((s) => s.id === skillId)!;
      const row = { id: `sh-${skillId}`, name: own.name, description: own.description, body: own.body, uses: [], source_skill_id: skillId, source_bot_id: "bot-writer", source_bot_name: "Writer", enabled: true, source_changed: false, confirmed_at: "", created_at: "", updated_at: "" } as SharedSkill;
      rows.set([...rows().filter((r) => r.source_skill_id !== skillId), row]);
      return row;
    },
    setSharedSkillEnabled: async (id: string, enabled: boolean) => {
      rows.set(rows().map((r) => (r.id === id ? { ...r, enabled } : r)));
      return rows().find((r) => r.id === id)!;
    },
    unshareSkill: async (id: string) => rows.set(rows().filter((r) => r.id !== id)),
  };
}

export default function PanelsA() {
  const bot = computed<Bot | null>(() => runtime.snapshot.bots.find((b) => b.name === "Writer") ?? null);
  const group = computed<SessionSummary | null>(() => runtime.snapshot.sessions.find((s) => s.kind === "group") ?? null);
  const botsById = computed(() => new Map(runtime.snapshot.bots.map((b) => [b.id, b] as const)));

  const tab = signal<BotTab>("skills");
  const skills = signal<Skill[]>([
    skill("sk-1", "summarize", true, { uses: ["notion"] }),
    skill("sk-2", "translate", false),
    skill("sk-3", "outline", true, { learning: { later: 2, shorter: 1 } as Skill["learning"] }),
  ]);
  const editor = signal<"add" | string | null>(null);
  const draft = signal<SkillDraft>(emptySkillDraft());
  const errors = signal<SkillFieldErrors>({});
  const failed = signal(false);
  const log = signal("—");
  const detail = signal<GroupDetailDraft>({ sessionId: null, name: "", nameError: undefined, failed: false, pullPick: "" });
  const nestedBack = signal(0);
  const closed = signal(0);

  // The shell's draft follows the group it shows.
  effect(() => {
    const g = group();
    if (g && untracked(() => detail().sessionId) !== g.id) detail.set({ sessionId: g.id, name: g.name ?? "", nameError: undefined, failed: false, pullPick: "" });
  });

  const open = (id: "add" | string) => {
    const own = skills().find((s) => s.id === id);
    draft.set(own ? { name: own.name, description: own.description, body: own.body, uses: (own.uses ?? []).join(", "), enabled: own.enabled } : emptySkillDraft());
    errors.set({});
    failed.set(false);
    editor.set(id);
  };
  const save = async () => {
    const plan = planSkill(draft());
    if (!plan.ok) return errors.set(plan.errors);
    const taken = skills().some((s) => s.id !== editor() && s.name === plan.body.name);
    if (taken) return errors.set({ name: "conflict" });
    errors.set({});
    const id = editor() === "add" ? `sk-${skills().length + 1}` : editor()!;
    const next = skill(id, plan.body.name, plan.body.enabled, { description: plan.body.description, body: plan.body.body, uses: plan.body.uses });
    skills.set(editor() === "add" ? [...skills(), next] : skills().map((s) => (s.id === id ? next : s)));
    log.set(`saved:${plan.body.name}`);
    editor.set(null);
  };
  const writerSkills = () => skills();
  const sharing = fakeSharedApi(writerSkills);

  return (
    <Scroll class="flex-1 bg-bg">
      <View class={`gap-6 p-6 ${narrowWindow() ? "flex-col" : "flex-row"}`}>
        <View class={`gap-4 ${narrowWindow() ? "" : "w-[440px]"}`}>
          <If when={group()}>
            {(g) => (
              <View class="p-4 rounded-(--radius-md) bg-pane border border-line gap-4">
                <SettingsHead
                  group
                  nested={false}
                  narrow={false}
                  groupSession={g()}
                  botsById={botsById()}
                  detail={detail()}
                  onDetailChange={(d) => detail.set(d)}
                  onBack={() => nestedBack.set(nestedBack() + 1)}
                  onClose={() => closed.set(closed() + 1)}
                />
                <SessionMuteRow sessionId={g().id} />
                <Text testID="group-muted" class="text-[12px] text-ink-muted">{`muted=${runtime.isSessionMuted(g().id)}`}</Text>
                <Text testID="group-saved" class="text-[12px] text-ink-muted">{`saved=${g().name ?? ""}`}</Text>
                <Button testID="restore-name" onPress={() => void runtime.patchSession(g().id, { name: "周报小组" })}>还原名称</Button>
                <Button testID="blank-name" onPress={() => detail.set({ ...detail(), name: "" })}>清空名称</Button>
              </View>
            )}
          </If>
          <If when={bot()}>
            {(b) => (
              <View class="p-4 rounded-(--radius-md) bg-pane border border-line gap-4">
                <SettingsHead
                  group={false}
                  nested
                  narrow
                  subjectBot={b()}
                  botsById={botsById()}
                  detail={detail()}
                  onDetailChange={(d) => detail.set(d)}
                  onBack={() => nestedBack.set(nestedBack() + 1)}
                  onClose={() => closed.set(closed() + 1)}
                />
                <SettingsSubject variant="line" bot={b()} />
                <BotTabNav
                  activeTab={tab()}
                  basicsHasError={tab() === "memory"}
                  profileSkills={skills()}
                  routineCount={0}
                  profileMemories={[]}
                  switchTab={(t) => tab.set(t)}
                />
              </View>
            )}
          </If>
          <Text testID="panels-log" class="text-[12px] text-ink-muted">{`back=${nestedBack()} close=${closed()} tab=${tab()} log=${log()}`}</Text>
          <View class="p-4 rounded-(--radius-md) bg-pane border border-line gap-3">
            <Text class="text-[13px] font-semibold text-ink">标题 <RequiredStar /></Text>
            <EditorOwnerBadge name="Writer" title="所属 Bot: Writer" />
            <EditorSwitchRow title="已启用" desc="说明文字"><Switch checked={true} onChange={() => {}} /></EditorSwitchRow>
          </View>
        </View>
        <View class="flex-1 min-w-0 gap-4">
          <If when={bot()}>
            {(b) => (
              <>
                <SkillsCard
                  profileSkills={skills()}
                  skillEditor={editor()}
                  skillFailed={failed()}
                  openAddSkill={() => open("add")}
                  openEditSkill={(id) => open(id)}
                  toggleSkillEnabled={async (id, enabled) => skills.set(skills().map((s) => (s.id === id ? { ...s, enabled } : s)))}
                  openDeleteSkillConfirm={(id) => {
                    skills.set(skills().filter((s) => s.id !== id));
                    editor.set(null);
                    log.set(`deleted:${id}`);
                  }}
                />
                <SharedSkillsCard api={sharing} botId="bot-writer" skills={skills()} />
                <SkillEditor
                  bot={b()}
                  skillEditor={editor()}
                  skillDraft={draft()}
                  onDraftChange={(d) => draft.set(d)}
                  skillErrors={errors()}
                  skillFailed={failed()}
                  skillBusy={false}
                  closeSkillEditor={() => editor.set(null)}
                  saveSkill={save}
                  openDeleteSkillConfirm={(id) => {
                    skills.set(skills().filter((s) => s.id !== id));
                    editor.set(null);
                    log.set(`deleted:${id}`);
                  }}
                />
              </>
            )}
          </If>
        </View>
      </View>
    </Scroll>
  );
}
