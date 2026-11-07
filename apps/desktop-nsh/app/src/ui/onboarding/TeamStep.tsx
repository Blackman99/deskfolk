/**
 * First launch's last step (ADR 0085): a way of working — an engine — and the first Bots, from
 * the templates ready for it. Each ticked template is a draft you can change; making them makes
 * each Bot in turn with its direct on that engine and, with two or more, a group of them on it
 * too, led by the template that leads. A Bot made before one failed is not made twice. The global
 * default engine stays 通用.
 *
 * The Svelte one's `bind:count`, `bind:ready` and `bind:busy` are `onCountChange`, `onReadyChange`
 * and `onBusyChange`; its exported `create()` is handed to `onApi` once, for the footer's button.
 */
import { BUILTIN_PLAYBOOK_IDS, type BuiltinPlaybookId } from "@real-bot/protocol";
import { effect, signal, Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { copy, runtime } from "../../runtime";
import type { TeamMember } from "../../m/admin-mutations.svelte.ts";
import { botAvatarColor } from "../../m/avatar.ts";
import { templatesFor, type BotTemplateId } from "../../m/bot-templates.ts";
import { botNameErrorCopy, mapCreateBotError, planCreateBot, type CreateBotDraft, type CreateBotFieldErrors } from "../../m/panels/create-form.ts";
import { rosterLetter } from "../../m/sidebar/roster-letter.ts";
import { cssColor, shadow } from "../styles";
import { widthAtMost } from "../../platform/viewport";

type Pick = { id: BotTemplateId; on: boolean; lead: boolean; name: string; duties: string; boundaries: string; made: TeamMember["made"] };
type Problem = { id: BotTemplateId; errors: CreateBotFieldErrors; top: boolean };

export type TeamStepApi = { create: () => Promise<boolean> };

const FIELD =
  "w-full text-ink bg-input-bg border border-line rounded-(--radius-md) px-3 py-2 text-[14px] focus:border-field-focus-border";

export function TeamStep(props: {
  /** What every Bot made here runs on: set up on Claude Code or another agent, its runner. */
  base: Partial<CreateBotDraft>;
  /** Everything is made, and the conversation to land in is open. */
  onDone: () => void;
  /** How many Bots are ticked; the footer's button says it. */
  onCountChange?: (count: number) => void;
  /** Something is ticked and every ticked draft is filled in: the footer's button can make them. */
  onReadyChange?: (ready: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  /** Hands the caller `create()` (the Svelte one's exported function). */
  onApi?: (api: TeamStepApi) => void;
}) {
  const c = () => copy().templates;

  /** Each ticked draft as a request, and what of it is made already. */
  let members = new Map<BotTemplateId, TeamMember>();

  const playbook = signal<BuiltinPlaybookId>("general");
  const picks = signal<Pick[]>([]);
  const editing = signal<BotTemplateId | null>(null);
  /** The draft held back and why: its fields, or a refusal that names no field. */
  const problem = signal<Problem | null>(null);
  const groupFailed = signal(false);
  const busy = signal(false);
  const count = signal(0);

  const setBusy = (value: boolean) => {
    busy.set(value);
    props.onBusyChange?.(value);
  };
  const update = (id: BotTemplateId, patch: Partial<Pick>) => picks.set(picks().map((pick) => (pick.id === id ? { ...pick, ...patch } : pick)));

  function pickWay(id: BuiltinPlaybookId): void {
    playbook.set(id);
    editing.set(null);
    problem.set(null);
    groupFailed.set(false);
    members = new Map();
    // 自由 has no team of its own (ADR 0103): the same people, working without the jobs.
    picks.set(
      templatesFor(id === "plain" ? "general" : id).map((template) => {
        const text = c().templates[template.id]!;
        return { id: template.id, on: template.preselected, lead: template.lead, name: text.name, duties: text.duties, boundaries: text.boundaries, made: null };
      }),
    );
  }
  pickWay("general");

  /** Some Bot is made already: its engine is set, so the way no longer changes. */
  const started = () => picks().some((pick) => pick.made !== null);
  const failedPick = () => {
    const held = problem();
    return held ? picks().find((pick) => pick.id === held.id) : undefined;
  };

  function onInput(id: BotTemplateId): void {
    if (problem()?.id === id) problem.set(null);
  }

  function planOf(pick: Pick) {
    return planCreateBot({ ...props.base, name: pick.name, duties: pick.duties, boundaries: pick.boundaries, avatar: "", model: props.base.model ?? "" });
  }

  /** What is wrong with a draft as it stands, or what the Mac said when it refused it. */
  function errorsOf(pick: Pick): CreateBotFieldErrors {
    const held = problem();
    if (held?.id === pick.id && !held.top) return held.errors;
    const plan = planOf(pick);
    return plan.ok ? {} : plan.errors;
  }

  effect(() => {
    const on = picks().filter((pick) => pick.on);
    count.set(on.length);
    props.onCountChange?.(on.length);
    props.onReadyChange?.(on.length > 0 && on.every((pick) => planOf(pick).ok));
  });

  /** Makes what is ticked and not yet made, then the group; true when it all landed. */
  async function create(): Promise<boolean> {
    if (busy()) return false;
    const chosen = picks().filter((pick) => pick.on);
    if (chosen.length === 0) return false;
    problem.set(null);
    groupFailed.set(false);
    const team: TeamMember[] = [];
    for (const pick of chosen) {
      const plan = planOf(pick);
      if (!plan.ok) {
        problem.set({ id: pick.id, errors: plan.errors, top: false });
        editing.set(pick.id);
        return false;
      }
      const member = members.get(pick.id) ?? { body: plan.body, made: null };
      if (!member.made) member.body = plan.body;
      members.set(pick.id, member);
      team.push(member);
    }
    setBusy(true);
    try {
      const lead = Math.max(0, chosen.findIndex((pick) => pick.lead));
      const result = await runtime.createTeam({ members: team, playbookId: playbook(), groupName: c().groupName[playbook()] ?? playbook(), lead });
      for (const pick of chosen) update(pick.id, { made: members.get(pick.id)?.made ?? null });
      if (result.failed !== null) {
        const pick = chosen[result.failed]!;
        const mapped = result.error ? mapCreateBotError(result.error.status, result.error.message) : { top: true as const };
        problem.set("top" in mapped ? { id: pick.id, errors: {}, top: true } : { id: pick.id, errors: mapped, top: false });
        editing.set(pick.id);
        return false;
      }
      groupFailed.set(result.groupFailed);
      props.onDone();
      return true;
    } finally {
      setBusy(false);
    }
  }
  props.onApi?.({ create });

  const narrow = () => widthAtMost(520);

  return (
    <View testID="team-step" class="flex-col gap-[18px]">
      <View class="flex-col gap-2">
        <Text role="header" class="text-[14px] font-semibold text-ink">{c().pick}</Text>
        <Text class="text-[12px] leading-[1.45] text-ink-muted">{c().pickHint}</Text>
        <View role="radiogroup" accessibilityLabel={c().pick} class={`gap-[10px] ${narrow() ? "flex-col" : "flex-row"}`}>
          <Each of={BUILTIN_PLAYBOOK_IDS.slice()} key={(id) => id}>
            {(id) => (
              <View
                role="radio"
                testID={`team-way-${id()}`}
                accessibilityLabel={copy().playbooks.builtin[id()]}
                accessibilityState={{ checked: playbook() === id(), disabled: busy() || started() }}
                disabled={busy() || started()}
                onPress={() => pickWay(id())}
                class={`flex-1 min-w-0 gap-1 px-[14px] py-3 rounded-(--radius-lg) border bg-pane hover:border-line-hover disabled:opacity-[0.7] ${playbook() === id() ? "border-brand" : "border-line"}`}
                style={{ boxShadow: playbook() === id() ? undefined : shadow("xs") }}
              >
                <Text class="text-[14px] font-semibold text-ink">{copy().playbooks.builtin[id()]}</Text>
                <Text class="text-[12px] leading-[1.45] text-ink-muted">{copy().playbooks.builtinHint[id()]}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>

      <View class="flex-col gap-2">
        <Text role="header" class="text-[14px] font-semibold text-ink">{c().team}</Text>
        <Text class="text-[12px] leading-[1.45] text-ink-muted">{c().teamHint}</Text>
        <View class="flex-col gap-2">
          <Each of={picks().slice()} key={(pick) => pick.id}>
            {(item) => {
              const pick = () => picks().find((p) => p.id === item().id) ?? item();
              const pal = () => botAvatarColor(pick().id);
              const locked = () => busy() || pick().made !== null;
              return (
                <View
                  testID={`team-template-${pick().id}`}
                  class={`px-3 py-[10px] rounded-(--radius-lg) border bg-pane ${pick().on ? "border-brand" : "border-line hover:border-line-hover"}`}
                >
                  <View class="flex-row items-center gap-[10px]">
                    {/* The whole face and name tick the box, not only the box. */}
                    <View
                      role="checkbox"
                      testID={`team-pick-${pick().id}`}
                      accessibilityLabel={pick().name}
                      accessibilityState={{ checked: pick().on, disabled: locked() }}
                      disabled={locked()}
                      onPress={() => update(pick().id, { on: !pick().on })}
                      class="flex-1 min-w-0 flex-row items-center gap-[10px]"
                    >
                      <View class={`w-[18px] h-[18px] rounded-[4px] border items-center justify-center shrink-0 ${pick().on ? "bg-brand border-brand" : "bg-input-bg border-line-hover"}`}>
                        <If when={pick().on}>
                          <Text class="text-[12px] font-bold text-on-accent">✓</Text>
                        </If>
                      </View>
                      <View
                        class="w-[36px] h-[36px] rounded-full border items-center justify-center shrink-0"
                        style={{ backgroundColor: cssColor(pal().bg), borderColor: cssColor(pal().border) }}
                        accessible={false}
                      >
                        <Text class="text-[14px] font-bold" style={{ color: cssColor(pal().text) }}>{rosterLetter(pick().name)}</Text>
                      </View>
                      <View class="flex-1 min-w-0 gap-[2px]">
                        <View class="flex-row items-center gap-[6px]">
                          <Text class="text-[13px] font-semibold text-ink line-clamp-1 shrink">{pick().name}</Text>
                          <If when={pick().lead && count() > 1 && pick().on}>
                            <View class="px-[6px] rounded-full bg-chip">
                              <Text class="text-[10px] font-semibold leading-[16px] text-ink-muted">{c().lead}</Text>
                            </View>
                          </If>
                          <If when={pick().made}>
                            <Text class="text-[13px] text-ok-text" accessible={false}>✓</Text>
                          </If>
                        </View>
                        <If
                          when={pick().on && editing() !== pick().id && !planOf(pick()).ok}
                          else={<Text class="text-[12px] text-ink-muted line-clamp-1">{pick().duties.split("\n")[0]}</Text>}
                        >
                          <Text class="text-[12px] text-danger-text line-clamp-1">{c().incomplete}</Text>
                        </If>
                      </View>
                    </View>
                    <View
                      role="button"
                      testID={`team-edit-${pick().id}`}
                      accessibilityLabel={editing() === pick().id ? c().done : c().edit}
                      accessibilityState={{ expanded: editing() === pick().id, disabled: locked() }}
                      disabled={locked()}
                      onPress={() => editing.set(editing() === pick().id ? null : pick().id)}
                      class="shrink-0 h-[28px] px-[10px] rounded-[7px] justify-center hover:bg-accent-tint disabled:opacity-[0.5]"
                    >
                      <Text class="text-[12px] font-semibold text-brand">{editing() === pick().id ? c().done : c().edit}</Text>
                    </View>
                  </View>
                  <If when={editing() === pick().id}>
                    <View class="flex-col gap-2 mt-[10px] pt-[10px] border-t border-line-subtle">
                      <Labelled label={copy().sidebar.botName}>
                        <Input
                          testID={`team-name-${pick().id}`}
                          accessibilityLabel={copy().sidebar.botName}
                          value={pick().name}
                          onChange={(e) => {
                            update(pick().id, { name: e.value });
                            onInput(pick().id);
                          }}
                          class={FIELD}
                        />
                        <If when={errorsOf(pick()).name}>
                          {(error) => <Text role="alert" class="text-[12px] font-medium text-warn-text">{botNameErrorCopy(error(), copy().sidebar)}</Text>}
                        </If>
                      </Labelled>
                      <Labelled label={copy().sidebar.botDuties}>
                        <Input
                          testID={`team-duties-${pick().id}`}
                          accessibilityLabel={copy().sidebar.botDuties}
                          multiline
                          submitBehavior="newline"
                          value={pick().duties}
                          onChange={(e) => {
                            update(pick().id, { duties: e.value });
                            onInput(pick().id);
                          }}
                          class={`${FIELD} min-h-[96px] leading-[1.45]`}
                        />
                        <If when={errorsOf(pick()).duties}>
                          <Text role="alert" class="text-[12px] font-medium text-warn-text">{copy().sidebar.dutiesEmpty}</Text>
                        </If>
                      </Labelled>
                      <Labelled label={copy().sidebar.botBoundaries}>
                        <Input
                          testID={`team-boundaries-${pick().id}`}
                          accessibilityLabel={copy().sidebar.botBoundaries}
                          multiline
                          submitBehavior="newline"
                          value={pick().boundaries}
                          onChange={(e) => {
                            update(pick().id, { boundaries: e.value });
                            onInput(pick().id);
                          }}
                          class={`${FIELD} min-h-[96px] leading-[1.45]`}
                        />
                        <If when={errorsOf(pick()).boundaries}>
                          <Text role="alert" class="text-[12px] font-medium text-warn-text">{copy().sidebar.boundariesEmpty}</Text>
                        </If>
                      </Labelled>
                    </View>
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
        <If when={count() === 0}>
          <Text testID="team-none" class="text-[12px] leading-[1.45] text-ink-muted">{c().none}</Text>
        </If>
        <If when={problem() && failedPick()}>
          <Text testID="team-failed" role="alert" class="text-[12px] font-medium text-warn-text">
            {c().failed(failedPick()!.name.trim() || c().templates[failedPick()!.id]!.name)}
          </Text>
        </If>
        <If when={groupFailed()}>
          <Text testID="team-group-failed" role="alert" class="text-[12px] font-medium text-warn-text">{c().groupFailed}</Text>
        </If>
      </View>
    </View>
  );
}

function Labelled(props: { label: string; children?: JSX.Element }) {
  return (
    <View class="flex-col gap-1">
      <Text class="text-[12px] text-ink-secondary">{props.label}</Text>
      {props.children}
    </View>
  );
}
