/**
 * What a Bot's turn is given in an engine (`settings/PlaybookTurnPart.svelte`, ADR 0103): the System
 * section, as built in or written for this engine alone, and which groups of the app's tools it is
 * offered. Each change is saved as the engine's new difference from its built-in, so it has a
 * revision like any other. A text of your own stays as you wrote it: no update touches it.
 *
 * Props: `playbook`; `locale`; `api` (reads the built-in text); `onsave(diff)`; `saving`; `error`.
 * Test ids: `engine-system-write`, `engine-system-restore`, `engine-system`, `engine-system-save`,
 * `engine-system-cancel`, `engine-tool-<kind>` (the Svelte's `data-engine-*`).
 */
import { ENGINE_TOOL_KINDS, type EngineToolKind, type Locale, type Playbook, type PlaybookDiff } from "@real-bot/protocol";
import { effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { copy } from "../../runtime";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { PlaybookSaveError } from "../../m/settings/playbooks.svelte.ts";
import { Button } from "../Button";
import { Switch } from "../Switch";

export function PlaybookTurnPart(props: {
  playbook: Playbook;
  locale: Locale;
  api: MessengerApi | null;
  onsave: (diff: PlaybookDiff) => void | Promise<unknown>;
  saving: boolean;
  error: PlaybookSaveError | null;
}) {
  const c = () => copy().playbooks.turn;
  const own = () => props.playbook.diff.system?.[props.locale] ?? null;
  /** The text being written; null while it is closed. */
  const draft = signal<string | null>(null);
  const loadFailed = signal(false);

  // Another engine shown: what is open was about the one before.
  effect(() => {
    void props.playbook.id;
    untracked(() => {
      draft.set(null);
      loadFailed.set(false);
    });
  });

  async function write(): Promise<void> {
    loadFailed.set(false);
    const mine = own();
    if (mine !== null) {
      draft.set(mine);
      return;
    }
    try {
      draft.set(props.api ? (await props.api.playbookSystem(props.playbook.id, props.locale)).text : null);
    } catch {
      loadFailed.set(true);
    }
  }

  function withSystem(text: string | null): PlaybookDiff {
    const { [props.locale]: _gone, ...others } = props.playbook.diff.system ?? {};
    const system = text === null ? others : { ...others, [props.locale]: text };
    const { system: _before, ...diff } = props.playbook.diff;
    return Object.keys(system).length > 0 ? { ...diff, system } : diff;
  }

  async function save(): Promise<void> {
    const text = draft();
    if (text === null || !text.trim()) return;
    await props.onsave(withSystem(text));
    draft.set(null);
  }

  async function restore(): Promise<void> {
    await props.onsave(withSystem(null));
    draft.set(null);
  }

  function setTool(kind: EngineToolKind, offered: boolean): void {
    const off = (props.playbook.diff.tools_off ?? []).filter((other) => other !== kind);
    const { tools_off: _before, ...diff } = props.playbook.diff;
    const next = offered ? off : [...off, kind];
    void props.onsave(next.length > 0 ? { ...diff, tools_off: next } : diff);
  }

  const partClass = "gap-2 mt-2 pt-3 border-t border-line min-w-0";
  const titleClass = "text-[12px] font-semibold text-ink-secondary";
  const hintClass = "text-[12px] leading-[1.5] text-ink-secondary";

  return (
    <>
      <View testID="engine-system-part" class={partClass}>
        <Text role="header" class={titleClass}>{c().system}</Text>
        <Text class={hintClass}>{own() === null ? c().systemBuiltin : c().systemOwn}</Text>
        <If
          when={draft() === null}
          else={
            <>
              <Input
                testID="engine-system"
                multiline
                submitBehavior="newline"
                accessibilityLabel={c().system}
                value={draft() ?? ""}
                onChange={(e) => draft.set(e.value)}
                class="w-full min-h-[180px] px-2 py-[6px] text-[12px] text-ink bg-input-bg border border-line rounded-(--radius-sm) focus:border-field-focus-border"
              />
              <Text class={hintClass}>{c().writeHint}</Text>
              <View class="flex-row flex-wrap gap-2">
                <Button testID="engine-system-save" size="sm" variant="primary" disabled={props.saving || !(draft() ?? "").trim()} onPress={() => void save()}>
                  {c().save}
                </Button>
                <Button testID="engine-system-cancel" size="sm" variant="ghost" disabled={props.saving} onPress={() => draft.set(null)}>
                  {copy().playbooks.cancel}
                </Button>
              </View>
            </>
          }
        >
          <View class="flex-row flex-wrap gap-2">
            <Button testID="engine-system-write" size="sm" disabled={props.saving} onPress={() => void write()}>
              {own() === null ? c().write : c().edit}
            </Button>
            <If when={own() !== null}>
              <Button testID="engine-system-restore" size="sm" variant="ghost" disabled={props.saving} onPress={() => void restore()}>
                {c().restore}
              </Button>
            </If>
          </View>
          <If when={loadFailed()}>
            <Text role="alert" class="text-[12px] text-danger-text">{copy().playbooks.failed}</Text>
          </If>
        </If>
        <If when={props.error}>
          <Text role="alert" class="text-[12px] text-danger-text">{props.error === "conflict" ? copy().playbooks.conflict : copy().playbooks.failed}</Text>
        </If>
      </View>

      <View testID="engine-tools-part" class={partClass}>
        <Text role="header" class={titleClass}>{c().tools}</Text>
        <Text class={hintClass}>{c().toolsHint}</Text>
        {() =>
          ENGINE_TOOL_KINDS.map((kind) => (
            <View class="flex-row items-center justify-between gap-3">
              <Text class="text-[13px] text-ink">{copy().prompts.toolKinds[kind]}</Text>
              <Switch
                testID={`engine-tool-${kind}`}
                label={copy().prompts.toolKinds[kind]}
                disabled={props.saving}
                checked={!(props.playbook.diff.tools_off ?? []).includes(kind)}
                onChange={(offered) => setTool(kind, offered)}
              />
            </View>
          ))
        }
      </View>
    </>
  );
}
