/**
 * One engine on Roles (`settings/PlaybookMap.svelte`, ADR 0085), drawn as the flow board draws a
 * job: a round per thing that sets steps off, its root card on top and the steps it sets off under
 * it, each a small card saying what it runs on now. A step that is off is dashed and dim, one that
 * always runs has a lock, one changed from its built-in a dot; a call's prompt conflict or unread
 * answers a warning. The steps of your own (ADR 0105) hang in the round of their moment after the
 * built-in ones, marked as yours, each round ending in a card that adds another.
 *
 * The cards are views placed by `layPlaybookFlow`; the curves between them are one `Canvas` under
 * them (the Svelte drew SVG paths). The board scrolls sideways when the layout is wider than the box.
 *
 * Props: `resolved`; `builtin`; `viewOf(role)`; `turnModel`; `selected`; `onpick(node)`; `own`;
 * `onadd(draft)` (absent: no add cards). Test ids: `playbook-node-<id>` (`turn`, a step, a step of
 * your own), `playbook-said-<id>` (the line under the name), `playbook-changed-<step>`,
 * `playbook-locked-<step>`, `playbook-round-<hook>`, `playbook-add-<hook>`.
 */
import { CUSTOM_STEPS_MAX, playbookStep, type CustomStep, type CustomStepView, type PlaybookHook, type PlaybookResolved, type PlaybookStepId } from "@real-bot/protocol";
import { Canvas, computed, Path2D, Scroll, signal, Text, token, untracked, View, type CanvasRenderingContext2D, type ViewRef } from "nsh";
import { copy } from "../../runtime";
import { isCustomNode, layPlaybookFlow, paramText, stepDiffers, stepLocked, stepRole, type PlaybookCard, type PlaybookNodeId } from "../../m/settings/playbook-flow.ts";
import type { RoutingNodeView } from "../../m/settings/routing-map.ts";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { PlaybookAddMenu } from "./PlaybookAddMenu";

export function PlaybookMap(props: {
  resolved: PlaybookResolved;
  builtin: PlaybookResolved;
  viewOf: (role: NonNullable<ReturnType<typeof stepRole>>) => RoutingNodeView;
  /** What a Bot's turn runs on: its own model, or the ladder. */
  turnModel: string;
  selected: PlaybookNodeId | null;
  onpick: (node: PlaybookNodeId) => void;
  /** The engine's steps of your own. */
  own?: readonly CustomStepView[];
  /** A draft is started from the add card's menu; absent, the map has no add cards. */
  onadd?: (draft: CustomStep) => void;
}) {
  const c = () => copy().playbooks;
  const own = () => props.own ?? [];
  const width = signal(0);
  const layout = computed(() => layPlaybookFlow(width() || 360, own(), props.onadd !== undefined));
  const ownById = () => new Map(own().map((step) => [step.id as string, step]));
  /** The add card whose menu is open. */
  const menu = signal<{ hook: PlaybookHook; anchor: ViewRef | null } | null>(null);
  const addRefs = new Map<PlaybookHook, ViewRef>();

  /** Why a step of your own does not run, when it does not. */
  function ownOff(step: CustomStepView): string | null {
    if (!step.on) return c().own.off;
    return step.running ? null : c().own.noJobs;
  }

  function ownSaid(step: CustomStepView): string {
    return `${c().own.moments[step.at]} · ${c().own.cardNo[step.then]}`;
  }

  function edgeOff(to: string): boolean {
    if (to === "turn") return false;
    const mine = ownById().get(to);
    return mine ? ownOff(mine) !== null : !props.resolved[to as PlaybookStepId]?.on;
  }

  /** A step's line under its name: off, else its model, else its first number. */
  function said(step: PlaybookStepId): string {
    const setting = props.resolved[step];
    if (!setting.on) return c().offShort;
    const role = stepRole(step);
    if (role) {
      const view = props.viewOf(role);
      return view.model ?? copy().routing.follows[view.follows];
    }
    const first = playbookStep(step).params[0];
    return first ? paramText(first, setting.params[first.key]!, c().unit) : c().on;
  }

  function warned(step: PlaybookStepId): boolean {
    const role = stepRole(step);
    if (!role) return false;
    const view = props.viewOf(role);
    return view.conflict || view.failures > 0;
  }

  const frame = (card: PlaybookCard) => ({ left: card.x, top: card.y, width: card.w, height: card.h });
  // Each card is passed by accessor: the layout follows the map's width, and a card read once was made
  // again (its icons and all) on every pixel a divider moved; now only its frame follows.
  const base = "absolute justify-center gap-[2px] px-[10px] py-[6px] border rounded-(--radius-md) min-w-0";
  const title = "flex-1 min-w-0 text-[12px] font-semibold text-ink line-clamp-1";
  const saidClass = "w-full text-[11px] text-ink-muted line-clamp-1";
  const pickedStyle = (on: boolean) => (on ? { boxShadow: `0 0 0 1px ${token("brand")}` } : undefined);

  const addCard = (card: () => PlaybookCard) => (
    <View
      role="button"
      testID={`playbook-add-${card().hook}`}
      ref={(node: ViewRef) => addRefs.set(card().hook, node)}
      accessibilityLabel={c().own.add}
      accessibilityState={{ expanded: menu()?.hook === card().hook }}
      onPress={() => menu.set(menu()?.hook === card().hook ? null : { hook: card().hook, anchor: addRefs.get(card().hook) ?? null })}
      class={`${base} group items-center border-dotted border-line hover:bg-line-subtle`}
      style={frame(card())}
    >
      <View class="flex-row items-center gap-1">
        <Icon name="plus" size={12} class="tint-ink-muted group-hover:tint-ink" />
        <Text class="text-[12px] font-medium text-ink-muted group-hover:text-ink">{c().own.add}</Text>
      </View>
    </View>
  );

  const turnCard = (card: () => PlaybookCard) => (
    <View
      role="button"
      testID="playbook-node-turn"
      accessibilityLabel={c().hooks.turn}
      accessibilityState={{ pressed: props.selected === "turn" }}
      onPress={() => props.onpick("turn")}
      class={`${base} items-center bg-chip border-dashed hover:bg-line-subtle ${props.selected === "turn" ? "border-brand" : "border-line"}`}
      style={{ ...frame(card()), ...pickedStyle(props.selected === "turn") }}
    >
      <Text testID="playbook-round-turn" class="text-[12px] font-semibold text-ink line-clamp-1">{c().hooks.turn}</Text>
      <Text testID="playbook-said-turn" class="text-[11px] text-ink-muted line-clamp-1">{props.turnModel}</Text>
    </View>
  );

  const rootCard = (card: () => PlaybookCard) => (
    <View testID={`playbook-round-${card().hook}`} class={`${base} items-center bg-chip border-line`} style={frame(card())}>
      <Text class="text-[12px] font-semibold text-ink line-clamp-1">{c().hooks[card().hook]!}</Text>
    </View>
  );

  const ownCard = (card: () => PlaybookCard, mine: () => CustomStepView) => {
    const why = () => ownOff(mine());
    const id = untracked(mine).id as PlaybookNodeId;
    return (
      <View
        role="button"
        testID={`playbook-node-${id}`}
        accessibilityLabel={mine().name}
        accessibilityState={{ pressed: props.selected === id }}
        tooltip={tip(why() ?? c().own.mineTitle)}
        onPress={() => props.onpick(id)}
        class={`${base} border-dashed hover:bg-line-subtle bg-pane ${props.selected === id ? "border-brand" : "border-line"} ${why() !== null ? "opacity-[0.55]" : ""}`}
        style={{ ...frame(card()), ...pickedStyle(props.selected === id) }}
      >
        <View class="flex-row items-center gap-[6px] w-full min-w-0">
          <View class={`w-[6px] h-[6px] shrink-0 rounded-full ${why() === null ? "bg-ok" : "bg-ink-muted"}`} />
          <Text class={title}>{mine().name}</Text>
          <Text class="shrink-0 text-[10px] text-ink-muted">{c().own.mine}</Text>
        </View>
        <Text testID={`playbook-said-${id}`} class={saidClass}>{why() ?? ownSaid(mine())}</Text>
      </View>
    );
  };

  const stepCard = (card: () => PlaybookCard, step: PlaybookStepId) => (
    <View
      role="button"
      testID={`playbook-node-${step}`}
      accessibilityLabel={c().steps[step]!.name}
      accessibilityState={{ pressed: props.selected === step }}
      onPress={() => props.onpick(step)}
      class={`${base} border-dashed hover:bg-line-subtle bg-pane ${props.selected === step ? "border-brand" : "border-line"} ${props.resolved[step].on ? "" : "opacity-[0.55]"}`}
      style={{ ...frame(card()), ...pickedStyle(props.selected === step) }}
    >
      <View class="flex-row items-center gap-[6px] w-full min-w-0">
        <View class={`w-[6px] h-[6px] shrink-0 rounded-full ${!props.resolved[step].on ? "bg-ink-muted" : warned(step) ? "bg-warn" : "bg-ok"}`} />
        <Text class={title}>{c().steps[step]!.name}</Text>
        <If when={stepDiffers(step, props.resolved, props.builtin)}>
          <View testID={`playbook-changed-${step}`} role="image" accessibilityLabel={c().changed} tooltip={tip(c().changed)} class="w-[6px] h-[6px] shrink-0 rounded-full bg-brand" />
        </If>
        <If when={stepLocked(step, props.resolved)}>
          <View testID={`playbook-locked-${step}`} role="image" accessibilityLabel={c().locked} tooltip={tip(c().locked)} class="shrink-0">
            <Icon name="lock" size={12} class="tint-ink-muted" />
          </View>
        </If>
      </View>
      <Text testID={`playbook-said-${step}`} class={saidClass}>{said(step)}</Text>
    </View>
  );

  /** What a card is never changes under its id (its node, its kind); only where it stands does. */
  const cardFor = (card: () => PlaybookCard) => {
    const first = untracked(card);
    if (first.node === "turn") return turnCard(card);
    if (first.kind === "add") return addCard(card);
    if (first.kind === "root") return rootCard(card);
    if (isCustomNode(first.node)) {
      const node = first.node;
      return (
        <If when={ownById().get(node)}>
          {(mine) => ownCard(card, mine)}
        </If>
      );
    }
    return stepCard(card, first.node as PlaybookStepId);
  };

  return (
    <>
      <View role="group" testID="playbook-map" accessibilityLabel={c().title} class="shrink-0 w-full min-w-0" onLayout={(e) => width.set(e.bounds.size.width)}>
        <Scroll horizontal class="w-full min-w-0">
          <View class="self-center" style={{ width: layout().width, height: layout().height }}>
            <Canvas
              class="absolute"
              style={{ left: 0, top: 0, width: layout().width, height: layout().height, pointerEvents: "none" }}
              draw={(cx: CanvasRenderingContext2D) => {
                const board = layout();
                cx.clearRect(0, 0, board.width, board.height);
                cx.lineWidth = 1.5;
                cx.strokeStyle = token("line-hover");
                for (const edge of board.edges) {
                  const off = edgeOff(edge.to);
                  cx.globalAlpha = off ? 0.6 : 1;
                  cx.setLineDash(off ? [4, 4] : []);
                  cx.beginPath();
                  cx.stroke(new Path2D(edge.d));
                }
                cx.globalAlpha = 1;
                cx.setLineDash([]);
              }}
            />
            <Each of={layout().cards} key={(card) => card.id}>
              {(card) => cardFor(card)}
            </Each>
          </View>
        </Scroll>
      </View>
      <If when={props.onadd ? menu() : null}>
        {(open) => (
          <PlaybookAddMenu
            hook={open().hook}
            anchor={open().anchor}
            full={own().length >= CUSTOM_STEPS_MAX}
            onClose={() => menu.set(null)}
            onchoose={(draft) => props.onadd?.(draft)}
          />
        )}
      </If>
    </>
  );
}
