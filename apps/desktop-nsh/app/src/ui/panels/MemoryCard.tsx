/**
 * The memory tab (`MemoryCard.svelte`): what the Bot has kept, newest first as the runtime lists
 * it, with where each was formed. There is no way to add one by hand (the Bot writes them); you
 * switch one off, correct it or delete it. The editor is a dialog, a whole page on a phone.
 *
 * The Svelte component's exported `backFromEditor()` (the shell's Back closes the editor before it
 * leaves the section) is the `onApi` callback here: it gets `{ backFromEditor }` once, when the
 * card is built.
 */
import { Input } from "nsh/base";
import { Text, View, effect, signal, untracked } from "nsh";
import type { Bot, Memory } from "@real-bot/protocol";
import type { DangerAction } from "../../m/overlays/danger-confirm";
import {
  draftFromMemory,
  mapMemoryError,
  memoryAgeLabel,
  memoryDraftDirty,
  planMemory,
  reconcileMemoryDraft,
  resolveMemoryOrigin,
  type MemoryDraft,
  type MemoryFieldErrors,
} from "../../m/panels/memory-form";
import { copy, runtime } from "../../runtime";
import { Checkbox } from "../Checkbox";
import { Icon } from "../Icon";
import { Modal, ModalAction, narrowWindow } from "../Modal";
import { Switch } from "../Switch";
import { tip } from "../tip";
import { EditorOwnerBadge } from "./EditorOwnerBadge";
import { EditorSwitchRow } from "./EditorSwitchRow";
import { RequiredStar } from "./RequiredStar";
import { SettingsSubject } from "./SettingsSubject";
import { FIELD, FIELD_ERROR, PANEL_CARD, PANEL_CARD_BODY, PANEL_CARD_HEAD, PANEL_CARD_TITLE, PANEL_COUNTER } from "./panel-card";

/** Rows shown before the list folds. The cap is 20, so this only hides a tail. */
const VISIBLE = 5;

export type MemoryCardApi = { backFromEditor: () => boolean };

function FormCard(props: { testID?: string; children: import("nsh").JSX.Element }) {
  return (
    <View testID={props.testID} class={`flex-col gap-2 border border-line bg-pane ${narrowWindow() ? "px-4 py-[14px] rounded-(--radius-lg)" : "px-[14px] py-3 rounded-(--radius-md)"}`}>
      {props.children}
    </View>
  );
}

function CardHeader(props: { label: string; required?: boolean; children?: import("nsh").JSX.Element }) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <Text class="text-[13px] font-semibold text-ink">
        {props.label} <If when={props.required}><RequiredStar /></If>
      </Text>
      {props.children}
    </View>
  );
}

export function MemoryCard(props: {
  bot: Bot;
  openDangerConfirm: (kind: "skill" | "memory", run: DangerAction) => void;
  clearDanger: (kind: "memory") => void;
  onApi?: (api: MemoryCardApi) => void;
}) {
  const t = () => copy();
  const phone = () => narrowWindow();
  const snapshot = () => runtime.snapshot;
  const memories = () => snapshot().memories.filter((m) => m.bot_id === props.bot.id);
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const sessionsById = () => new Map(snapshot().sessions.map((s) => [s.id, s] as const));

  const expanded = signal(false);
  const shown = () => (expanded() ? memories() : memories().slice(0, VISIBLE));

  const editing = signal<string | null>(null);
  const draft = signal<MemoryDraft>({ subject: "", body: "" });
  const baseline = signal<MemoryDraft>({ subject: "", body: "" });
  const errors = signal<MemoryFieldErrors>({});
  const busy = signal(false);

  function closeEdit(): void {
    editing.set(null);
    errors.set({});
  }

  props.onApi?.({
    backFromEditor: () => {
      if (!editing() || busy()) return Boolean(editing());
      closeEdit();
      return true;
    },
  });

  // The Bot can rewrite a memory while this pane is open; a live update must not eat your edit.
  effect(() => {
    const id = editing();
    if (!id) return;
    const live = snapshot().memories.find((m) => m.id === id);
    if (!live) {
      editing.set(null);
      return;
    }
    untracked(() => {
      const next = reconcileMemoryDraft(draft(), baseline(), live);
      // Only write when the value actually moved, or the effect re-triggers on its own write.
      if (memoryDraftDirty(draft(), next.draft)) draft.set(next.draft);
      if (memoryDraftDirty(baseline(), next.baseline)) baseline.set(next.baseline);
    });
  });

  function openEdit(memory: Memory): void {
    editing.set(memory.id);
    draft.set(draftFromMemory(memory));
    baseline.set(draftFromMemory(memory));
    errors.set({});
  }

  async function save(): Promise<void> {
    const id = editing();
    if (!id || busy()) return;
    const plan = planMemory(draft(), t());
    if (!plan.ok) {
      errors.set(plan.errors);
      return;
    }
    busy.set(true);
    const failure = await runtime.patchMemory(id, plan.body);
    busy.set(false);
    if (failure) {
      errors.set(mapMemoryError(failure.status, t()));
      return;
    }
    closeEdit();
  }

  function confirmDelete(memory: Memory): void {
    props.openDangerConfirm("memory", async (isCurrent) => {
      await runtime.deleteMemory(memory.id);
      if (isCurrent()) props.clearDanger("memory");
    });
  }

  const setEnabled = (memory: Memory, enabled: boolean) => void runtime.patchMemory(memory.id, { enabled });
  const jump = (sessionId: string, messageId: string | null) => void runtime.selectSession(sessionId, messageId ? { messageId } : undefined);
  const learningText = (memory: Memory) =>
    memory.learning ? (memory.learning.later === 0 ? t().sidebar.learningNoneYet : t().sidebar.learningLater(memory.learning.later, memory.learning.shorter)) : "";

  const Dot = () => <Text class="text-[11px] text-ink-muted">·</Text>;

  return (
    <>
      <View testID="memory-card" class={phone() ? "" : PANEL_CARD}>
        <If when={!phone()}>
          <View class={PANEL_CARD_HEAD}>
            <View class="flex-row items-center gap-2">
              <Text class={PANEL_CARD_TITLE}>{t().sidebar.memories}</Text>
              <View class={PANEL_COUNTER}>
                <Text testID="memory-count" class="text-[11px] font-bold text-ink-secondary">{String(memories().length)}</Text>
              </View>
            </View>
          </View>
        </If>
        <View class={`flex-col ${phone() ? "gap-[10px]" : `gap-3 ${PANEL_CARD_BODY}`}`}>
          <If
            when={memories().length > 0}
            else={
              <View testID="memory-empty" class={phone() ? "items-center justify-center gap-3 py-9 px-4 rounded-(--radius-lg) bg-pane border border-dashed border-line" : ""}>
                <If when={phone()}>
                  <View class="w-[56px] h-[56px] rounded-full bg-sidebar-bg items-center justify-center">
                    <Icon name="book" size={32} class="tint-ink-muted" />
                  </View>
                </If>
                <Text class={`text-ink-muted ${phone() ? "text-[14px] text-center" : "text-[12px] leading-[1.5]"}`}>{t().sidebar.memoriesEmpty}</Text>
              </View>
            }
          >
            <If when={!phone()}>
              <Text class="text-[12px] leading-[1.5] text-ink-muted">{t().sidebar.memoryHint}</Text>
            </If>
            <Each of={shown()} key={(memory) => memory.id}>
              {(memory) => {
                const origin = () => resolveMemoryOrigin(memory(), sessionsById(), botsById(), t());
                const sessionOrigin = () => {
                  const o = origin();
                  return o.kind === "session" ? o : null;
                };
                return (
                  <View
                    testID={`memory-row-${memory().id}`}
                    class={`flex-col gap-1 border bg-pane ${phone() ? "px-[14px] py-3 rounded-(--radius-lg)" : "px-[10px] py-2 rounded-(--radius-md)"} ${editing() === memory().id ? "border-brand" : "border-line"} ${memory().enabled ? "" : "opacity-[0.65]"}`}
                  >
                    <View class="flex-row items-center justify-between gap-2">
                      <View
                        role="button"
                        testID={`memory-open-${memory().id}`}
                        accessibilityLabel={`${t().sidebar.memoryEdit}: ${memory().subject}`}
                        tooltip={tip(t().sidebar.memoryEdit)}
                        onPress={() => openEdit(memory())}
                        class="group flex-row items-center gap-[6px] min-w-0 shrink"
                      >
                        <Text class={`font-semibold text-ink group-hover:text-brand line-clamp-1 ${phone() ? "text-[15px]" : "text-[13px]"}`}>{memory().subject}</Text>
                        <If when={!memory().enabled}>
                          <View class="px-[6px] py-[1px] rounded-full bg-sidebar-bg border border-line shrink-0">
                            <Text class="text-[11px] font-medium text-ink-muted">已停用</Text>
                          </View>
                        </If>
                      </View>
                      <If
                        when={!phone()}
                        else={
                          <Switch
                            testID={`memory-enabled-${memory().id}`}
                            label={`${t().sidebar.memoryEnabled}: ${memory().subject}`}
                            checked={memory().enabled}
                            onChange={(checked) => setEnabled(memory(), checked)}
                          />
                        }
                      >
                        <View class="flex-row items-center gap-1 shrink-0">
                          <Checkbox
                            testID={`memory-enabled-${memory().id}`}
                            class="pr-1"
                            checked={memory().enabled}
                            accessibilityLabel={`${t().sidebar.memoryEnabled}: ${memory().subject}`}
                            onChange={(checked) => setEnabled(memory(), checked)}
                          />
                          <View
                            role="button"
                            testID={`memory-edit-${memory().id}`}
                            accessibilityLabel={t().sidebar.memoryEdit}
                            tooltip={tip(t().sidebar.memoryEdit)}
                            onPress={() => openEdit(memory())}
                            class="group w-[24px] h-[24px] items-center justify-center rounded-(--radius-sm) hover:bg-line-subtle"
                          >
                            <Icon name="edit" size={16} class="tint-ink-muted group-hover:tint-ink" />
                          </View>
                          <View
                            role="button"
                            testID={`memory-delete-${memory().id}`}
                            accessibilityLabel={t().sidebar.memoryDelete}
                            tooltip={tip(t().sidebar.memoryDelete)}
                            onPress={() => confirmDelete(memory())}
                            class="group w-[24px] h-[24px] items-center justify-center rounded-(--radius-sm) hover:bg-line-subtle"
                          >
                            <Icon name="trash" size={16} class="tint-ink-muted group-hover:tint-danger" />
                          </View>
                        </View>
                      </If>
                    </View>
                    <View role={phone() ? "button" : undefined} accessibilityLabel={phone() ? t().sidebar.memoryEdit : undefined} onPress={phone() ? () => openEdit(memory()) : undefined}>
                      <Text class={`text-ink-secondary ${phone() ? "text-[14px] leading-[1.5]" : "text-[13px] leading-[1.5]"}`}>{memory().body}</Text>
                    </View>
                    <View class="flex-row flex-wrap items-center gap-1">
                      <Text testID={`memory-age-${memory().id}`} class={`text-ink-muted ${phone() ? "text-[12px]" : "text-[11px]"}`}>{memoryAgeLabel(memory().updated_at, t())}</Text>
                      <Dot />
                      <If
                        when={sessionOrigin()}
                        else={<Text testID={`memory-origin-missing-${memory().id}`} class="text-[11px] text-ink-muted opacity-[0.8]">{t().sidebar.memoryOriginMissing}</Text>}
                      >
                        {(o) => (
                          <View
                            role="button"
                            testID={`memory-origin-${memory().id}`}
                            tooltip={tip(t().sidebar.memoryJump)}
                            onPress={() => jump(o().session.id, o().messageId)}
                            class="group flex-row items-center gap-[3px] min-w-0 shrink"
                          >
                            <Icon name="message" size={12} class="tint-ink-muted group-hover:tint-brand" />
                            <Text class="text-[11px] text-ink-muted group-hover:text-brand line-clamp-1">{t().sidebar.memoryFormedIn(o().label)}</Text>
                          </View>
                        )}
                      </If>
                      <If when={memory().retrospective}>
                        {(r) => (
                          <>
                            <Dot />
                            <Text class="text-[11px] text-ink-muted">{t().sidebar.memoryFromRetrospective(r().plan_title)}</Text>
                          </>
                        )}
                      </If>
                      <If when={memory().learning}>
                        <Dot />
                        <Text testID={`memory-learning-${memory().id}`} class="text-[11px] text-ink-muted">{learningText(memory())}</Text>
                      </If>
                    </View>
                  </View>
                );
              }}
            </Each>
            <If when={memories().length > VISIBLE}>
              <View role="button" testID="memory-more" onPress={() => expanded.set(!expanded())} class="group self-start py-[2px]">
                <Text class="text-[12px] font-semibold text-ink-muted group-hover:text-brand">
                  {expanded() ? t().sidebar.memoryCollapse : t().sidebar.memoryShowAll(memories().length)}
                </Text>
              </View>
            </If>
          </If>
        </View>
      </View>

      <If when={editing()}>
        {(id) => (
          <Modal
            testID="memory-editor"
            title={t().sidebar.memoryEdit}
            closeLabel={t().common.close}
            backLabel={t().common.back}
            busy={busy()}
            pageOnPhone
            width={480}
            maxHeight={0.88}
            subject={<SettingsSubject variant="line" bot={props.bot} />}
            onClose={closeEdit}
            bodyClass={phone() ? "px-3 pt-4 pb-6 gap-[14px]" : "px-5 py-4 gap-3"}
            foot={
              <If
                when={!phone()}
                else={
                  <ModalAction
                    kind="primary"
                    testID="memory-save"
                    disabled={!memoryDraftDirty(draft(), baseline())}
                    busy={busy()}
                    onPress={() => void save()}
                  >
                    {busy() ? t().routines.busy : t().sidebar.memorySave}
                  </ModalAction>
                }
              >
                <ModalAction kind="primary" testID="memory-save" disabled={busy() || !memoryDraftDirty(draft(), baseline())} onPress={() => void save()}>
                  {t().sidebar.memorySave}
                </ModalAction>
                <ModalAction testID="memory-cancel" disabled={busy()} onPress={closeEdit}>{t().sidebar.memoryCancel}</ModalAction>
              </If>
            }
          >
            <FormCard>
              <CardHeader label={t().sidebar.memorySubject} required>
                <EditorOwnerBadge name={props.bot.name} title={`${t().routines.owner}: ${props.bot.name}`} />
              </CardHeader>
              <Input
                testID="memory-subject"
                accessibilityLabel={t().sidebar.memorySubject}
                value={draft().subject}
                readonly={busy()}
                autoCorrect={false}
                placeholder="例如：用户的回复偏好、核心业务口径"
                onChange={(e) => draft.set({ ...draft(), subject: e.value })}
                class={`${FIELD} ${errors().subject ? "border-warn-line" : ""}`}
              />
              <If when={errors().subject}>
                {(message) => <Text role="alert" testID="memory-subject-error" class={FIELD_ERROR}>{message()}</Text>}
              </If>
            </FormCard>

            <FormCard>
              <CardHeader label={t().sidebar.memoryBody} required>
                <Text class="text-[12px] text-ink-muted">长期有效的事实或偏好</Text>
              </CardHeader>
              <Input
                testID="memory-body"
                accessibilityLabel={t().sidebar.memoryBody}
                multiline
                value={draft().body}
                readonly={busy()}
                placeholder="输入具体的记忆结论..."
                onChange={(e) => draft.set({ ...draft(), body: e.value })}
                class={`${FIELD} min-h-[100px] ${errors().body ? "border-warn-line" : ""}`}
              />
              <If when={errors().body}>
                {(message) => <Text role="alert" testID="memory-body-error" class={FIELD_ERROR}>{message()}</Text>}
              </If>
            </FormCard>

            <If when={snapshot().memories.find((m) => m.id === id())}>
              {(live) => {
                const origin = () => {
                  const o = resolveMemoryOrigin(live(), sessionsById(), botsById(), t());
                  return o.kind === "session" ? o : null;
                };
                return (
                  <>
                    <FormCard testID="memory-origin-card">
                      <CardHeader label="形成来源与更新">
                        <Text class="text-[12px] text-ink-muted">{memoryAgeLabel(live().updated_at, t())}</Text>
                      </CardHeader>
                      <View class="flex-col gap-[6px]">
                        <If
                          when={origin()}
                          else={
                            <Text testID="memory-editor-origin-missing" class="text-[12px] text-ink-muted">{t().sidebar.memoryOriginMissing}</Text>
                          }
                        >
                          {(o) => (
                            <View
                              role="button"
                              testID="memory-editor-origin"
                              tooltip={tip(t().sidebar.memoryJump)}
                              onPress={() => {
                                closeEdit();
                                jump(o().session.id, o().messageId);
                              }}
                              class="group flex-row items-center gap-[6px] px-[10px] py-2 rounded-(--radius-sm) border border-line bg-sidebar-bg hover:border-brand"
                            >
                              <Icon name="message" size={16} class="tint-ink-secondary group-hover:tint-brand" />
                              <Text class="flex-1 min-w-0 text-[13px] text-ink-secondary group-hover:text-brand">{t().sidebar.memoryFormedIn(o().label)}</Text>
                              <Icon name="chevron-right" size={12} class="tint-ink-muted" />
                            </View>
                          )}
                        </If>
                        <If when={live().learning}>
                          <View class="flex-row items-center gap-[5px]">
                            <Icon name="clock" size={12} class="tint-ink-muted" />
                            <Text class="text-[12px] text-ink-muted">{learningText(live())}</Text>
                          </View>
                        </If>
                      </View>
                    </FormCard>

                    <FormCard>
                      <EditorSwitchRow
                        testID="memory-enabled-row"
                        title={t().sidebar.memoryEnabled}
                        desc={live().enabled ? "已启用，Bot 每轮对话都将参考此事实" : "已停用，Bot 将暂时不读取此记忆"}
                      >
                        <Switch
                          testID="memory-editor-enabled"
                          label={t().sidebar.memoryEnabled}
                          disabled={busy()}
                          checked={live().enabled}
                          onChange={(checked) => setEnabled(live(), checked)}
                        />
                      </EditorSwitchRow>
                    </FormCard>

                    <View
                      role="button"
                      testID="memory-page-delete"
                      accessibilityLabel={t().sidebar.memoryDelete}
                      disabled={busy()}
                      onPress={() => {
                        const memory = live();
                        closeEdit();
                        confirmDelete(memory);
                      }}
                      class="flex-row items-center justify-center gap-2 w-full min-h-[44px] rounded-(--radius-md) border border-danger-line bg-danger-bg disabled:opacity-[0.45]"
                    >
                      <Icon name="trash" class="tint-danger-text" />
                      <Text class="text-[14px] font-semibold text-danger-text">{t().sidebar.memoryDelete}</Text>
                    </View>
                  </>
                );
              }}
            </If>
          </Modal>
        )}
      </If>
    </>
  );
}
