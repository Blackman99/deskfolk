/**
 * One built-in prompt's editor (`settings/PromptEditor.svelte`): the summary and the language
 * switch on top, a row of views (the text you edit, what it changes from the default, every change
 * so far), the view itself under them. What you type saves itself a second later, against the
 * change you saw, in one sitting; leaving the text, the language or the editor saves it at once.
 *
 * The Svelte editor is a plain textarea: placeholders are listed under it, not highlighted, and
 * there is no insert-variable button; this one is an `Input multiline` the same way. Not carried
 * over: saving on the textarea's blur is `onBlur` of the Input (kept); scrolling the revealed
 * change into view in the history (the change opens, the list does not scroll to it).
 *
 * Props: `id`, `locale`; `onLocale(locale)` (switch the language shown; the editor saves first);
 * `onOpenMessage(sessionId, messageId)`; `view` + `onViewChange` (the view shown, owned by the
 * caller so switching the language keeps you where you were); `revealRevision` (a change to show
 * opened in the history); `onReady(api)` (hands the caller `flush()`: saves what was typed and not
 * yet saved); `height` (the page's height for the editor, px).
 */
import { changedLines, type Locale, type PromptDetail, type PromptRevision } from "@real-bot/protocol";
import { Clipboard, cleanup, effect, signal, Scroll, Text, untracked, View, windowSize, type JSX } from "nsh";
import { Input, Tab, Tabs } from "nsh/base";
import { copy, runtime } from "../../runtime";
import { ApiError } from "../../m/api.ts";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import { changedBy, markChanges, promptErrorText, type PromptView } from "../../m/settings/prompts-view.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { PromptDiff } from "./PromptDiff";

const SAVE_AFTER_MS = 1000;
/** One sitting in this editor: your saves in it fold into one change in the history. */
const editSession = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `s${Date.now()}`;
const VIEWS: readonly PromptView[] = ["text", "compare", "history"];

type Tone = "warn" | "danger";
const BANNER: Record<Tone, string> = {
  warn: "border-warn-line bg-warn-bg",
  danger: "border-danger-line bg-danger-bg",
};
const BANNER_TEXT: Record<Tone, string> = { warn: "text-warn-text", danger: "text-danger-text" };

function PillButton(props: { label: string; testID: string; disabled?: boolean; danger?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`group px-[10px] py-[3px] border rounded-(--radius-full) bg-pane hover:border-accent-border disabled:opacity-[0.6] ${props.danger ? "border-danger-line" : "border-line"}`}
    >
      <Text class={`text-[12px] ${props.danger ? "text-danger-text" : "text-ink-secondary group-hover:text-brand"}`}>{props.label}</Text>
    </View>
  );
}

function LinkButton(props: { label: string; testID: string; disabled?: boolean; onPress: () => void }) {
  return (
    <View role="button" testID={props.testID} disabled={props.disabled} onPress={() => props.onPress()} class="disabled:opacity-[0.6]">
      <Text class="text-[12px] text-brand">{props.label}</Text>
    </View>
  );
}

export function PromptEditor(props: {
  id: string;
  locale: Locale;
  onLocale: (locale: Locale) => void;
  onOpenMessage: (sessionId: string, messageId: string) => void;
  view: PromptView;
  onViewChange: (view: PromptView) => void;
  revealRevision?: string | null;
  onReady?: (api: { flush: () => Promise<void> }) => void;
  height?: number;
}) {
  const c = () => copy().prompts;
  const ui = (): Locale => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");

  const detail = signal<PromptDetail | null>(null);
  const loadFailed = signal(false);
  const text = signal("");
  const status = signal<"idle" | "saving" | "saved" | "unsaved">("idle");
  const problem = signal<string | null>(null);
  const stale = signal<string | null>(null);
  const copied = signal(false);
  const showFormat = signal(false);
  const showConflict = signal(false);
  const confirmingReset = signal(false);
  const busy = signal(false);
  const opened = signal<string | null>(props.revealRevision ?? null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const dirty = () => detail() !== null && text() !== detail()!.text;
  const edited = () => detail()?.base_text != null;
  const compare = () => {
    const d = detail();
    return d && props.view === "compare" ? markChanges(changedLines(d.default_text, text())) : [];
  };
  const conflictDiff = () => {
    const d = detail();
    return d?.conflict_default && d.base_text != null && showConflict() ? markChanges(changedLines(d.base_text, d.conflict_default)) : [];
  };
  const failures = () => detail()?.locales.find((state) => state.locale === props.locale)?.parse_failures ?? null;

  async function load(keepTyping = false): Promise<void> {
    const api = runtime.client;
    if (!api) return;
    try {
      const next = await api.getPrompt(props.id, props.locale);
      if (runtime.client !== api) return;
      loadFailed.set(false);
      // What you are typing stays put; a change made elsewhere shows once you stop.
      if (keepTyping && dirty()) return;
      detail.set(next);
      text.set(next.text);
    } catch {
      loadFailed.set(true);
    }
  }

  effect(() => {
    void props.id;
    void props.locale;
    untracked(() => {
      detail.set(null);
      status.set("idle");
      problem.set(null);
      stale.set(null);
      void load();
    });
  });

  // A change from anywhere (a Bot's approved edit, the phone, a merge): reload unless you are mid-edit.
  let seenRevision: number | null = null;
  effect(() => {
    const revision = runtime.promptsRevision;
    untracked(() => {
      const first = seenRevision === null;
      if (revision === seenRevision) return;
      seenRevision = revision;
      if (!first && status() !== "saving") void load(true);
    });
  });

  function schedule(): void {
    if (timer) clearTimeout(timer);
    status.set("unsaved");
    problem.set(null);
    timer = setTimeout(() => void save(), SAVE_AFTER_MS);
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (dirty()) await save();
  }
  props.onReady?.({ flush });

  async function save(): Promise<void> {
    timer = null;
    const api = runtime.client;
    const d = detail();
    if (!api || !d || !dirty() || busy()) return;
    const sent = text();
    status.set("saving");
    try {
      const next = await api.putPrompt(props.id, props.locale, { text: sent, if_revision: d.head_revision_id, edit_session: editSession });
      detail.set(next);
      if (text() === sent) text.set(next.text);
      status.set(text() === next.text ? "saved" : "unsaved");
      problem.set(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Someone else changed it: show theirs, keep yours to copy.
        stale.set(sent);
        await load();
        status.set("idle");
        return;
      }
      status.set("unsaved");
      problem.set(promptErrorText(error, c()));
    }
  }

  async function act(run: () => Promise<PromptDetail>): Promise<void> {
    if (busy()) return;
    busy.set(true);
    problem.set(null);
    try {
      const next = await run();
      detail.set(next);
      text.set(next.text);
      status.set("saved");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await load();
      problem.set(promptErrorText(error, c()));
    } finally {
      busy.set(false);
      confirmingReset.set(false);
    }
  }

  async function copyStale(): Promise<void> {
    const mine = stale();
    if (mine === null) return;
    try {
      await Clipboard.writeText(mine);
      copied.set(true);
    } catch {
      copied.set(false);
    }
  }

  function switchLocale(next: Locale): void {
    if (next === props.locale) return;
    void flush().then(() => props.onLocale(next));
  }

  /** Leaving the text saves what you typed, so the history shows it and nothing waits on a timer. */
  function showView(next: PromptView): void {
    if (next === props.view) return;
    if (props.view === "text") void flush();
    props.onViewChange(next);
  }

  /** Whether a change changed the words at all: keeping your version over a newer default does not. */
  function changesText(revision: PromptRevision, d: PromptDetail): boolean {
    return (revision.before_text ?? d.default_text) !== (revision.after_text ?? d.default_text);
  }

  cleanup(() => {
    if (timer) {
      clearTimeout(timer);
      if (dirty()) void save();
    }
  });

  const banner = (tone: Tone, testID: string, children: JSX.Element) => (
    <View testID={testID} role="text" class={`flex-col gap-[6px] px-3 py-[10px] border rounded-(--radius-md) ${BANNER[tone]}`}>
      {children}
    </View>
  );

  const revisionRow = (revision: PromptRevision, d: PromptDetail) => (
    <View testID={`prompt-revision-${revision.id}`} class="flex-col gap-[6px] px-3 py-[10px] border border-line rounded-(--radius-md) bg-pane">
      <View class="flex-row items-baseline justify-between gap-2">
        <Text class="text-[12px] font-semibold text-ink">{`${changedBy(revision.actor, revision.bot_name, c())} · ${c().op[revision.op]}`}</Text>
        <View tooltip={tip(formatFullTimestamp(revision.created_at))}>
          <Text class="text-[12px] text-ink-muted">{formatMessageTime(revision.created_at)}</Text>
        </View>
      </View>
      <If when={revision.reason}>
        <Text class="text-[12px] text-ink-secondary">{revision.reason ?? ""}</Text>
      </If>
      <View class="flex-row flex-wrap items-center gap-x-3 gap-y-[6px]">
        <If when={changesText(revision, d)}>
          <LinkButton
            testID={`prompt-revision-${revision.id}-toggle`}
            label={opened() === revision.id ? c().hideChange : c().showChange}
            onPress={() => opened.set(opened() === revision.id ? null : revision.id)}
          />
        </If>
        <If when={revision.undoable}>
          <LinkButton testID={`prompt-revision-${revision.id}-undo`} label={c().undo} disabled={busy()} onPress={() => void act(() => runtime.client!.undoPromptRevision(revision.id))} />
        </If>
        <If when={(revision.after_text ?? d.default_text) !== d.text}>
          <LinkButton
            testID={`prompt-revision-${revision.id}-restore`}
            label={c().restoreVersion}
            disabled={busy()}
            onPress={() => void act(() => runtime.client!.restorePromptRevision(revision.id))}
          />
        </If>
        <If when={revision.session_id && revision.message_id}>
          <LinkButton
            testID={`prompt-revision-${revision.id}-message`}
            label={c().openMessage}
            onPress={() => props.onOpenMessage(revision.session_id!, revision.message_id!)}
          />
        </If>
      </View>
      <If when={opened() === revision.id && changesText(revision, d)}>
        <PromptDiff testID={`prompt-revision-${revision.id}-diff`} lines={markChanges(changedLines(revision.before_text ?? d.default_text, revision.after_text ?? d.default_text))} maxHeight={280} />
      </If>
    </View>
  );

  return (
    <View
      testID="prompt-editor"
      accessibilityState={{ busy: busy() }}
      class="flex-col min-w-0"
      style={props.height ? { height: props.height } : undefined}
    >
      <If
        when={detail()}
        else={
          <Text role="text" testID="prompt-loading" class="px-5 py-4 text-[13px] text-ink-muted">
            {loadFailed() ? c().loadFailed : ""}
          </Text>
        }
      >
        {(d) => (
          <>
            <View class={`flex-col gap-[10px] shrink-0 ${narrowWindow() ? "px-[14px] pt-3 pb-[10px]" : "px-5 pt-[14px] pb-3"}`}>
              <View class="flex-row items-start gap-3">
                <Text testID="prompt-summary" class="flex-1 min-w-0 text-[13px] leading-[1.5] text-ink-secondary">
                  {d().summary[ui()]}
                </Text>
                <If
                  when={d().locales.length > 1}
                  else={
                    <View testID="prompt-only" tooltip={tip(c().onlyLanguage(c().language[d().locales[0]!.locale]))} class="shrink-0 px-2 py-[2px] rounded-(--radius-full) bg-chip">
                      <Text class="text-[11px] text-ink-muted">{c().onlyLanguageShort(c().language[d().locales[0]!.locale])}</Text>
                    </View>
                  }
                >
                  <View
                    role="group"
                    accessibilityLabel={c().language[props.locale]}
                    class="shrink-0 flex-row gap-[2px] p-[2px] border border-chip-line rounded-(--radius-md) bg-chip"
                  >
                    {() =>
                      d().locales.map((state) => (
                        <View
                          role="button"
                          testID={`prompt-locale-${state.locale}`}
                          accessibilityState={{ selected: state.locale === props.locale }}
                          onPress={() => switchLocale(state.locale)}
                          class={`px-[10px] py-[2px] rounded-(--radius-sm) ${state.locale === props.locale ? "bg-pane" : ""}`}
                        >
                          <Text class={`text-[12px] ${state.locale === props.locale ? "font-semibold text-brand" : "text-ink-muted"}`}>
                            {`${c().language[state.locale]}${state.state !== "default" ? " •" : ""}`}
                          </Text>
                        </View>
                      ))
                    }
                  </View>
                </If>
              </View>

              <If when={failures() && (failures()!.since_edit ?? 0) + failures()!.last_7_days > 0}>
                <Text testID="prompt-failures" class="text-[12px] text-warn-text">
                  {failures()!.since_edit !== null ? c().parseFailuresSinceEdit(failures()!.since_edit!) : c().parseFailuresWeek(failures()!.last_7_days)}
                </Text>
              </If>

              <If when={stale() !== null}>
                {banner(
                  "warn",
                  "prompt-stale",
                  <>
                    <Text class="text-[12px] leading-[1.45] text-warn-text">{c().changedElsewhere}</Text>
                    <View role="button" testID="prompt-copy-mine" onPress={() => void copyStale()}>
                      <Text class="text-[12px] text-brand">{copied() ? c().copied : c().copyMine}</Text>
                    </View>
                  </>,
                )}
              </If>

              <If when={d().conflict_default}>
                {banner(
                  "danger",
                  "prompt-conflict",
                  <>
                    <Text class={`text-[12px] font-bold ${BANNER_TEXT.danger}`}>{c().conflictTitle}</Text>
                    <Text class={`text-[12px] leading-[1.45] ${BANNER_TEXT.danger}`}>{c().conflictBody}</Text>
                    <View class="flex-row flex-wrap items-center gap-[6px]">
                      <PillButton testID="prompt-conflict-show" label={showConflict() ? c().conflictHide : c().conflictShow} onPress={() => showConflict.set(!showConflict())} />
                      <PillButton
                        testID="prompt-conflict-keep"
                        label={c().conflictKeep}
                        disabled={busy()}
                        onPress={() => void act(() => runtime.client!.keepMyPrompt(props.id, props.locale, d().head_revision_id))}
                      />
                      <PillButton testID="prompt-conflict-take" label={c().conflictTake} disabled={busy()} onPress={() => confirmingReset.set(true)} />
                    </View>
                    <If when={showConflict()}>
                      <PromptDiff testID="prompt-conflict-diff" lines={conflictDiff()} maxHeight={200} />
                    </If>
                  </>,
                )}
              </If>

              <If when={confirmingReset()}>
                <View testID="prompt-reset-confirm" role="alert" accessibilityLabel={c().resetConfirmTitle} class={`flex-col gap-[6px] px-3 py-[10px] border rounded-(--radius-md) ${BANNER.warn}`}>
                  <Text class="text-[12px] font-bold text-warn-text">{c().resetConfirmTitle}</Text>
                  <Text class="text-[12px] leading-[1.45] text-warn-text">{c().resetConfirmBody}</Text>
                  <View class="flex-row flex-wrap items-center gap-[6px]">
                    <PillButton
                      testID="prompt-reset-do"
                      danger
                      label={c().reset}
                      disabled={busy()}
                      onPress={() => void act(() => runtime.client!.resetPrompt(props.id, props.locale, d().head_revision_id))}
                    />
                    <PillButton testID="prompt-reset-cancel" label={c().cancel} onPress={() => confirmingReset.set(false)} />
                  </View>
                </View>
              </If>
            </View>

            <View class={`flex-row flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b border-line ${narrowWindow() ? "px-[10px]" : "px-5"}`}>
              <Tabs class="flex-row gap-1 min-w-0">
                {() =>
                  VIEWS.map((name) => (
                    <Tab
                      testID={`prompt-tab-${name}`}
                      selected={props.view === name}
                      onPress={() => showView(name)}
                      class={`group flex-row items-center gap-[6px] border-b-2 ${narrowWindow() ? "px-2 pt-[10px] pb-[11px]" : "px-[10px] pt-2 pb-[9px]"} ${props.view === name ? "border-brand" : "border-transparent"}`}
                    >
                      <Text class={`text-[13px] ${props.view === name ? "font-semibold text-ink" : "font-medium text-ink-muted group-hover:text-ink"}`}>{c().view[name]}</Text>
                      <If when={name === "history" && d().revisions.length > 0}>
                        <View testID="prompt-tab-history-count" class="min-w-4 px-[5px] rounded-(--radius-full) bg-chip items-center">
                          <Text class="text-[11px] font-semibold leading-4 text-ink-muted">{String(d().revisions.length)}</Text>
                        </View>
                      </If>
                    </Tab>
                  ))
                }
              </Tabs>
              <View class="flex-row items-center gap-[10px] min-h-9 ml-auto">
                <Text role="text" testID="prompt-save-state" class={`text-[12px] ${problem() !== null ? "text-danger-text" : "text-ink-muted"}`}>
                  {status() === "saving" ? c().saving : status() === "saved" ? c().saved : status() === "unsaved" ? c().unsaved : ""}
                </Text>
                <If when={edited()}>
                  <PillButton testID="prompt-reset" label={c().reset} disabled={busy()} onPress={() => confirmingReset.set(true)} />
                </If>
              </View>
            </View>

            {/* Kept while another view shows, so the text keeps its own undo and scroll. */}
            <View
              role="group"
              testID="prompt-panel-text"
              class={`flex-col gap-[10px] flex-1 min-h-0 ${narrowWindow() ? "px-[14px] pt-3 pb-[18px]" : "px-5 pt-[14px] pb-[18px]"}`}
              style={{ display: props.view === "text" ? "flex" : "none" }}
            >
              <Input
                testID="prompt-text"
                multiline
                submitBehavior="newline"
                autoCorrect={false}
                autoCapitalize="none"
                accessibilityLabel={c().editorLabel}
                maxLength={d().max_chars}
                value={text()}
                onChange={(e) => {
                  text.set(e.value);
                  schedule();
                }}
                onBlur={() => void flush()}
                class={`flex-1 min-h-[160px] w-full px-[14px] py-3 border border-line rounded-(--radius-md) bg-input-bg text-ink font-mono focus:border-field-focus-border ${narrowWindow() ? "text-[14px]" : "text-[13px]"}`}
              />
              <If when={problem()}>
                <Text role="alert" testID="prompt-problem" class="text-[12px] text-danger-text">
                  {problem() ?? ""}
                </Text>
              </If>
              <If when={d().placeholders.length > 0 || d().format}>
                <Scroll class="shrink-0 max-h-[200px]">
                  <View class="flex-col gap-2">
                    <If when={d().placeholders.length > 0}>
                      <View class={`gap-[10px] ${narrowWindow() ? "flex-col" : "flex-row items-baseline"}`}>
                        <View tooltip={tip(c().placeholdersHint)}>
                          <Text class="text-[12px] font-semibold text-ink">{c().placeholdersTitle}</Text>
                        </View>
                        <View class="flex-row flex-wrap gap-x-4 gap-y-1 flex-1 min-w-0">
                          {() =>
                            d().placeholders.map((placeholder) => (
                              <View testID={`prompt-placeholder-${placeholder.name}`} class="flex-row flex-wrap items-baseline gap-1">
                                <Text class="px-1 rounded-(--radius-sm) bg-chip text-[12px] text-ink font-mono">{`{${placeholder.name}}`}</Text>
                                <Text class="text-[12px] text-ink-secondary">{`${placeholder.meaning[ui()]} · ${c().placeholderRule[placeholder.required]}`}</Text>
                              </View>
                            ))
                          }
                        </View>
                      </View>
                    </If>
                    <If when={d().format}>
                      <View class="flex-col gap-[6px]">
                        <View role="button" testID="prompt-format-toggle" accessibilityState={{ expanded: showFormat() }} onPress={() => showFormat.set(!showFormat())} class="flex-row items-center gap-1 self-start">
                          <Icon name={showFormat() ? "chevron-down" : "chevron-right"} size={12} class="tint-ink" />
                          <Text class="text-[12px] font-semibold text-ink">{c().formatTitle}</Text>
                        </View>
                        <If when={showFormat()}>
                          <Text class="text-[12px] text-ink-muted">{c().formatNote}</Text>
                          <View class="px-[10px] py-2 rounded-(--radius-md) bg-chip">
                            <Text testID="prompt-format" class="text-[12px] leading-[1.5] text-ink-secondary font-mono">
                              {d().format ?? ""}
                            </Text>
                          </View>
                        </If>
                      </View>
                    </If>
                  </View>
                </Scroll>
              </If>
            </View>

            <If when={props.view === "compare"}>
              <Scroll testID="prompt-panel-compare" class={`flex-1 min-h-0 ${narrowWindow() ? "px-[14px]" : "px-5"}`}>
                <View class="flex-col py-[14px]">
                  <If when={compare().length > 0} else={<Text testID="prompt-same" class="text-[13px] text-ink-muted">{c().sameAsDefault}</Text>}>
                    <PromptDiff testID="prompt-compare-diff" full lines={compare()} />
                  </If>
                </View>
              </Scroll>
            </If>
            <If when={props.view === "history"}>
              <Scroll testID="prompt-panel-history" class={`flex-1 min-h-0 ${narrowWindow() ? "px-[14px]" : "px-5"}`}>
                <View role="region" accessibilityLabel={c().history} class="flex-col gap-2 py-[14px]">
                  <If when={d().revisions.length === 0}>
                    <Text testID="prompt-no-history" class="text-[13px] text-ink-muted">{c().noHistory}</Text>
                  </If>
                  {() => d().revisions.map((revision) => revisionRow(revision, d()))}
                </View>
              </Scroll>
            </If>
          </>
        )}
      </If>
    </View>
  );
}
