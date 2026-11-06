/**
 * The routines tab (`RoutineCard.svelte`): the Bot's scheduled turns. A row shows the clock, the
 * title and the repeat, with a switch to pause and (on a desktop) a delete. An edit opens under its
 * own row; a new routine takes the add row's place; on a phone the editor is a page of its own.
 *
 * The Svelte component's exported `backFromEditor()`, `addRoutine()` and `canAdd()` are the
 * `onApi` callback here: it gets them once, when the card is built.
 *
 * NSH has no `<input type="time">`: the clock is a text field read as `HH:MM`, which `planRoutine`
 * already checks ("24:01" is refused with `routines.timeInvalid`).
 */
import { Input } from "nsh/base";
import { Text, View, cleanup, effect, signal, untracked, type JSX } from "nsh";
import type { Bot, Routine } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api";
import { WEEKDAYS, planRoutine, routineDirty, routineDraft, routineError, routineRepeatLabel, type RoutineDraft } from "../../m/panels/routine-form";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon } from "../Icon";
import { Modal, ModalAction, narrowWindow } from "../Modal";
import { Switch } from "../Switch";
import { tip } from "../tip";
import { DangerDialog } from "../overlays/DangerDialog";
import { EditorOwnerBadge } from "./EditorOwnerBadge";
import { EditorSwitchRow } from "./EditorSwitchRow";
import { SettingsSubject } from "./SettingsSubject";
import { FIELD, FIELD_ERROR } from "./panel-card";

export type RoutineCardApi = { backFromEditor: () => boolean; addRoutine: () => void; canAdd: () => boolean };

type Errors = ReturnType<typeof planRoutine>["errors"];

function FormCard(props: { testID?: string; children: JSX.Element }) {
  return (
    <View testID={props.testID} class={`flex-col gap-[10px] border border-line bg-pane ${narrowWindow() ? "px-4 py-[14px] rounded-(--radius-lg)" : "px-[14px] py-3 rounded-(--radius-md)"}`}>
      {props.children}
    </View>
  );
}

function CardHeader(props: { children: JSX.Element }) {
  return <View class="flex-row items-center justify-between gap-2">{props.children}</View>;
}

const CardTitle = (props: { children: string }) => <Text class="text-[13px] font-bold text-ink">{props.children}</Text>;

function Chip(props: { testID: string; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class="group min-h-[26px] px-2 py-[2px] justify-center rounded-(--radius-sm) border border-line bg-sidebar-bg hover:border-brand disabled:opacity-[0.55]"
    >
      <Text class="text-[12px] font-medium text-ink-muted group-hover:text-brand">{props.label}</Text>
    </View>
  );
}

/** A warning line with its action (`.panel-alert.is-warn`). */
function WarnAlert(props: { testID: string; role?: "alert" | "text"; children: JSX.Element }) {
  return (
    <View role={props.role ?? "alert"} testID={props.testID} class="flex-row flex-wrap items-center gap-2 px-[14px] py-[10px] rounded-(--radius-md) bg-warn-bg border border-warn-line">
      {props.children}
    </View>
  );
}

export function RoutineCard(props: { bot: Bot; onApi?: (api: RoutineCardApi) => void }) {
  const t = () => copy();
  const phone = () => narrowWindow();
  const routines = () => runtime.snapshot.routines.filter((row) => row.bot_id === props.bot.id);

  const editing = signal<string | null>(null);
  const baseline = signal<Routine | null>(null);
  const draft = signal<RoutineDraft>(routineDraft());
  const errors = signal<Errors>({});
  const failure = signal("");
  const busy = signal(false);
  const deleting = signal<Routine | null>(null);
  const pending = signal<{ id: string; api: MessengerApi } | null>(null);
  const notice = signal("");
  const retiredDraft = signal(false);
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });

  const retryable = () => {
    const request = pending();
    return !!request && request.api === runtime.client && runtime.pendingMutation?.id === request.id;
  };
  const live = () => routines().find((row) => row.id === editing());
  const conflict = () => !!baseline() && !!live() && baseline()!.updated_at !== live()!.updated_at;
  const missing = () => !!baseline() && !live();
  /** A new routine, or one deleted while open, has no row to hang its editor under. */
  const standalone = () => editing() === "add" || (!!editing() && missing());
  const disabled = () => busy() || runtime.connection !== "connected";
  const cannotSave = () => disabled() || conflict() || missing() || retiredDraft();
  const set = (change: Partial<RoutineDraft>) => draft.set({ ...draft(), ...change });

  function close(): void {
    editing.set(null);
    retiredDraft.set(false);
    notice.set("");
    baseline.set(null);
    errors.set({});
    failure.set("");
  }

  function open(row?: Routine): void {
    if (disabled()) return;
    editing.set(row?.id ?? "add");
    retiredDraft.set(false);
    notice.set("");
    baseline.set(row ?? null);
    draft.set(routineDraft(row));
    errors.set({});
    failure.set("");
  }

  props.onApi?.({
    backFromEditor: () => {
      if (!editing() || busy()) return Boolean(editing());
      close();
      return true;
    },
    addRoutine: () => open(),
    canAdd: () => !disabled(),
  });

  // A search or a link points at one routine: open it, or say it is gone.
  effect(() => {
    const id = runtime.profileRoutineId;
    if (!id) return;
    untracked(() => {
      const row = routines().find((item) => item.id === id);
      if (row) open(row);
      else failure.set(t().routines.missing);
      runtime.profileRoutineId = null;
    });
  });
  effect(() => {
    const request = pending();
    if (!busy() && request && request.api === runtime.client && runtime.pendingMutation?.id !== request.id && !request.api.hasPendingRequest(request.id)) {
      pending.set(null);
      notice.set(t().routines.retired);
      retiredDraft.set(!!untracked(editing));
      if (failure() === t().routines.unknown || failure() === t().routines.pending) failure.set("");
    }
  });
  // A clean editor follows a live update of its row.
  effect(() => {
    const base = baseline();
    const row = live();
    if (!busy() && !retiredDraft() && base && row && base.updated_at !== row.updated_at && !untracked(() => routineDirty(draft(), base))) {
      draft.set(routineDraft(row));
      baseline.set(row);
    }
  });

  async function mutate(run: () => ReturnType<typeof runtime.createRoutine>, done: () => void): Promise<void> {
    if (disabled()) return;
    const api = runtime.client;
    busy.set(true);
    failure.set("");
    try {
      const error = await run();
      if (!mounted || runtime.client !== api) return;
      if (error) {
        failure.set(routineError(error, t()));
        if (api && error.requestId && ["request_unknown", "request_pending"].includes(error.code)) pending.set({ id: error.requestId, api });
      } else {
        const request = pending();
        if (request?.api === api && !api?.hasPendingRequest(request.id)) pending.set(null);
        done();
      }
    } catch {
      if (mounted && runtime.client === api) failure.set(t().routines.failed);
    } finally {
      if (mounted && runtime.client === api) busy.set(false);
    }
  }

  async function retry(): Promise<void> {
    const request = pending();
    if (disabled() || !request || !retryable()) return;
    busy.set(true);
    try {
      const error = await runtime.retryPendingMutation();
      if (!mounted || runtime.client !== request.api) return;
      failure.set(error ? routineError(error, t()) : "");
      if (!request.api.hasPendingRequest(request.id)) {
        pending.set(null);
        notice.set(t().routines.retired);
        retiredDraft.set(!!editing());
      }
    } finally {
      if (mounted && runtime.client === request.api) busy.set(false);
    }
  }

  async function save(): Promise<void> {
    if (!editing() || cannotSave()) return;
    const plan = planRoutine(draft(), t());
    errors.set(plan.errors);
    if (Object.keys(plan.errors).length) return;
    const row = baseline();
    await mutate(
      () => (row ? runtime.patchRoutine(row.id, { ...plan.body, if_revision: row.updated_at }) : runtime.createRoutine({ bot_id: props.bot.id, ...plan.body })),
      close,
    );
  }

  async function remove(): Promise<void> {
    const row = deleting();
    if (!row) return;
    await mutate(
      () => runtime.deleteRoutine(row.id, row.updated_at),
      () => {
        if (editing() === row.id) close();
      },
    );
    if (mounted && !busy()) deleting.set(null);
  }

  function toggleDay(day: string): void {
    if (disabled()) return;
    set({ weekdays: draft().weekdays.includes(day) ? draft().weekdays.filter((item) => item !== day) : [...draft().weekdays, day] });
  }

  function selectPresetDays(preset: "workdays" | "weekend" | "all"): void {
    if (disabled()) return;
    set({ weekdays: preset === "workdays" ? ["mon", "tue", "wed", "thu", "fri"] : preset === "weekend" ? ["sat", "sun"] : [...WEEKDAYS] });
  }

  const AddButton = (p: { testID: string }) => (
    <View
      role="button"
      testID={p.testID}
      accessibilityLabel={t().routines.add}
      disabled={disabled()}
      onPress={() => open()}
      class="group flex-row items-center justify-center gap-[6px] w-full min-h-[44px] px-[14px] rounded-(--radius-lg) border border-dashed border-line hover:border-brand hover:bg-accent-tint disabled:opacity-[0.55]"
    >
      <Icon name="plus" size={12} class="tint-ink-muted group-hover:tint-brand" />
      <Text class="text-[13px] font-semibold text-ink-muted group-hover:text-brand">{t().routines.add}</Text>
    </View>
  );

  /** The editor's fields, shared by the inline editor and the phone's page; the page also carries the notes and the delete. */
  const editorFields = (page: boolean): JSX.Element => (
    <>
      <If when={missing()}>
        <Text role="alert" testID="routine-missing" class={FIELD_ERROR}>{t().routines.missing}</Text>
      </If>
      <If when={conflict()}>
        <WarnAlert testID="routine-conflict">
          <Text class="flex-1 text-[13px] font-medium text-warn-text">{t().routines.conflict}</Text>
          <Button testID="routine-reload" size="sm" disabled={disabled()} onPress={() => open(live())}>{t().routines.reload}</Button>
        </WarnAlert>
      </If>
      <If when={failure()}>
        <Text role="alert" testID="routine-failure" class={FIELD_ERROR}>{failure()}</Text>
      </If>
      <If when={retryable()}>
        <WarnAlert testID="routine-retry-alert" role="text">
          <Text class="flex-1 text-[12px] leading-[1.6] text-ink-muted">{t().routines.retryHint}</Text>
          <Button testID="routine-retry-in" size="sm" disabled={disabled()} onPress={() => void retry()}>{t().routines.retry}</Button>
        </WarnAlert>
      </If>
      <If when={notice()}>
        <Text role="text" testID="routine-notice" class="text-[12px] leading-[1.6] text-ink-muted">{notice()}</Text>
      </If>

      <FormCard>
        <CardHeader>
          <CardTitle>{t().routines.name}</CardTitle>
          <EditorOwnerBadge name={props.bot.name} title={`${t().routines.owner}: ${props.bot.name}`} />
        </CardHeader>
        <Input
          testID="routine-title"
          accessibilityLabel={t().routines.name}
          autoFocus={!page}
          value={draft().title}
          readonly={disabled()}
          placeholder="例如：每日早间资讯汇总、周度代码巡检"
          onChange={(e) => set({ title: e.value })}
          onSubmit={() => void save()}
          class={`${FIELD} ${errors().title ? "border-warn-line" : ""}`}
        />
        <If when={errors().title}>
          {(message) => <Text role="alert" testID="routine-title-error" class={FIELD_ERROR}>{message()}</Text>}
        </If>
      </FormCard>

      <FormCard>
        <CardHeader>
          <CardTitle>{t().routines.frequency}</CardTitle>
        </CardHeader>
        <View role="radiogroup" accessibilityLabel={t().routines.frequency} class="flex-row gap-[2px] p-[3px] rounded-(--radius-md) bg-sidebar-bg border border-line">
          {(["daily", "weekly"] as const).map((kind) => (
            <View
              role="radio"
              testID={`routine-freq-${kind}`}
              accessibilityLabel={kind === "daily" ? t().routines.daily : t().routines.weekly}
              accessibilityState={{ checked: draft().kind === kind, disabled: disabled() }}
              disabled={disabled()}
              onPress={() => set({ kind })}
              class={`flex-1 flex-row items-center justify-center gap-[6px] min-h-[40px] rounded-(--radius-md) ${draft().kind === kind ? "bg-brand" : ""}`}
            >
              <Icon name={kind === "daily" ? "clock" : "calendar"} class={draft().kind === kind ? "tint-on-accent" : "tint-ink-muted"} />
              <Text class={`text-[14px] font-semibold ${draft().kind === kind ? "text-on-accent" : "text-ink-muted"}`}>
                {kind === "daily" ? t().routines.daily : t().routines.weekly}
              </Text>
            </View>
          ))}
        </View>

        <If when={draft().kind === "weekly"}>
          <View testID="routine-weekdays" class="flex-col gap-2 pt-[10px] border-t border-line-subtle">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-[12px] font-semibold text-ink-secondary">{t().routines.weekdays}</Text>
              <View class="flex-row items-center gap-1">
                <Chip testID="routine-preset-workdays" label={t().routines.workdays} disabled={disabled()} onPress={() => selectPresetDays("workdays")} />
                <Chip testID="routine-preset-weekend" label={t().routines.weekend} disabled={disabled()} onPress={() => selectPresetDays("weekend")} />
                <Chip testID="routine-preset-all" label={t().routines.allDays} disabled={disabled()} onPress={() => selectPresetDays("all")} />
              </View>
            </View>
            <View class="flex-row gap-[6px]">
              {WEEKDAYS.map((day) => (
                <View
                  role="checkbox"
                  testID={`routine-day-${day}`}
                  accessibilityLabel={t().routines.days[day]}
                  accessibilityState={{ checked: draft().weekdays.includes(day), disabled: disabled() }}
                  disabled={disabled()}
                  onPress={() => toggleDay(day)}
                  class={`flex-1 min-w-0 min-h-[44px] items-center justify-center rounded-full border ${draft().weekdays.includes(day) ? "bg-brand border-brand" : "bg-pane border-line"}`}
                >
                  <Text class={`text-[14px] font-bold ${draft().weekdays.includes(day) ? "text-on-accent" : "text-ink"}`}>{t().routines.daysShort[day]}</Text>
                </View>
              ))}
            </View>
            <If when={errors().weekdays}>
              {(message) => <Text role="alert" testID="routine-weekdays-error" class={FIELD_ERROR}>{message()}</Text>}
            </If>
          </View>
        </If>

        <View class="pt-[10px] border-t border-line-subtle gap-[6px]">
          <View class="flex-row items-center justify-between gap-3">
            <View class="gap-[2px]">
              <View class="flex-row items-center gap-[6px]">
                <Icon name="clock" class="tint-ink-secondary" />
                <CardTitle>{t().routines.time}</CardTitle>
              </View>
              <Text class="text-[11px] text-ink-muted">{t().routines.zone}</Text>
            </View>
            <Input
              testID="routine-time"
              accessibilityLabel={t().routines.time}
              value={draft().time}
              readonly={disabled()}
              placeholder="09:00"
              maxLength={5}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              onChange={(e) => set({ time: e.value })}
              onSubmit={() => void save()}
              class={`${FIELD} w-[120px] text-[16px] font-bold ${errors().time ? "border-warn-line" : ""}`}
            />
          </View>
          <If when={errors().time}>
            {(message) => <Text role="alert" testID="routine-time-error" class={FIELD_ERROR}>{message()}</Text>}
          </If>
        </View>
      </FormCard>

      <FormCard>
        <CardHeader>
          <CardTitle>{t().routines.instruction}</CardTitle>
          <Text class="text-[12px] text-ink-muted">触发时自动发送</Text>
        </CardHeader>
        <Input
          testID="routine-instruction"
          accessibilityLabel={t().routines.instruction}
          multiline
          value={draft().instruction}
          readonly={disabled()}
          placeholder="到达设定时间后，将向该 Bot 发送此指令开始工作，如输入提问或特定工作任务..."
          onChange={(e) => set({ instruction: e.value })}
          class={`${FIELD} min-h-[100px]`}
        />
      </FormCard>

      <FormCard>
        <EditorSwitchRow
          testID="routine-enabled-row"
          title={t().routines.enabled}
          desc={draft().enabled ? "已开启，将按设定周期自动准时触发" : "已暂停，日程暂时不会自动触发"}
        >
          <Switch testID="routine-enabled" label={t().routines.enabled} disabled={disabled()} checked={draft().enabled} onChange={(checked) => set({ enabled: checked })} />
        </EditorSwitchRow>
      </FormCard>

      <If when={page}>
        <View class="flex-row items-start gap-2 px-3 py-[10px] rounded-(--radius-md) bg-sidebar-bg border border-line-subtle">
          <Icon name="info" class="tint-ink-muted" />
          <Text class="flex-1 text-[12px] leading-[1.5] text-ink-muted">{t().routines.availability}</Text>
        </View>
        <If when={baseline()}>
          {(row) => (
            <View
              role="button"
              testID="routine-page-delete"
              accessibilityLabel={t().routines.remove}
              disabled={disabled()}
              onPress={() => {
                deleting.set(row());
                failure.set("");
              }}
              class="flex-row items-center justify-center gap-2 w-full min-h-[44px] rounded-(--radius-md) border border-danger-line bg-danger-bg disabled:opacity-[0.55]"
            >
              <Icon name="trash" class="tint-danger-text" />
              <Text class="text-[14px] font-semibold text-danger-text">{t().routines.remove}</Text>
            </View>
          )}
        </If>
      </If>
    </>
  );

  /** The desktop editor, under its row or standing in the add row's place. */
  const inlineEditor = () => (
    <View
      testID="routine-editor"
      accessibilityLabel={baseline() ? t().routines.edit : t().routines.add}
      class={`flex-col gap-[14px] min-w-0 ${standalone() ? "p-4 border border-brand rounded-(--radius-lg) bg-pane" : ""}`}
    >
      <If when={standalone()}>
        <Text role="header" class="text-[16px] font-bold text-ink">{baseline() ? t().routines.edit : t().routines.add}</Text>
      </If>
      {editorFields(false)}
      <View class="flex-row flex-wrap items-center justify-end gap-2">
        <Button testID="routine-cancel" disabled={busy()} onPress={close}>{t().routines.cancel}</Button>
        <Button testID="routine-save" variant="primary" disabled={cannotSave()} onPress={() => void save()}>
          {busy() ? t().routines.busy : t().routines.save}
        </Button>
      </View>
    </View>
  );

  return (
    <>
      <View testID="routine-section" accessibilityLabel={t().routines.title} class="flex-col gap-3 min-w-0">
        <If when={phone() && routines().length > 0}>
          <View class="flex-row items-center gap-[6px] px-3 py-2 rounded-(--radius-md) bg-pane border border-line">
            <Icon name="clock" class="tint-ink-muted" />
            <Text class="text-[12px] text-ink-muted">{t().routines.zone}</Text>
          </View>
        </If>

        <If when={routines().length === 0 && !(standalone() && !phone())}>
          <View testID="routine-empty" class={`items-center justify-center border border-line rounded-(--radius-lg) bg-pane ${phone() ? "px-4 py-5" : "px-4 py-3"}`}>
            <EmptyState size="inline" level={3} title={t().routines.empty} hint={t().routines.emptyHint} badge={<Icon name="calendar" class="tint-ink-muted" />}>
              <Button testID="routine-empty-add" variant="primary" size={phone() ? "lg" : "md"} icon="plus" disabled={disabled()} onPress={() => open()}>
                {t().routines.add}
              </Button>
            </EmptyState>
          </View>
        </If>

        <If when={routines().length > 0}>
          <View testID="routine-list" class="flex-col gap-2">
            <Each of={routines()} key={(row) => row.id}>
              {(row) => {
                const isOpen = () => editing() === row().id;
                const inline = () => isOpen() && !phone();
                return (
                  <View class="flex-col">
                    <View
                      testID={`routine-row-${row().id}`}
                      class={`flex-row items-center gap-3 min-w-0 border bg-pane ${phone() ? "px-[14px] py-3" : "pl-4 pr-[10px] py-3"} rounded-t-(--radius-lg) ${inline() && !standalone() ? "" : "rounded-b-(--radius-lg)"} ${isOpen() ? "border-brand bg-accent-tint" : "border-line hover:border-line-hover"}`}
                      style={{ opacity: row().enabled ? 1 : 0.9 }}
                    >
                      <View
                        role="button"
                        testID={`routine-open-${row().id}`}
                        accessibilityLabel={`${t().routines.edit}: ${row().title}`}
                        disabled={disabled()}
                        onPress={() => open(row())}
                        class={`flex-row items-center gap-[14px] flex-1 min-w-0 ${phone() ? "min-h-[52px]" : "min-h-[40px]"}`}
                      >
                        <Text class={`font-bold ${phone() ? "text-[24px] w-[68px]" : "text-[22px]"} ${row().enabled ? "text-ink" : "text-ink-muted"}`}>{row().schedule.time}</Text>
                        <View class="flex-col gap-1 flex-1 min-w-0">
                          <View class="flex-row items-center gap-2 min-w-0">
                            <Text tooltip={tip(row().title)} class={`text-[14px] font-semibold line-clamp-1 shrink ${row().enabled ? "text-ink" : "text-ink-muted"}`}>{row().title}</Text>
                            <If when={!row().enabled}>
                              <View class="px-[6px] py-[1px] rounded-full bg-sidebar-bg border border-line shrink-0">
                                <Text class="text-[11px] font-medium text-ink-muted">{t().routines.paused}</Text>
                              </View>
                            </If>
                          </View>
                          <View class="flex-row items-center gap-[5px] min-w-0">
                            <Icon name="repeat" size={12} class="tint-ink-muted" />
                            <Text class="text-[12px] text-ink-muted line-clamp-1">{routineRepeatLabel(row().schedule, t())}</Text>
                          </View>
                        </View>
                      </View>
                      <Switch
                        testID={`routine-toggle-${row().id}`}
                        label={`${row().enabled ? t().routines.pause : t().routines.resume}: ${row().title}`}
                        disabled={disabled()}
                        checked={row().enabled}
                        onChange={() => void mutate(() => runtime.patchRoutine(row().id, { enabled: !row().enabled, if_revision: row().updated_at }), () => {})}
                      />
                      <If when={!phone()}>
                        <View
                          role="button"
                          testID={`routine-remove-${row().id}`}
                          accessibilityLabel={`${t().routines.remove}: ${row().title}`}
                          tooltip={tip(t().routines.remove)}
                          disabled={disabled()}
                          onPress={() => {
                            deleting.set(row());
                            failure.set("");
                          }}
                          class="group w-[32px] h-[32px] items-center justify-center rounded-(--radius-md) hover:bg-danger-bg disabled:opacity-[0.55]"
                        >
                          <Icon name="trash" class="tint-ink-muted group-hover:tint-danger-text" />
                        </View>
                      </If>
                    </View>
                    <If when={inline() && !standalone()}>
                      <View class="p-4 border border-brand border-t-0 rounded-b-(--radius-lg) bg-pane">{inlineEditor()}</View>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>

        <If when={standalone() && !phone()} else={<If when={routines().length > 0 && !phone()}>{AddButton({ testID: "routine-add" })}</If>}>
          {inlineEditor()}
        </If>

        <If when={failure() && !editing()}>
          <Text role="alert" testID="routine-failure" class={FIELD_ERROR}>{failure()}</Text>
        </If>
        <If when={retryable() && !editing()}>
          <Text role="text" class="text-[12px] leading-[1.6] text-ink-muted">{t().routines.retryHint}</Text>
          <Button testID="routine-retry" disabled={disabled()} onPress={() => void retry()}>{t().routines.retry}</Button>
        </If>
        <If when={notice() && !editing()}>
          <Text role="text" testID="routine-notice" class="text-[12px] leading-[1.6] text-ink-muted">{notice()}</Text>
        </If>

        <If when={!phone()}>
          <View class="flex-row items-start gap-2 px-1 pt-[2px]">
            <Icon name="info" class="tint-ink-muted" />
            <View class="flex-1 gap-[2px]">
              <Text class="text-[12px] leading-[1.6] text-ink-muted">{t().routines.zone}</Text>
              <Text class="text-[12px] leading-[1.6] text-ink-muted">{t().routines.availability}</Text>
            </View>
          </View>
        </If>
      </View>

      <If when={editing() && phone()}>
        <Modal
          testID="routine-page"
          title={baseline() ? t().routines.edit : t().routines.add}
          closeLabel={t().common.close}
          backLabel={t().common.back}
          busy={busy()}
          pageOnPhone
          subject={<SettingsSubject variant="line" bot={props.bot} />}
          onClose={close}
          bodyClass="px-3 pt-4 pb-7 gap-[14px]"
          foot={
            <ModalAction kind="primary" testID="routine-save" disabled={cannotSave()} busy={busy()} onPress={() => void save()}>
              {busy() ? t().routines.busy : t().routines.save}
            </ModalAction>
          }
        >
          {editorFields(true)}
        </Modal>
      </If>

      <If when={deleting()}>
        {(row) => (
          <DangerDialog
            busy={busy()}
            copy={{ title: t().routines.remove, body: `${row().title} — ${t().routines.deleteBody}`, confirm: t().routines.confirm, cancel: t().routines.cancel }}
            onDismiss={() => {
              if (!busy()) deleting.set(null);
            }}
            onConfirm={() => void remove()}
          />
        )}
      </If>
    </>
  );
}
