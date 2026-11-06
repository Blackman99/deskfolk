/**
 * Roles' engines (ADR 0085, 0105): the list, the header, the map, a step's detail, a step of your
 * own, the Bot's turn part and the history. The page itself (`RoutingTab`) is a later job, so this
 * story is the caller: it reads the engines through `Playbooks`, holds the picked node and the
 * draft, and saves through the runtime as the page does.
 *
 * `story-show-<board|narrow>` picks the wide board (list, map and detail side by side) or the
 * phone's single column (header over the map over the detail). `story-read` reads the engines from
 * the daemon (a GET of its own, not the page's copy) into `story-probe`; `story-cleanup` puts back
 * what a test changed.
 */
import { builtinPlaybook, emptyPlaybookDiff, playbookDefaults, type BuiltinModelRole, type BuiltinPlaybookId, type CustomStep, type Playbook } from "@real-bot/protocol";
import { effect, Scroll, signal, Text, View } from "nsh";
import { copy, runtime } from "../src/runtime";
import { hookOfMoment, isCustomNode, PLAYBOOK_ROUNDS, stepRole, type PlaybookNodeId } from "../src/m/settings/playbook-flow.ts";
import { playbookName, Playbooks } from "../src/m/settings/playbooks.svelte.ts";
import type { RoutingNodeView } from "../src/m/settings/routing-map.ts";
import { CustomStepDetail } from "../src/ui/settings/CustomStepDetail";
import { PlaybookHeader } from "../src/ui/settings/PlaybookHeader";
import { PlaybookHistory } from "../src/ui/settings/PlaybookHistory";
import { PlaybookList } from "../src/ui/settings/PlaybookList";
import { PlaybookMap } from "../src/ui/settings/PlaybookMap";
import { PlaybookStepDetail } from "../src/ui/settings/PlaybookStepDetail";
import { PlaybookTurnPart } from "../src/ui/settings/PlaybookTurnPart";

const PARTS = ["board", "narrow"] as const;
type Part = (typeof PARTS)[number];

export default function SettingsPlaybooks() {
  const part = signal<Part>("board");
  const log = signal("");
  const probe = signal("");
  const shown = signal("general");
  const selected = signal<PlaybookNodeId>("reader");
  const draft = signal<CustomStep | null>(null);
  const historyOf = signal<string | null>(null);

  const playbooks = new Playbooks(() => runtime.client);
  effect(() => {
    // Read every dependency before any early return: an effect tracks only what it read.
    const connected = runtime.connection === "connected";
    void runtime.client;
    void runtime.playbooksRevision;
    if (connected) void playbooks.load();
  });

  const shownId = () => (playbooks.find(shown()) ? shown() : playbooks.defaultId);
  const allOn: Playbook = { id: "general", builtin: true, base_id: "general", name: null, revision: 0, revision_id: null, diff: emptyPlaybookDiff(), resolved: playbookDefaults(), updated_at: null };
  const current = () => playbooks.find(shownId()) ?? (playbooks.failed ? allOn : null);
  const builtin = () => {
    const now = current();
    return now && !playbooks.failed ? builtinPlaybook(now.base_id as BuiltinPlaybookId) : playbookDefaults();
  };
  const engineName = () => playbookName(current() ?? undefined, copy().playbooks.builtin);
  const own = () => current()?.custom_steps ?? [];
  const ownShown = () => own().find((step) => step.id === selected()) ?? null;
  const draftShown = () => (draft() && draft()!.id === selected() ? draft() : null);
  /** The moment of the step of your own last shown: a deleted one is gone from the list by the time the page leaves it. */
  let lastAt: CustomStep["at"] = "turn_end";
  effect(() => {
    const mine = ownShown() ?? draftShown();
    if (mine) lastAt = mine.at;
  });

  /** What a call shows on the map: the reader has a model of its own, the rest follow the default. */
  const viewOf = (role: BuiltinModelRole): RoutingNodeView => ({
    role,
    model: role === "reader" ? "fixture-model" : null,
    follows: "default",
    choosable: true,
    prompts: [],
    edited: 0,
    conflict: false,
    failures: 0,
  });

  function show(id: string): void {
    shown.set(id);
    draft.set(null);
    historyOf.set(null);
    selected.set("reader");
  }

  function pick(node: PlaybookNodeId): void {
    selected.set(node);
    historyOf.set(null);
    if (draft() && draft()!.id !== node) draft.set(null);
  }

  function startDraft(step: CustomStep): void {
    draft.set(step);
    selected.set(step.id as PlaybookNodeId);
    historyOf.set(null);
  }

  function leaveOwn(at: CustomStep["at"]): void {
    const hook = hookOfMoment(at);
    selected.set(hook === "turn" ? "turn" : (PLAYBOOK_ROUNDS.find((round) => round.hook === hook)?.steps[0] ?? "turn"));
  }

  const makeDefault = (id: string) => {
    log.set(`default:${id}`);
    void runtime.patchSettings({ default_playbook: id }).then(() => playbooks.load());
  };

  /** What the daemon holds, read back by a GET of the story's own. */
  const read = async () => {
    const api = runtime.client;
    if (!api) return;
    try {
      const list = await api.listPlaybooks();
      probe.set(
        JSON.stringify({
          default: list.default_id,
          items: list.items.map((item) => ({
            id: item.id,
            name: item.name,
            builtin: item.builtin,
            revision: item.revision,
            base: item.base_id,
            diff: item.diff,
            own: (item.custom_steps ?? []).map((step) => ({ name: step.name, on: step.on, at: step.at, then: step.then, kind: step.run.kind })),
          })),
        }),
      );
    } catch (error) {
      probe.set(`error:${String(error)}`);
    }
  };

  /** Puts back what a test changed: the engines of your own go, the built-ins are reset, `general` is the default again. */
  const cleanup = async () => {
    const api = runtime.client;
    if (!api) return;
    try {
      await runtime.patchSettings({ default_playbook: "general" });
      let list = await api.listPlaybooks();
      for (const item of list.items) if (!item.builtin) await api.deletePlaybook(item.id).catch(() => null);
      list = await api.listPlaybooks();
      for (const item of list.items) if (item.revision > 0) await api.resetPlaybook(item.id, null, item.revision_id).catch(() => null);
      await playbooks.load();
      show("general");
      log.set("cleaned");
    } catch (error) {
      log.set(`cleanup-error:${String(error)}`);
    }
  };

  const button = (id: string, label: string, run: () => void, on?: boolean) => (
    <View role="button" testID={id} onPress={run} class={`px-2 py-1 border rounded-(--radius-sm) ${on ? "border-brand" : "border-line"}`}>
      <Text class="text-[12px] text-ink">{label}</Text>
    </View>
  );

  const callPart = () => <Text testID="story-call" class="text-[12px] text-ink-muted">{`call:${isCustomNode(selected()) ? "custom_step" : (stepRole(selected()) ?? "none")}`}</Text>;

  /** The picked node's panel: the Bot's turn, a step of your own, or a built-in step. */
  const detail = () => (
    <If when={current()}>
      {(now) => (
        <>
          <If when={historyOf() === now().id}>
            <PlaybookHistory playbooks={playbooks} playbook={now()} name={engineName()} onclose={() => historyOf.set(null)} />
          </If>
          <If when={historyOf() !== now().id}>
            <If when={selected() === "turn"}>
              <View testID="story-turn" class="gap-2 p-[14px] bg-pane border border-line rounded-(--radius-md)">
                <Text class="text-[14px] font-semibold text-ink">{copy().playbooks.hooks.turn}</Text>
                <PlaybookTurnPart playbook={now()} locale={runtime.snapshot.settings.locale === "en" ? "en" : "zh"} api={runtime.client} onsave={(diff) => playbooks.save(now().id, diff)} saving={playbooks.saving} error={playbooks.error} />
              </View>
            </If>
            <If when={selected() !== "turn" && isCustomNode(selected()) ? (ownShown() ?? draftShown()) : null}>
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
            <If when={selected() !== "turn" && !isCustomNode(selected())}>
              <PlaybookStepDetail
                step={selected() as never}
                playbook={now()}
                builtin={builtin()}
                engineName={engineName()}
                onsave={(diff) => void playbooks.save(now().id, diff)}
                onreset={(step) => void playbooks.reset(now().id, step)}
                saving={playbooks.saving || playbooks.failed}
                error={playbooks.error}
                callHint={stepRole(selected()) ? copy().builtinModels.roles[stepRole(selected())!].hint : null}
                call={stepRole(selected()) ? callPart() : undefined}
              />
            </If>
          </If>
        </>
      )}
    </If>
  );

  const map = () => (
    <If when={current()}>
      {(now) => (
        <PlaybookMap
          resolved={now().resolved}
          builtin={builtin()}
          viewOf={viewOf}
          turnModel={copy().routing.turn.model}
          selected={selected()}
          onpick={pick}
          own={own()}
          onadd={playbooks.failed ? undefined : startDraft}
        />
      )}
    </If>
  );

  return (
    <View testID="settings-playbooks" class="flex-1 bg-bg">
      <View class="flex-row flex-wrap items-center gap-2 p-3 border-b border-line">
        {PARTS.map((name) => button(`story-show-${name}`, name, () => part.set(name), part() === name))}
        {button("story-read", "read", () => void read())}
        {button("story-cleanup", "cleanup", () => void cleanup())}
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log()}`}</Text>
        <Text testID="story-shown" class="text-[12px] text-ink-muted">{`shown:${shownId()}`}</Text>
        <Text testID="story-selected" class="text-[12px] text-ink-muted">{`selected:${selected()}`}</Text>
      </View>
      <Text testID="story-probe" class="px-3 py-1 text-[10px] text-ink-muted">{`probe:${probe()}`}</Text>
      <If when={part() === "board"}>
        <View class="flex-1 min-h-0 flex-row gap-4 p-4">
          <Scroll class="w-[260px] shrink-0">
            <If when={playbooks.list}>
              <PlaybookList playbooks={playbooks} shown={shownId()} onshow={show} onmakedefault={makeDefault} onhistory={(id) => (show(id), historyOf.set(id))} locale={runtime.snapshot.settings.locale === "en" ? "en" : "zh"} />
            </If>
          </Scroll>
          <Scroll class="flex-1 min-w-0">
            <View class="gap-4">{map()}</View>
          </Scroll>
          <Scroll class="w-[380px] shrink-0">{detail()}</Scroll>
        </View>
      </If>
      <If when={part() === "narrow"}>
        <Scroll class="flex-1 min-h-0">
          <View class="gap-3 p-4">
            <If when={playbooks.list}>
              <PlaybookHeader playbooks={playbooks} shown={shownId()} onshow={show} onmakedefault={makeDefault} />
            </If>
            {map()}
            {detail()}
          </View>
        </Scroll>
      </If>
    </View>
  );
}
