/**
 * Which engine Roles shows (`settings/PlaybookHeader.svelte`, ADR 0085): the ones built in, then
 * yours, the default starred. For the one shown: make it the default, make a new one from it,
 * rename or remove one of yours, and read its history — every change, never rewritten.
 *
 * Props: `playbooks`; `shown` (the engine's id); `onshow(id)`; `onmakedefault(id)`. Test ids:
 * `playbook-chip-<id>`, `playbook-action-<default|new|rename|remove|history>`, `playbook-name`,
 * `playbook-name-submit`, `playbook-confirm-remove`, `playbook-history`, `playbook-default`.
 */
import type { PlaybookImpact, PlaybookRevision } from "@real-bot/protocol";
import { effect, signal, Text, untracked, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { copy } from "../../runtime";
import { formatFullTimestamp } from "../../m/chat/chat-view.ts";
import { playbookName, type Playbooks } from "../../m/settings/playbooks.svelte.ts";
import { tip } from "../tip";
import { DangerDialog } from "../overlays/DangerDialog";

/** A line of text that acts: the accent colour, an underline under the pointer. */
function Action(props: { testID: string; kind?: "danger" | "primary"; disabled?: boolean; expanded?: boolean; onPress: () => void; children?: JSX.Element }) {
  return (
    <View
      role="button"
      testID={props.testID}
      disabled={props.disabled}
      accessibilityState={{ expanded: props.expanded, disabled: props.disabled }}
      onPress={props.onPress}
      class="cursor-pointer select-none disabled:cursor-default group disabled:opacity-[0.5]"
    >
      <Text class={`text-[12px] group-hover:underline ${props.kind === "danger" ? "text-danger-text" : "text-brand"} ${props.kind === "primary" ? "font-semibold" : ""}`}>{props.children}</Text>
    </View>
  );
}

export function PlaybookHeader(props: {
  playbooks: Playbooks;
  shown: string;
  onshow: (id: string) => void;
  onmakedefault: (id: string) => void;
}) {
  const c = () => copy().playbooks;
  const current = () => props.playbooks.find(props.shown);
  const isDefault = () => props.playbooks.defaultId === props.shown;

  const naming = signal<"new" | "rename" | null>(null);
  const name = signal("");
  const removing = signal(false);
  /** Making an engine with no jobs the default moves every conversation that follows it: said first (ADR 0103). */
  const moving = signal<PlaybookImpact | null>(null);
  const history = signal<PlaybookRevision[] | null>(null);
  let composing = false;

  function startNaming(kind: "new" | "rename"): void {
    naming.set(kind);
    removing.set(false);
    name.set(kind === "rename" ? (current()?.name ?? "") : "");
  }

  async function submitName(): Promise<void> {
    const trimmed = name().trim();
    const kind = naming();
    if (!trimmed || !kind) return;
    if (kind === "new") {
      const made = await props.playbooks.create(props.shown, trimmed);
      if (made) props.onshow(made.id);
    } else {
      await props.playbooks.rename(props.shown, trimmed);
    }
    naming.set(null);
  }

  async function remove(): Promise<void> {
    removing.set(false);
    await props.playbooks.remove(props.shown);
    props.onshow(props.playbooks.defaultId);
  }

  async function makeDefault(): Promise<void> {
    const impact = current()?.resolved.jobs.on === false ? await props.playbooks.impactOf(props.shown) : null;
    if (impact && impact.sessions > 0) moving.set(impact);
    else props.onmakedefault(props.shown);
  }

  async function toggleHistory(): Promise<void> {
    if (history()) {
      history.set(null);
      return;
    }
    history.set(await props.playbooks.revisions(props.shown));
  }

  // Another engine shown: its own history, its own name.
  effect(() => {
    void props.shown;
    untracked(() => {
      history.set(null);
      naming.set(null);
      removing.set(false);
      moving.set(null);
    });
  });

  return (
    <View testID="playbook-header" class="gap-2 min-w-0">
      <If when={moving()}>
        {(impact) => (
          <DangerDialog
            copy={{ title: c().defaultTitle, body: c().defaultBody(impact().sessions, impact().open_jobs), confirm: c().makeDefault, cancel: c().cancel }}
            onDismiss={() => moving.set(null)}
            onConfirm={() => {
              moving.set(null);
              props.onmakedefault(props.shown);
            }}
          />
        )}
      </If>

      <View role="tablist" accessibilityLabel={c().title} class="flex-row flex-wrap gap-[6px]">
        {() =>
          props.playbooks.items.map((item) => (
            <View
              role="tab"
              testID={`playbook-chip-${item.id}`}
              accessibilityLabel={playbookName(item, c().builtin)}
              accessibilityState={{ selected: item.id === props.shown }}
              onPress={() => props.onshow(item.id)}
              class={`cursor-pointer select-none flex-row items-center gap-1 px-3 py-1 border rounded-full hover:bg-line-subtle ${item.id === props.shown ? "border-brand bg-accent-tint" : "border-line bg-pane"}`}
            >
              <If when={item.id === props.playbooks.defaultId}>
                <View role="image" accessibilityLabel={c().isDefault} tooltip={tip(c().isDefault)}>
                  <Text class="text-[11px] text-brand">★</Text>
                </View>
              </If>
              <Text class={`text-[12px] ${item.id === props.shown ? "font-semibold text-brand" : "text-ink"}`}>{playbookName(item, c().builtin)}</Text>
            </View>
          ))
        }
      </View>

      <If when={current()}>
        <If when={current()!.builtin && c().builtinHint[current()!.id]}>
          <Text testID="playbook-header-hint" class="text-[12px] leading-[1.45] text-ink-muted">{c().builtinHint[current()!.id]}</Text>
        </If>
        <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <If when={isDefault()} else={<Action testID="playbook-action-default" onPress={() => void makeDefault()}>{c().makeDefault}</Action>}>
            <Text testID="playbook-default" class="text-[12px] text-ink-muted">{c().isDefault}</Text>
          </If>
          <Action testID="playbook-action-new" onPress={() => startNaming("new")}>{c().newFrom}</Action>
          <If when={!current()!.builtin}>
            <Action testID="playbook-action-rename" onPress={() => startNaming("rename")}>{c().rename}</Action>
            <If when={!isDefault()}>
              <Action
                testID="playbook-action-remove"
                kind="danger"
                onPress={() => {
                  removing.set(true);
                  naming.set(null);
                }}
              >
                {c().remove}
              </Action>
            </If>
          </If>
          <Action testID="playbook-action-history" expanded={history() !== null} onPress={() => void toggleHistory()}>
            {`${c().history}${current()!.revision > 0 ? ` · ${c().revision(current()!.revision)}` : ""}`}
          </Action>
        </View>
        <If when={naming()}>
          {(kind) => (
            <View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
              <Input
                testID="playbook-name"
                autoFocus
                maxLength={40}
                placeholder={c().newName}
                accessibilityLabel={c().newName}
                value={name()}
                onChange={(e) => name.set(e.value)}
                onCompositionChange={(e) => (composing = e.composing)}
                onSubmit={() => {
                  if (!composing) void submitName();
                }}
                class="flex-1 min-w-[140px] max-w-[260px] px-2 py-1 text-[12px] text-ink bg-input-bg border border-line rounded-(--radius-sm) focus:border-field-focus-border"
              />
              <Action testID="playbook-name-submit" kind="primary" disabled={!name().trim() || props.playbooks.saving} onPress={() => void submitName()}>
                {kind() === "new" ? c().create : c().rename}
              </Action>
              <Action testID="playbook-name-cancel" onPress={() => naming.set(null)}>{c().cancel}</Action>
            </View>
          )}
        </If>
        <If when={removing()}>
          <View role="alert" accessibilityLabel={c().remove} class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
            <Text class="text-[12px] text-ink">{c().removeConfirm(playbookName(current(), c().builtin))}</Text>
            <Action testID="playbook-confirm-remove" kind="danger" onPress={() => void remove()}>{c().remove}</Action>
            <Action testID="playbook-confirm-cancel" onPress={() => removing.set(false)}>{c().cancel}</Action>
          </View>
        </If>
        <If when={history()}>
          <View role="list" testID="playbook-history" class="gap-1 px-[10px] py-2 bg-pane border border-line rounded-(--radius-md)">
            {() =>
              (history() ?? []).length === 0 ? (
                <Text class="text-[12px] text-ink-muted">{c().historyEmpty}</Text>
              ) : (
                (history() ?? []).map((row) => (
                  <View class="flex-row flex-wrap gap-x-[10px] gap-y-1">
                    <Text class="text-[12px] font-semibold text-ink">{c().historyOp[row.op]}</Text>
                    <Text class="text-[12px] text-ink">{c().historyBy(row.actor)}</Text>
                    <Text class="text-[12px] font-mono text-ink-muted">{formatFullTimestamp(row.created_at)}</Text>
                    <Text class="text-[12px] text-ink-muted">{c().revision(row.revision)}</Text>
                  </View>
                ))
              )
            }
          </View>
        </If>
      </If>
      <If when={props.playbooks.error && !current()}>
        <Text role="alert" class="text-[12px] text-danger-text">{props.playbooks.error === "conflict" ? c().conflict : c().failed}</Text>
      </If>
    </View>
  );
}
