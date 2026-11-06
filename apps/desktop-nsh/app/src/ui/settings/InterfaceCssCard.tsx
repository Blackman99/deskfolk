/**
 * The stylesheet of your own, saved as you type (`settings/InterfaceCssCard.svelte`). Saves carry the
 * revision this text was loaded at: when someone else (a Bot) changed it meanwhile, theirs is shown
 * and yours stays to copy. Leaving the page saves what was typed last.
 *
 * Lost against the messenger: the profile's CSS is saved and kept, but nothing in this card previews
 * it (the Svelte card did not either; the stylesheet was applied to the window by the interface
 * controller). Applying it to the NSH app is a separate task, so here it is text in a code field.
 *
 * Props: `iface` (the daemon's interface state); `locale` (the hooks' descriptions). Test ids:
 * `css-text`, `css-length`, `css-problem`, `css-stale`, `css-copy-mine`, `css-hooks-toggle`, `css-hooks`.
 */
import { Clipboard, cleanup, effect, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import { INTERFACE_CSS_MAX, UI_HOOKS, type InterfaceState } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { Autosave } from "../../m/autosave.svelte.ts";
import { editInterface, newSitting } from "../../m/settings/interface-edit.ts";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { AutosaveState } from "./AutosaveState";
import { SettingsCard } from "./SettingsCard";

const SAVE_AFTER_MS = 1000;

export function InterfaceCssCard(props: { iface: InterfaceState; locale: "zh" | "en" }) {
  const t = () => copy();
  const c = () => t().ui.css;
  const sitting = newSitting();
  const autosave = new Autosave();

  const text = signal(untracked(() => props.iface.profile.css));
  const loadedRevision = signal<string | null>(untracked(() => props.iface.revision_id));
  const dirty = signal(false);
  const failed = signal(false);
  const problem = signal<string | null>(null);
  const stale = signal<string | null>(null);
  const copied = signal(false);
  const hooksOpen = signal(false);

  // What the profile says, when nothing of yours is waiting to be saved.
  effect(() => {
    const revision = props.iface.revision_id;
    const css = props.iface.profile.css;
    untracked(() => {
      if (dirty() || autosave.saving || revision === loadedRevision()) return;
      text.set(css);
      loadedRevision.set(revision);
    });
  });

  // Leaving the page saves what was typed last.
  cleanup(() => {
    if (untracked(() => dirty()) && autosave.cancel()) void save();
  });

  function onInput(value: string): void {
    text.set(value);
    dirty.set(true);
    problem.set(null);
    stale.set(null);
    autosave.schedule(() => void save(), SAVE_AFTER_MS);
  }

  async function save(): Promise<void> {
    if (!dirty() || autosave.saving) return;
    const sent = text();
    autosave.saving = true;
    failed.set(false);
    const result = await editInterface(runtime, { css: { set: sent } }, { if_revision: loadedRevision(), edit_session: sitting });
    autosave.saving = false;
    if (result.ok) {
      loadedRevision.set(result.state.revision_id);
      autosave.savedTick += 1;
      problem.set(null);
      if (text() === sent) dirty.set(false);
      else autosave.schedule(() => void save(), SAVE_AFTER_MS);
      return;
    }
    if (result.status === 409) {
      // Changed elsewhere: show that, keep yours to copy.
      stale.set(sent);
      const api = runtime.client;
      const latest = api ? await api.getInterface().catch(() => null) : null;
      const source = latest ?? props.iface;
      text.set(source.profile.css);
      loadedRevision.set(source.revision_id);
      dirty.set(false);
      return;
    }
    failed.set(true);
    problem.set(result.message);
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

  return (
    <SettingsCard testID="interface-css">
      <View class="flex-row items-baseline justify-between gap-3">
        <Text role="header" class="text-[14px] font-semibold text-ink">{t().ui.sections.css}</Text>
        <AutosaveState saving={autosave.saving} failed={failed()} saved={autosave.savedTick > 0} />
      </View>
      <Input
        testID="css-text"
        accessibilityLabel={t().ui.sections.css}
        multiline
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={INTERFACE_CSS_MAX}
        value={text()}
        placeholder={c().empty}
        onChange={(e) => onInput(e.value)}
        class="w-full min-h-[180px] px-3 py-[10px] border border-line rounded-(--radius-md) bg-pane text-ink font-mono text-[13px] leading-[1.5] focus:border-field-focus-border"
      />
      <View class="flex-row flex-wrap gap-x-3 gap-y-2">
        <Text testID="css-length" class="text-[12px] text-ink-muted">{`${c().length.replace("{n}", String(text().length))} / ${INTERFACE_CSS_MAX}`}</Text>
        <If when={problem()}>
          <Text testID="css-problem" role="alert" class="text-[12px] text-danger-text">{problem() ?? ""}</Text>
        </If>
      </View>
      <If when={stale() !== null}>
        <View testID="css-stale" class="flex-row items-center justify-between gap-[10px] px-[10px] py-2 rounded-(--radius-md) border border-warn-line bg-warn-bg">
          <Text class="shrink text-[12px] text-warn-text">{t().prompts.changedElsewhere}</Text>
          <Button size="sm" testID="css-copy-mine" onPress={() => void copyStale()}>{copied() ? t().prompts.copied : t().prompts.copyMine}</Button>
        </View>
      </If>
      <Text class="text-[12px] leading-[1.5] text-ink-muted">{c().hint}</Text>
      <View class="flex-col">
        <View
          role="button"
          testID="css-hooks-toggle"
          accessibilityState={{ expanded: hooksOpen() }}
          onPress={() => hooksOpen.set(!hooksOpen())}
          class="flex-row items-center gap-[6px] self-start"
        >
          <Icon name={hooksOpen() ? "chevron-down" : "chevron-right"} size={12} class="tint-ink-secondary" />
          <Text class="text-[12px] font-semibold text-ink-secondary">{c().hooks}</Text>
        </View>
        <If when={hooksOpen()}>
          <View testID="css-hooks" class="flex-col gap-1 mt-2">
            {UI_HOOKS.map((hook) => (
              <View class="flex-row flex-wrap gap-x-[10px] gap-y-[2px]">
                <Text class="font-mono text-[12px] text-ink">{`[data-ui="${hook[0]}"]`}</Text>
                <Text class="text-[12px] text-ink-secondary">{props.locale === "en" ? hook[2] : hook[1]}</Text>
              </View>
            ))}
          </View>
        </If>
      </View>
    </SettingsCard>
  );
}
