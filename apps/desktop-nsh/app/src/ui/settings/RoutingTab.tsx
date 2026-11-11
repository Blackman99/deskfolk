/**
 * Roles (ADR 0082; its own page since ADR 0083, see `RolesPage`; engines since ADR 0085;
 * `settings/RoutingTab.svelte`): one engine drawn as the flow board draws a job — the things that set
 * the app's own steps off, each step a card — and the step picked beside it: whether it runs in that
 * engine and with what numbers, and for a step that makes one of the app's calls, that call's model
 * and prompts. On a wide window the engines run down the left as the conversations do
 * (`PlaybookList`); the three scroll on their own, so a pick changes what is beside the map and moves
 * nothing. Where it is narrow — a phone, a narrow tab, or in place of the list beside a wide window —
 * the engines are a row of chips over the map alone, and a step opens as a page of its own; a prompt
 * opens in the same editor as on Prompts.
 *
 * Props: `items` (every built-in prompt; the caller loads them); `loadFailed`; `closeSettings`;
 * `openTab(tab)` (another page of settings: every turn's prompts are on Prompts); `notices` (what the
 * dialog says over any page); `ownBack` (nothing above has a way back: a step's page carries its
 * own); `onReady(handle)` (called once with what the Svelte exported: `sectionTitle()` the open
 * call's name for a phone's page head or null, `deep()` a call's page or the editor is open,
 * `backFromSection()` and `backFromEditor()`, each true when it took the Back).
 * Test ids: `routing-tab`, `routing-detail-turn`, `routing-link-prompts`, `routing-part-ladder`,
 * `routing-back`, `routing-hint` (an engine's line), `routing-intro`, and the playbook parts' own.
 *
 * Differently from the Svelte: ↑ and ↓ walk the map's calls while the map is on screen (a
 * keyboard shortcut; NSH views take no key events), and the picked node is not given the focus.
 */
import { builtinPlaybook, emptyPlaybookDiff, playbookDefaults, type BuiltinModelRole, type CustomStep, type Locale, type Playbook, type PlaybookStepId, type PromptSummary } from "@real-bot/protocol";
import { computed, effect, keymap, Scroll, signal, Text, untracked, View, type JSX, type ScrollRef } from "nsh";
import { copy, runtime } from "../../runtime";
import { firstLocale, type PromptView } from "../../m/settings/prompts-view.ts";
import { askOnce, routingNodeView } from "../../m/settings/routing-map.ts";
import { ModelLadder } from "../../m/settings/model-ladder.svelte.ts";
import { hookOfMoment, isCustomNode, PLAYBOOK_ROUNDS, playbookOrder, stepOfRole, stepRole, type PlaybookNodeId } from "../../m/settings/playbook-flow.ts";
import { playbookName, Playbooks } from "../../m/settings/playbooks.svelte.ts";
import { CustomStepDetail } from "./CustomStepDetail";
import { ModelLadderCard } from "./ModelLadderCard";
import { PlaybookHeader } from "./PlaybookHeader";
import { PlaybookHistory } from "./PlaybookHistory";
import { PlaybookList } from "./PlaybookList";
import { PlaybookMap } from "./PlaybookMap";
import { PlaybookStepDetail } from "./PlaybookStepDetail";
import { PlaybookTurnPart } from "./PlaybookTurnPart";
import { PromptEditorPage } from "./PromptEditorPage";
import { RoutingNode } from "./RoutingNode";
import { widthAtMost } from "../../platform/viewport";
import { settled } from "../workbench/drag-settle";

export type RoutingTabHandle = {
  sectionTitle: () => string | null;
  deep: () => boolean;
  backFromSection: () => boolean;
  backFromEditor: () => boolean;
};

const clamp = (low: number, value: number, high: number) => Math.min(high, Math.max(low, value));

export function RoutingTab(props: {
  items: readonly PromptSummary[];
  loadFailed?: boolean;
  closeSettings?: () => void;
  openTab: (tab: "prompts") => void;
  notices?: JSX.Element;
  ownBack?: boolean;
  onReady?: (handle: RoutingTabHandle) => void;
}) {
  const t = () => copy();
  const c = () => t().routing;
  const snapshot = () => runtime.snapshot;
  const ui = (): Locale => (snapshot().settings.locale === "en" ? "en" : "zh");
  /**
   * Its own width once measured, so a narrow tab or the list's place is narrow whatever the window.
   * The engines' list beside the map and the picked step needs a little more room than the two did.
   */
  const width = signal(0);
  const narrow = settled(() => (width() > 0 ? width() <= 760 : widthAtMost(720)));
  const providers = () => snapshot().providers;
  const botNames = () => new Map(snapshot().bots.map((bot) => [bot.id, bot.name] as const));

  const selected = signal<PlaybookNodeId>("reader");

  // The engines (ADR 0085): read once, and again whenever one changes.
  const playbooks = new Playbooks(() => runtime.client);
  effect(() => {
    void runtime.client;
    void runtime.connection;
    void runtime.playbooksRevision;
    untracked(() => void playbooks.load());
  });
  /** The engine shown; until you pick one, the default. */
  const shown = signal<string | null>(null);
  const shownId = () => (shown() && playbooks.find(shown()!) ? shown()! : playbooks.defaultId);
  /** A Mac older than engines: every step as it always ran, with nothing to change here. */
  const allOn: Playbook = { id: "general", builtin: true, base_id: "general", name: null, revision: 0, revision_id: null, diff: emptyPlaybookDiff(), resolved: playbookDefaults(), updated_at: null };
  const current = () => playbooks.find(shownId()) ?? (playbooks.failed ? allOn : null);
  const builtin = () => {
    const now = current();
    return now && !playbooks.failed ? builtinPlaybook(now.base_id as Parameters<typeof builtinPlaybook>[0]) : playbookDefaults();
  };
  const engineName = () => playbookName(current() ?? undefined, t().playbooks.builtin);
  /** What a built-in engine is for, over the map on a wide window; on a narrow one the chips say it. */
  const engineHint = () => (current()?.builtin ? (t().playbooks.builtinHint[current()!.id] ?? null) : null);

  /** An engine's history, shown beside the map in the picked step's place; picking a step leaves it. */
  const historyOf = signal<string | null>(null);
  const historyShown = () => historyOf() !== null && historyOf() === shownId() && current() !== null;

  let detailScroll: ScrollRef | null = null;
  let scroller: ScrollRef | null = null;
  const toTop = (ref: ScrollRef | null) => ref?.scrollTo({ y: 0, animated: false });

  function show(id: string): void {
    shown.set(id);
    if (historyOf() !== id) historyOf.set(null);
  }

  function showHistory(id: string): void {
    shown.set(id);
    historyOf.set(id);
    toTop(detailScroll);
  }
  /** On a phone, a call's page is open over the map. */
  const opened = signal(false);

  // The model ladder (ADR 0054) is set on the Bot's turn here. Read again when the endpoints change:
  // a rung whose model is no longer listed is gone from it.
  const ladder = new ModelLadder(() => runtime.client);
  effect(() => {
    void runtime.client;
    void runtime.connection;
    void providers().map((provider) => `${provider.id}:${provider.models.join(",")}`).join("|");
    untracked(() => void ladder.load());
  });
  const turnModel = () => (ladder.available && ladder.rungs.length > 0 ? c().turn.ladder(ladder.rungs.map((rung) => rung.model).join(" → ")) : c().turn.model);

  /** Set up on a local agent with no endpoint (ADR 0078, ADR 0079): the calls are on its models. */
  const onAgent = () => Object.values(snapshot().settings.builtin_models ?? {}).some((chosen) => chosen !== null && typeof chosen === "object" && "runner" in chosen);
  const pickable = () => providers().length > 0 || onAgent();

  /** Asked once for the page, whichever calls are opened; none where the phone cannot ask. */
  const claudeStatus = computed(() => {
    const api = runtime.client;
    return api ? askOnce(() => api.claudeCode()) : null;
  });
  const agents = computed(() => {
    const api = runtime.client;
    return api ? askOnce(() => api.agents()) : null;
  });

  const viewOf = (role: BuiltinModelRole) => routingNodeView(role, snapshot().settings, props.items);
  /** The engine's steps of your own; an older daemon has none. */
  const own = () => current()?.custom_steps ?? [];
  /** A step of your own being written, not saved yet (ADR 0105). */
  const draft = signal<CustomStep | null>(null);
  const nameOf = (node: PlaybookNodeId): string => {
    if (node === "turn") return c().turn.name;
    if (isCustomNode(node)) return own().find((step) => step.id === node)?.name ?? (draft()?.id === node ? draft()!.name : "");
    return t().playbooks.steps[node]?.name ?? node;
  };
  /** The saved step the panel shows, or the draft; null once it is gone. */
  const ownShown = () => (isCustomNode(selected()) ? (own().find((step) => step.id === selected()) ?? null) : null);
  const draftShown = () => (ownShown() === null && draft() !== null && draft()!.id === selected() ? draft() : null);
  /** The moment of the step of your own last shown: a deleted one is gone from the list by the time `ondone` runs. */
  let lastAt: CustomStep["at"] = "turn_end";
  effect(() => {
    const mine = ownShown() ?? draftShown();
    if (mine) lastAt = mine.at;
  });

  /** Where the panel goes when the step of your own it showed is gone: its round's turn, or the round's first step. */
  function leaveOwn(at: CustomStep["at"]): void {
    const hook = hookOfMoment(at);
    selected.set(hook === "turn" ? "turn" : (PLAYBOOK_ROUNDS.find((round) => round.hook === hook)?.steps[0] ?? "turn"));
    if (narrow()) opened.set(false);
  }

  // Another engine shown: a draft was about the one before. A step of your own that is not in this one is gone from the panel.
  effect(() => {
    void shownId();
    untracked(() => draft.set(null));
  });
  effect(() => {
    const gone = isCustomNode(selected()) && !ownShown() && !draftShown() && current();
    if (!gone) return;
    untracked(() => {
      selected.set("turn");
      if (narrow()) opened.set(false);
    });
  });

  function startDraft(step: CustomStep): void {
    draft.set(step);
    selected.set(step.id as PlaybookNodeId);
    historyOf.set(null);
    toTop(detailScroll);
    if (narrow()) {
      opened.set(true);
      toTop(scroller);
    }
  }

  /** The step a call belongs to in this engine; a step of your own's call belongs to its first model step. */
  function nodeOfRole(role: BuiltinModelRole): PlaybookNodeId | null {
    return stepOfRole(role) ?? (role === "custom_step" ? ((own().find((step) => step.run.kind === "model")?.id as PlaybookNodeId | undefined) ?? null) : null);
  }

  const order = () => playbookOrder(own());

  function pick(node: PlaybookNodeId): void {
    selected.set(node);
    historyOf.set(null);
    if (!narrow()) {
      // Another call's page starts at its top; the map stays where it was.
      toTop(detailScroll);
      return;
    }
    opened.set(true);
    toTop(scroller);
  }

  // On a wide window ↑ and ↓ walk the map's calls in its order, picking each as it goes.
  effect(() => {
    if (narrow() || open() !== null) return;
    const walk = (by: number) => {
      const list = order();
      const next = list[Math.min(list.length - 1, Math.max(0, list.indexOf(selected()) + by))]!;
      pick(next);
    };
    const off = [keymap.bind("down", () => walk(1)), keymap.bind("up", () => walk(-1))];
    return () => off.forEach((fn) => fn());
  });

  // The prompt editor, as Settings › Prompts opens it.
  const open = signal<{ id: string; locale: Locale } | null>(null);
  const editorView = signal<PromptView>("text");
  const editorReveal = signal<string | null>(null);
  let flushEditor: () => Promise<void> = async () => {};
  /** Opened from a card: its call goes under the editor once it shows. */
  const focusEditor = signal(false);
  const openItem = () => {
    const at = open();
    return at ? props.items.find((item) => item.id === at.id) : undefined;
  };

  props.onReady?.({
    /** The open call's name for the page head on a phone; null on the map, and on a wide window. */
    sectionTitle: () => (narrow() && opened() ? nameOf(selected()) : null),
    /** A call's page on a phone, or the prompt editor, is open: Back has a step to take in here first. */
    deep: () => open() !== null || (narrow() && opened()),
    /** Back on a phone from a call's page goes to the map. */
    backFromSection: () => {
      if (!narrow() || !opened()) return false;
      opened.set(false);
      return true;
    },
    /** Back on a phone, or ✕: what you typed is saved first. */
    backFromEditor: () => {
      if (!open()) return false;
      void closeEditor();
      return true;
    },
  });

  // Sent here from a card's 「在设置里看」 about one of these calls' prompts: its history, at the change.
  effect(() => {
    const target = runtime.promptsTarget?.prompt;
    if (!target) return;
    untracked(() => {
      editorView.set("history");
      editorReveal.set(target.revisionId);
      open.set({ id: target.id, locale: target.locale });
      focusEditor.set(true);
      runtime.promptsTarget = null;
    });
  });

  // Sent here for one call — a card's 「在设置里看」 about one of its prompts: that call's step, picked.
  effect(() => {
    const target = runtime.rolesTarget;
    if (!target) return;
    untracked(() => {
      runtime.rolesTarget = null;
      // Sent from a job's title row: that job's engine shown.
      if (target.playbook) show(target.playbook);
      const node = target.role ? nodeOfRole(target.role) : null;
      if (node) {
        selected.set(node);
        historyOf.set(null);
        if (narrow()) opened.set(true);
      }
    });
  });

  // Under the editor, its call: where closing it, or Back on a phone, lands.
  effect(() => {
    const item = openItem();
    if (!focusEditor() || !open() || !item) return;
    untracked(() => {
      focusEditor.set(false);
      const node = item.role ? nodeOfRole(item.role) : null;
      if (node) {
        selected.set(node);
        historyOf.set(null);
        opened.set(true);
      }
    });
  });

  function openEditor(item: PromptSummary): void {
    editorView.set("text");
    editorReveal.set(null);
    open.set({ id: item.id, locale: firstLocale(item, ui()) });
  }

  async function closeEditor(): Promise<void> {
    await flushEditor();
    open.set(null);
  }

  function openMessage(sessionId: string, messageId: string): void {
    void flushEditor();
    open.set(null);
    props.closeSettings?.();
    void runtime.selectSession(sessionId, { messageId });
  }

  const hint = "text-[12px] leading-[1.45] text-ink-muted";
  const link = (testID: string, label: string, onPress: () => void) => (
    <View role="button" testID={testID} accessibilityLabel={label} onPress={onPress} class="cursor-pointer select-none self-start">
      <Text class="text-[12px] text-brand hover:underline">{label}</Text>
    </View>
  );

  /** The picked call's model and prompts, inside a step's panel. */
  const callPart = () => {
    const role = () => (isCustomNode(selected()) ? "custom_step" : stepRole(selected()));
    return (
      <If when={role()}>
        {(which) => (
          <RoutingNode
            role={which() as BuiltinModelRole}
            view={viewOf(which() as BuiltinModelRole)}
            providers={providers()}
            settings={snapshot().settings}
            defaultModel={snapshot().settings.endpoint_default_model}
            patch={(patch) => runtime.patchSettings(patch)}
            pickable={pickable()}
            claudeStatus={claudeStatus()}
            agents={agents()}
            claudeModels={runtime.client}
            promptsFailed={props.loadFailed === true}
            ui={ui()}
            botNames={botNames()}
            onOpenPrompt={openEditor}
            headless
          />
        )}
      </If>
    );
  };

  const turnPanel = () => (
    <View
      role="region"
      testID="routing-detail-turn"
      accessibilityLabel={c().turn.name}
      class="flex-col gap-[6px] p-[14px] bg-pane border border-dashed border-line rounded-(--radius-md)"
    >
      <Text role="header" class="text-[14px] font-semibold text-ink">{c().turn.name}</Text>
      <Text class={hint}>{c().turn.hint}</Text>
      <View class="flex-row flex-wrap gap-2">{link("routing-link-prompts", `${c().turn.toPrompts} ›`, () => props.openTab("prompts"))}</View>
      <View testID="routing-part-ladder" class="flex-col gap-2 min-w-0 mt-2 pt-3 border-t border-line">
        <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{t().modelLadder.title}</Text>
        <If
          when={ladder.available}
          else={<Text class={hint}>{c().turn.ladderOff}</Text>}
        >
          <If when={providers().length > 0} else={<Text class={hint}>{c().turn.ladderNoEndpoint}</Text>}>
            <Text class={hint}>{t().modelLadder.hint}</Text>
            <ModelLadderCard ladder={ladder} providers={providers()} claudeCode={claudeStatus()} agents={agents()} claudeModels={runtime.client} />
          </If>
        </If>
      </View>
      <If when={current()}>
        {(now) => (
          <PlaybookTurnPart
            playbook={now()}
            locale={ui()}
            api={runtime.client}
            onsave={(diff) => playbooks.save(now().id, diff)}
            saving={playbooks.saving}
            error={playbooks.error}
          />
        )}
      </If>
    </View>
  );

  const detail = () => (
    <If when={selected() === "turn"} else={
      <If when={current()}>
        {(now) => (
          <If
            when={isCustomNode(selected())}
            else={
              <PlaybookStepDetail
                step={selected() as PlaybookStepId}
                playbook={now()}
                builtin={builtin()}
                engineName={engineName()}
                onsave={(diff) => void playbooks.save(now().id, diff)}
                onreset={(step) => void playbooks.reset(now().id, step)}
                saving={playbooks.saving || playbooks.failed}
                error={playbooks.error}
                callHint={stepRole(selected()) ? t().builtinModels.roles[stepRole(selected())!].hint : null}
                call={stepRole(selected()) ? callPart() : undefined}
              />
            }
          >
            <If when={ownShown() ?? draftShown()}>
              {(mine) => (
                <CustomStepDetail
                  step={mine()}
                  draft={ownShown() === null}
                  running={ownShown()?.running ?? true}
                  playbook={now()}
                  engineName={engineName()}
                  api={runtime.client}
                  onsave={(diff) => playbooks.save(now().id, diff)}
                  oncancel={() => {
                    const at = draft()?.at ?? "turn_end";
                    draft.set(null);
                    leaveOwn(at);
                  }}
                  ondone={(what) => {
                    draft.set(null);
                    if (what === "deleted") leaveOwn(lastAt);
                  }}
                  saving={playbooks.saving || playbooks.failed}
                  error={playbooks.error}
                  message={playbooks.message}
                  call={callPart()}
                />
              )}
            </If>
          </If>
        )}
      </If>
    }>
      {turnPanel()}
    </If>
  );

  const header = () => (
    <If
      when={playbooks.failed}
      else={
        <If when={playbooks.list}>
          <PlaybookHeader playbooks={playbooks} shown={shownId()} onshow={show} onmakedefault={(id) => void runtime.patchSettings({ default_playbook: id })} />
        </If>
      }
    >
      <Text role="text" class={hint}>{t().playbooks.older}</Text>
    </If>
  );

  const map = (picked: () => PlaybookNodeId | null) => (
    <If when={current()}>
      {(now) => (
        <PlaybookMap
          resolved={now().resolved}
          builtin={builtin()}
          viewOf={viewOf}
          turnModel={turnModel()}
          selected={picked()}
          onpick={pick}
          own={own()}
          onadd={playbooks.failed ? undefined : startDraft}
        />
      )}
    </If>
  );

  const listWidth = () => clamp(184, width() * 0.22, 248);
  const detailWidth = () => clamp(320, (width() - (playbooks.failed ? 0 : listWidth()) - 48 - 14) * 0.46, 420);

  const narrowView = () => (
    <Scroll ref={(node) => (scroller = node)} role="region" accessibilityLabel={c().tab} class="flex-1 min-h-0">
      <View class="flex-col gap-[14px] px-4 pt-[14px] pb-5">
        {props.notices}
        <If
          when={opened()}
          else={
            <>
              {header()}
              <Text testID="routing-intro" class={hint}>{c().intro}</Text>
              {map(() => null)}
            </>
          }
        >
          <View testID="routing-subpage" class="flex-col">
            <If when={props.ownBack}>
              <View role="button" testID="routing-back" accessibilityLabel={`‹ ${c().backToMap}`} onPress={() => opened.set(false)} class="cursor-pointer select-none self-start mb-3">
                <Text class="text-[12px] text-brand hover:underline">{`‹ ${c().backToMap}`}</Text>
              </View>
            </If>
            {detail()}
          </View>
        </If>
      </View>
    </Scroll>
  );

  const wideView = () => (
    <View testID="routing-wide" class="flex-1 min-h-0 flex-row">
      <If when={!playbooks.failed}>
        <Scroll role="region" accessibilityLabel={t().playbooks.title} class="min-h-0 border-r border-line-subtle shrink-0" style={{ width: listWidth() }}>
          <View class="px-2 pt-[10px] pb-4">
            <If when={playbooks.list}>
              <PlaybookList
                playbooks={playbooks}
                shown={shownId()}
                onshow={show}
                onmakedefault={(id) => void runtime.patchSettings({ default_playbook: id })}
                onhistory={showHistory}
                locale={ui()}
              />
            </If>
          </View>
        </Scroll>
      </If>
      <View class="flex-1 min-h-0 min-w-0 flex-col">
        <View class="flex-col gap-[6px] px-6 pt-4 pb-3">
          {props.notices}
          <If
            when={playbooks.failed}
            else={
              <If when={engineHint()}>
                {(line) => (
                  <Text testID="routing-hint" class="text-[13px] leading-[1.5] text-ink-secondary">
                    {line()}
                  </Text>
                )}
              </If>
            }
          >
            <Text role="text" class={hint}>{t().playbooks.older}</Text>
          </If>
          <Text testID="routing-intro" class={hint}>{c().intro}</Text>
        </View>
        <View class="flex-1 min-h-0 flex-row gap-[14px] px-6 pb-5">
          <Scroll role="region" accessibilityLabel={engineName() || t().playbooks.title} class="flex-1 min-w-0 min-h-0">
            <View class="p-[2px]">{map(() => (historyShown() ? null : selected()))}</View>
          </Scroll>
          <Scroll
            ref={(node) => (detailScroll = node)}
            role="region"
            accessibilityLabel={historyShown() ? t().playbooks.historyOf(engineName()) : nameOf(selected())}
            class="min-h-0 shrink-0"
            style={{ width: detailWidth() }}
          >
            <View class="flex-col">
              <If when={historyShown() ? current() : null} else={detail()}>
                {(now) => <PlaybookHistory playbooks={playbooks} playbook={now()} name={engineName()} onclose={() => historyOf.set(null)} />}
              </If>
            </View>
          </Scroll>
        </View>
      </View>
    </View>
  );

  return (
    <View testID="routing-tab" class="flex-1 min-h-0 min-w-0 flex-col" onLayout={(e) => width.set(e.bounds.size.width)}>
      <If when={narrow()} else={wideView()}>
        {narrowView()}
      </If>
      <If when={open() && openItem()}>
        {(item) => (
          <PromptEditorPage
            item={item()}
            open={open()!}
            view={editorView()}
            onViewChange={(next) => editorView.set(next)}
            reveal={editorReveal()}
            onClose={() => void closeEditor()}
            onLocale={(locale) => {
              editorReveal.set(null);
              open.set({ id: open()!.id, locale });
            }}
            onOpenMessage={openMessage}
            onReady={(api) => {
              flushEditor = api.flush;
            }}
          />
        )}
      </If>
    </View>
  );
}
