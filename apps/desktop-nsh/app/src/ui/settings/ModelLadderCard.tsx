/**
 * The model ladder's own page (ADR 0054; `settings/ModelLadderCard.svelte`): the models a Bot's turn
 * climbs when one fails, weakest first, each a rung on a rail whose colour deepens up the ladder. A
 * rung is moved by its grip (dragged, or the arrow keys while the grip has the focus), taken off by
 * its ×, and an agent's rung (ADR 0076, ADR 0079) is tuned as Agent settings tune a Bot: its effort
 * where the agent takes one, and the account it spends. A model is added from a picker over the
 * endpoints, Claude Code's models and the other agents' (typed in where an agent lists none).
 *
 * Props: `ladder` (read and saved by its owner); `providers`; `claudeCode` / `agents` (what the
 * daemon finds; absent or failing, none are offered); `claudeModels` (asks Claude Code for its model
 * list per account). Test ids: `model-ladder`, `ladder-error`, `ladder-empty`, `ladder-scale`,
 * `ladder-rung-<model>`, `ladder-step-<model>`, `ladder-name-<model>`, `ladder-provider-<model>`,
 * `ladder-effort-<model>`, `ladder-account-<model>`, `ladder-remove-<model>`, `ladder-grip-<model>`,
 * `ladder-add` (the picker).
 *
 * Differently from the Svelte: the drag is a `PanResponder` on the grip (a drag by the grip, touch
 * included, takes no scroll) reading each rung's place from its layout, with the rungs making room as
 * they did; Escape puts the rung back. Rungs do not slide (`animate:flip`) to their new places; the
 * rail between two rungs is a gradient view; "container query" for the pickers' line is the list's
 * own measured width (560).
 */
import {
  AGENT_KINDS,
  isLadderAgentRung,
  MODEL_LADDER_MAX,
  sameLadderRung,
  type AgentsStatusResponse,
  type BotRunner,
  type ClaudeCodeStatus,
  type ModelLadderAgentRung,
  type ModelLadderRung,
  type Provider,
} from "@real-bot/protocol";
import { colorScheme, effect, keymap, PanResponder, signal, Text, token, untracked, View } from "nsh";
import { copy } from "../../runtime";
import { thinkingLevelLabel } from "../../m/copy.ts";
import { claudeModelOptions, claudeModelsOf, effortChoices, loadClaudeModels } from "../../m/claude-models.svelte.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { sourceCount, type PickerData } from "../../m/model-picker.ts";
import { agentPickerSources, claudePickerSource, endpointPickerSources } from "../../m/model-picker-sources.ts";
import { endpointSource, runnerSource } from "../../m/model-source.ts";
import { agentAccountOptions, agentAccountsOf, agentLabelOf, agentModelsOf, agentStatusOf } from "../../m/runner-choice.ts";
import { claudeAccountOptions, claudeReady } from "../../m/settings/claude-agent.ts";
import { ladderPlace, ladderSlot, movedTo, type LadderDrag } from "../../m/settings/ladder-drag.ts";
import type { ModelLadder } from "../../m/settings/model-ladder.svelte.ts";
import { Icon } from "../Icon";
import { ModelPicker } from "../ModelPicker";
import { ModelSourceMark } from "../ModelSourceMark";
import { Select } from "../Select";
import { shadow } from "../styles";
import { tip } from "../tip";
import { mixColors } from "../spend/spend-style";
import { widthAtMost } from "../../platform/viewport";

/** How far a press moves before it is a drag rather than a press on the grip. */
const DRAG_PX = 4;
const GAP = 8;

/** The rung's colour at `strength` percent up the ladder: a pale wash of the accent to the accent itself. */
export function rungColor(strength: number): string {
  const strong = String(token("brand"));
  const weak = mixColors(strong, String(token("pane")), 22);
  return mixColors(strong, weak, strength);
}

export function ModelLadderCard(props: {
  ladder: ModelLadder;
  providers: readonly Provider[];
  claudeCode?: (() => Promise<ClaudeCodeStatus>) | null;
  agents?: (() => Promise<AgentsStatusResponse>) | null;
  claudeModels?: Pick<MessengerApi, "claudeCodeModels"> | null;
}) {
  const t = () => copy();
  const ladder = props.ladder;
  const phone = () => widthAtMost(720);

  const claudeStatus = signal<ClaudeCodeStatus | null>(null);
  const agentsFound = signal<AgentsStatusResponse | null>(null);
  void props.claudeCode?.().then(
    (status) => claudeStatus.set(status),
    () => claudeStatus.set(null),
  );
  if (props.agents) {
    const ask = props.agents;
    // Called inside the try: a client that has no such call (an older Mac, a fake) fails as an answer does.
    void (async () => {
      try {
        agentsFound.set(await ask());
      } catch {
        agentsFound.set(null);
      }
    })();
  }

  /** The rung being dragged and where it would land; the others make room while it is held. */
  const drag = signal<LadderDrag | null>(null);
  /** The list's width, which decides where an agent rung's pickers sit. */
  const listWidth = signal(0);
  /** Each rung's place in the list, by its key, as laid out. */
  const boxes = new Map<string, { y: number; height: number }>();
  /** Bumped as rungs are laid out, so the rail between two follows their height. */
  const laidOut = signal(0);

  const key = (rung: ModelLadderRung) =>
    JSON.stringify(
      isLadderAgentRung(rung)
        ? { runner: rung.runner, model: rung.model, effort: rung.effort, config_dir: rung.config_dir, ...(rung.custom_id ? { custom_id: rung.custom_id } : {}) }
        : { provider_id: rung.provider_id, model: rung.model },
    );
  const providerOf = (id: string) => props.providers.find((provider) => provider.id === id);
  const providerName = (id: string) => providerOf(id)?.name ?? id;
  /** Whose a rung is: Claude Agent, or the other agent's name (your own ACP agent by the name you gave it). */
  const agentName = (rung: ModelLadderAgentRung) => (rung.runner === "claude_code" ? t().claudeAgent.title : agentLabelOf(rung.runner, rung.custom_id ?? null, agentsFound()));
  const named = (rung: ModelLadderRung) =>
    isLadderAgentRung(rung) ? `${rung.model} · ${agentName(rung)}` : props.providers.length > 1 ? `${rung.model} · ${providerName(rung.provider_id)}` : rung.model;

  /** Agent models are added at the agent's default effort, on this computer's default account; each rung then picks its own. */
  const agentRung = (runner: BotRunner, model: string, customId: string | null = null): ModelLadderAgentRung => ({
    runner,
    model,
    effort: null,
    config_dir: null,
    ...(customId ? { custom_id: customId } : {}),
  });
  const claudeRung = (model: string) => agentRung("claude_code", model);
  const onLadder = (rung: ModelLadderRung) => ladder.rungs.some((kept) => sameLadderRung(kept, rung));

  /** What the agents list, else the default model one named: the models a rung can be. */
  const agentsOffered = (): AgentsStatusResponse | null => {
    const found = agentsFound();
    return found ? { ...found, items: found.items.map((status) => ({ ...status, models: agentModelsOf(status) })) } : null;
  };

  // This computer's account's list for what to add, and each Claude rung's own account's for its levels.
  effect(() => {
    const source = props.claudeModels ?? null;
    if (!claudeReady(claudeStatus())) return;
    const dirs = new Set<string | null>([null, ...ladder.rungs.filter(isLadderAgentRung).filter((rung) => rung.runner === "claude_code").map((rung) => rung.config_dir ?? null)]);
    untracked(() => dirs.forEach((dir) => loadClaudeModels(source, dir)));
  });

  /**
   * What is listed and not on the ladder yet: each endpoint, then the Claude models Agent settings
   * offer, then each other agent found and signed in, which also takes a model typed into the
   * search. A source with nothing left to add is left out.
   */
  const addable = (): PickerData => {
    const claudeAddable = claudeModelOptions(claudeModelsOf(null)).filter((model) => !onLadder(claudeRung(model.value)));
    const sources = [
      ...endpointPickerSources(
        props.providers,
        t(),
        (provider_id, model) => key({ provider_id, model }),
        (provider_id, model) => !onLadder({ provider_id, model }),
      ),
      ...(claudeReady(claudeStatus()) && claudeAddable.length > 0 ? [claudePickerSource(t(), (model) => key(claudeRung(model)), claudeAddable)] : []),
      ...agentPickerSources(agentsOffered(), t(), (runner, model, customId) => key(agentRung(runner, model, customId)), {
        typed: true,
        keep: (runner, model, customId) => !onLadder(agentRung(runner, model, customId)),
      }),
    ];
    return { specials: [], sources: sources.filter((source) => sourceCount(source) > 0 || source.custom) };
  };

  /**
   * The effort levels a rung takes: a Claude rung's model's, as Claude Code lists it for the rung's
   * account, another agent's own; none for one that has none. A level set already stays, so it reads.
   */
  const rungEfforts = (rung: ModelLadderAgentRung): readonly string[] => {
    if (rung.runner !== "claude_code") return AGENT_KINDS[rung.runner].efforts;
    const levels: string[] = [...effortChoices(claudeModelsOf(rung.config_dir ?? null), rung.model)];
    return rung.effort && !levels.includes(rung.effort) ? [...levels, rung.effort] : levels;
  };
  const effortOptions = (rung: ModelLadderAgentRung) => [
    { value: "", label: t().modelLadder.effort(t().sidebar.botAgentEffortDefault) },
    ...rungEfforts(rung).map((level) => ({ value: level, label: t().modelLadder.effort(thinkingLevelLabel(t().sidebar.thinkingLevels, level)) })),
  ];
  /**
   * The accounts a rung can spend, named short enough to sit beside its effort: this computer's
   * default, else the account's email (Claude) or what it signs in with (the others), its directory
   * when there is none.
   */
  const accountOptions = (rung: ModelLadderAgentRung) => {
    const current = rung.config_dir ?? "";
    if (rung.runner !== "claude_code") return agentAccountOptions(agentStatusOf(agentsFound(), rung.runner, rung.custom_id ?? null), current, t());
    return claudeAccountOptions(claudeStatus(), current, t()).map((option) => ({
      value: option.value,
      label: option.value ? (claudeStatus()?.accounts?.find((account) => account.config_dir === option.value)?.email ?? option.value) : t().sidebar.botAgentAccountDefault,
    }));
  };
  /** An account is picked per rung only when there is more than one, or the rung is on one already. */
  const accountsShown = (rung: ModelLadderAgentRung) =>
    (rung.runner === "claude_code" ? (claudeStatus()?.accounts?.length ?? 0) : agentAccountsOf(agentStatusOf(agentsFound(), rung.runner, rung.custom_id ?? null)).length) > 1 || Boolean(rung.config_dir);

  /** An agent rung's effort or account changed: the ladder is saved with it in its place. */
  function retune(index: number, change: Partial<Pick<ModelLadderAgentRung, "effort" | "config_dir">>): void {
    const rung = ladder.rungs[index];
    if (ladder.busy || !rung || !isLadderAgentRung(rung)) return;
    void ladder.save(ladder.rungs.map((kept, at) => (at === index ? { ...rung, ...change } : kept)));
  }

  /** Where a rung stands now, counting the place a held rung would land in. */
  const placeOf = (index: number) => {
    const held = drag();
    return held ? ladderPlace(index, held.from, held.slot) : index;
  };
  /** How far up the ladder a place is, 0 at the weakest and 100 at the strongest: the rung's colour. */
  const strength = (place: number) => (ladder.rungs.length > 1 ? Math.round((place / (ladder.rungs.length - 1)) * 100) : 100);
  const offsetOf = (index: number) => {
    const held = drag();
    return !held ? 0 : index === held.from ? held.dy : (placeOf(index) - index) * held.shift;
  };

  function reorder(from: number, slot: number): void {
    if (ladder.busy || from === slot || slot < 0 || slot >= ladder.rungs.length) return;
    void ladder.save(movedTo(ladder.rungs.slice(), from, slot));
  }

  /** The grip that has the keyboard focus: ↑ and ↓ move its rung. */
  const gripFocus = signal<number | null>(null);
  effect(() => {
    const at = gripFocus();
    if (at === null) return;
    const move = (by: number) => {
      // The focus stays on the grip: the rung's view is kept by its key as the list reorders.
      const to = at + by;
      if (ladder.busy || to < 0 || to >= ladder.rungs.length) return;
      reorder(at, to);
      gripFocus.set(to);
    };
    const off = [keymap.bind("up", () => move(-1), { when: "always" }), keymap.bind("down", () => move(1), { when: "always" })];
    return () => off.forEach((fn) => fn());
  });

  /** A drag by a rung's grip: its middle follows the pointer between the first rung's top and the last one's bottom. */
  function gripPan(index: () => number) {
    let cancelled = false;
    let off: (() => void) | null = null;
    let started = false;
    const metrics = () => {
      const rungs = ladder.rungs.slice();
      const rows = rungs.map((rung) => boxes.get(key(rung)));
      return rows.every((row) => row !== undefined) ? (rows as { y: number; height: number }[]) : null;
    };
    const finish = () => {
      off?.();
      off = null;
      started = false;
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => !ladder.busy && Math.hypot(g.dx, g.dy) >= DRAG_PX && metrics() !== null,
      onPanResponderGrant: () => {
        cancelled = false;
        started = true;
        // Escape puts the rung back.
        off = keymap.bind(
          "escape",
          () => {
            cancelled = true;
            drag.set(null);
          },
          { when: "always" },
        );
      },
      onPanResponderMove: (_e, g) => {
        const rows = metrics();
        if (!rows || cancelled) return;
        const from = index();
        const own = rows[from]!;
        const middles = rows.map((row) => row.y + row.height / 2);
        const lowest = rows[0]!.y - own.y;
        const highest = rows[rows.length - 1]!.y + rows[rows.length - 1]!.height - (own.y + own.height);
        const dy = Math.min(highest, Math.max(lowest, g.dy));
        drag.set({ from, slot: ladderSlot(middles, from, middles[from]! + dy), dy, shift: own.height + GAP });
      },
      onPanResponderRelease: () => {
        const landed = drag();
        drag.set(null);
        const was = started;
        finish();
        if (!was || cancelled || !landed) return;
        reorder(landed.from, landed.slot);
      },
      onPanResponderTerminate: () => {
        drag.set(null);
        finish();
      },
    });
  }

  /** The add picker's choice; the picker is made again once added, back to its placeholder. */
  const pickerEpoch = signal(0);
  function add(value: string): void {
    pickerEpoch.set(pickerEpoch() + 1);
    if (!value) return;
    const rung = JSON.parse(value) as ModelLadderRung;
    // A name typed into the search can be one already on the ladder.
    if (onLadder(rung)) return;
    void ladder.save([...ladder.rungs, rung]);
  }

  const mutedText = "text-[12px] leading-[1.45] text-ink-muted";
  const wide = () => listWidth() > 560;

  const row = (rung: ModelLadderRung, index: () => number) => {
    const agent = () => (isLadderAgentRung(rung) ? rung : null);
    const provider = isLadderAgentRung(rung) ? undefined : providerOf(rung.provider_id);
    const pan = gripPan(index);
    const dragging = () => drag() !== null;
    const held = () => drag()?.from === index();
    const last = () => index() === ladder.rungs.length - 1;
    const deep = () => strength(placeOf(index())) > 60;
    const deepest = () => strength(placeOf(index())) > 80;
    const numberInk = () => (deepest() || (colorScheme() === "dark" && deep()) ? "text-on-accent" : "text-ink");
    const efforts = () => (agent() ? rungEfforts(agent()!) : []);
    const tuned = () => agent() !== null && (efforts().length > 0 || accountsShown(agent()!));
    const tune = () => (
      <View testID={`ladder-tune-${rung.model}`} class={`flex-row gap-[6px] min-w-0 ${wide() ? "ml-[6px]" : "w-full flex-wrap pt-1 pb-[2px]"}`}>
        <If when={efforts().length > 0}>
          <Select
            testID={`ladder-effort-${rung.model}`}
            value={agent()!.effort ?? ""}
            options={effortOptions(agent()!)}
            size="sm"
            ariaLabel={t().modelLadder.effortOf(rung.model)}
            disabled={ladder.busy}
            onChange={(value) => retune(index(), { effort: value || null })}
            class={wide() ? "" : "flex-1"}
          />
        </If>
        <If when={accountsShown(agent()!)}>
          <Select
            testID={`ladder-account-${rung.model}`}
            value={agent()!.config_dir ?? ""}
            options={accountOptions(agent()!)}
            size="sm"
            ariaLabel={t().modelLadder.accountOf(rung.model)}
            disabled={ladder.busy}
            onChange={(value) => retune(index(), { config_dir: value || null })}
            class={wide() ? "" : "flex-1"}
          />
        </If>
      </View>
    );
    const buttonClass = `items-center justify-center rounded-(--radius-sm) hover:bg-row-hover ${phone() ? "w-[34px] h-[38px]" : "w-[30px] h-[30px]"}`;
    return (
      <View
        testID={`ladder-rung-${rung.model}`}
        accessibilityState={{ selected: held() }}
        onLayout={(e) => {
          boxes.set(key(rung), { y: e.bounds.origin.y, height: e.bounds.size.height });
          laidOut.set(laidOut() + 1);
        }}
        class={`flex-row items-start min-w-0 ${phone() ? "gap-2" : "gap-[10px]"}`}
        style={{ transform: dragging() ? `translateY(${offsetOf(index())}px)` : undefined, zIndex: held() ? 1 : 0 }}
      >
        {/* The rail from this node to the next, shading on towards it; it would bend while a rung is held. */}
        <If when={!last() && !dragging()}>
          <View
            class="absolute w-[3px] rounded-[2px]"
            style={{
              left: 10,
              top: 27,
              height: (laidOut() >= 0 ? (boxes.get(key(rung))?.height ?? 54) : 0) + GAP,
              backgroundImage: `linear-gradient(${rungColor(strength(placeOf(index())))}, ${rungColor(strength(placeOf(index()) + 1))})`,
            }}
          />
        </If>
        <View
          testID={`ladder-step-${rung.model}`}
          class="relative items-center justify-center w-[23px] h-[23px] rounded-full shrink-0"
          style={{ marginTop: 27 - 11.5, backgroundColor: rungColor(strength(placeOf(index()))) }}
        >
          <Text class={`text-[11px] font-bold ${numberInk()}`}>{String(placeOf(index()) + 1)}</Text>
        </View>
        <View
          class={`flex-1 min-w-0 flex-col gap-[2px] bg-pane border rounded-(--radius-md) pl-3 pr-[4px] py-[7px] ${held() ? "border-accent-border" : "border-line"} ${phone() ? "pl-[10px] pr-[2px]" : ""}`}
          style={{ boxShadow: held() ? shadow("md") : undefined }}
        >
          <View class="flex-row items-center gap-[6px] min-w-0">
            <View class="flex-1 min-w-0 flex-col gap-[2px]" tooltip={tip(named(rung))}>
              <Text testID={`ladder-name-${rung.model}`} class={`font-mono text-ink leading-[1.35] ${phone() ? "text-[13px]" : "text-[12.5px]"}`}>
                {rung.model}
              </Text>
              <View class="flex-row items-center gap-[6px] min-w-0">
                <If when={agent()} else={<If when={provider}>{(found) => <ModelSourceMark source={endpointSource(found(), t())} />}</If>}>
                  {(own) => <ModelSourceMark source={runnerSource(own().runner, agentName(own()), t())} />}
                </If>
                <If when={agent()} else={<If when={props.providers.length > 1 && !isLadderAgentRung(rung)}><Text testID={`ladder-provider-${rung.model}`} class={`${mutedText} line-clamp-1 min-w-0`}>{providerName((rung as { provider_id: string }).provider_id)}</Text></If>}>
                  {(own) => (
                    <Text testID={`ladder-provider-${rung.model}`} class={`${mutedText} line-clamp-1 min-w-0`}>
                      {agentName(own())}
                    </Text>
                  )}
                </If>
              </View>
            </View>
            <If when={tuned() && wide()}>{tune()}</If>
            <View
              role="button"
              testID={`ladder-remove-${rung.model}`}
              accessibilityLabel={t().modelLadder.remove(rung.model)}
              tooltip={tip(t().modelLadder.remove(rung.model))}
              disabled={ladder.busy}
              onPress={() => void ladder.save(ladder.rungs.filter((_, at) => at !== index()))}
              class={`cursor-pointer select-none disabled:cursor-default ${buttonClass} disabled:opacity-[0.4]`}
            >
              <Text class={`text-ink-muted ${phone() ? "text-[18px]" : "text-[16px]"}`}>×</Text>
            </View>
            {/* Not disabled while a save is out: the arrow keys would lose the focus they move with. */}
            <View
              role="button"
              focusable
              testID={`ladder-grip-${rung.model}`}
              accessibilityLabel={t().modelLadder.move(rung.model)}
              accessibilityState={{ disabled: ladder.busy }}
              tooltip={tip(t().modelLadder.move(rung.model))}
              onPress={() => gripFocus.set(index())}
              onFocus={() => gripFocus.set(index())}
              onBlur={() => untracked(() => gripFocus() === index() && gripFocus.set(null))}
              class={`cursor-grab select-none ${buttonClass}`}
              {...pan.panHandlers}
            >
              <Icon name="grip" size={12} filled class={held() ? "tint-brand" : "tint-ink-muted"} />
            </View>
          </View>
          <If when={tuned() && !wide()}>{tune()}</If>
        </View>
      </View>
    );
  };

  return (
    <If when={ladder.available}>
      <View
        role="region"
        testID="model-ladder"
        accessibilityLabel={t().modelLadder.title}
        class={`flex-col gap-[10px] bg-pane border border-line rounded-(--radius-md) min-w-0 ${phone() ? "p-3" : "px-[14px] py-3"}`}
        style={{ boxShadow: phone() ? undefined : shadow("xs") }}
      >
        <If when={ladder.failed}>
          <Text role="alert" testID="ladder-error" class="text-[12px] text-danger-text">
            {t().modelLadder.failed}
          </Text>
        </If>
        <If when={ladder.rungs.length > 0} else={<Text testID="ladder-empty" class={mutedText}>{t().modelLadder.empty}</Text>}>
          {/* The colours' legend: words too, since a colour alone says nothing to some. */}
          <If when={ladder.rungs.length > 1}>
            <View testID="ladder-scale" accessible={false} class="flex-row items-center gap-2 max-w-[240px]">
              <Text class="text-[11px] text-ink-muted">{t().modelLadder.weaker}</Text>
              <View
                class="flex-1 h-1 rounded-[2px]"
                style={{ backgroundImage: `linear-gradient(to right, ${rungColor(0)}, ${rungColor(100)})` }}
              />
              <Text class="text-[11px] text-ink-muted">{t().modelLadder.stronger}</Text>
            </View>
          </If>
          <View class="flex-col min-w-0" style={{ gap: GAP }} onLayout={(e) => listWidth.set(e.bounds.size.width)}>
            <Each of={ladder.rungs.slice()} key={(rung) => key(rung)}>
              {(rung, index) => row(rung(), index)}
            </Each>
          </View>
        </If>
        <If when={addable().sources.length > 0 && ladder.rungs.length < MODEL_LADDER_MAX}>
          <View class={phone() ? "" : "max-w-[320px]"}>
            <Each of={[pickerEpoch()]} key={(epoch) => epoch}>
              {() => (
                <ModelPicker
                  testID="ladder-add"
                  data={addable()}
                  placeholder={t().modelLadder.add}
                  size="sm"
                  title={t().modelLadder.add}
                  ariaLabel={t().modelLadder.add}
                  disabled={ladder.busy}
                  onChange={add}
                />
              )}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}
