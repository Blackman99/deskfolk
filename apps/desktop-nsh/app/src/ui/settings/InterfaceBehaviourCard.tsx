/**
 * The closed list of how the app works (ADR 0106) as an editor of the interface profile
 * (`settings/InterfaceBehaviourCard.svelte`): focus mode, send key, time format, motion, window
 * glass, code colours per look, and where things open. Each choice row has the app's default as its
 * first choice and patches the profile through `editInterfaceOrToast`.
 *
 * Props: `behaviour` (the profile's); `phone` (no workbench: the desktop-only rows are left out).
 * Test ids: `behaviour-<key>-default` / `behaviour-<key>-<value>` on the choices, `interface-focus-mode-toggle`,
 * `behaviour-code_theme-light` / `-dark` on the two code-colour selects.
 */
import { Text, View } from "nsh";
import { INTERFACE_CODE_THEMES, type InterfaceBehaviour } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { focusMode } from "../../m/chat/focus-mode.svelte.ts";
import { CODE_THEME_LABELS } from "../../m/interface/code-theme.ts";
import { editInterfaceOrToast } from "../../m/settings/interface-edit.ts";
import { Select } from "../Select";
import { Switch } from "../Switch";
import { narrowWindow } from "../Modal";
import { InterfaceSegmented } from "./InterfaceSegmented";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";

type RowKey = "send_key" | "time_format" | "motion" | "content_glass";

export function InterfaceBehaviourCard(props: { behaviour: InterfaceBehaviour; phone: boolean }) {
  const t = () => copy();
  const c = () => t().ui.behaviour;
  const rows = (): { key: RowKey; name: string; titleId: string; values: string[]; labels: Record<string, string>; hint?: string; desktopOnly?: boolean }[] => [
    { key: "send_key", name: c().send_key.name, titleId: "interface-send-key", values: ["enter", "mod_enter"], labels: { enter: c().send_key.enter, mod_enter: c().send_key.mod_enter } },
    { key: "time_format", name: c().time_format.name, titleId: "interface-time-format", values: ["24h", "12h"], labels: { "24h": c().time_format["24h"], "12h": c().time_format["12h"] } },
    { key: "motion", name: c().motion.name, titleId: "interface-motion", values: ["system", "reduce"], labels: { system: c().motion.system, reduce: c().motion.reduce } },
    { key: "content_glass", name: c().content_glass.name, titleId: "interface-content-glass", values: ["frosted", "clear"], labels: { frosted: c().content_glass.frosted, clear: c().content_glass.clear }, hint: c().content_glass.hint, desktopOnly: true },
  ];
  const shownRows = () => rows().filter((row) => !(row.desktopOnly && props.phone));

  function choose(key: RowKey, value: string | null): void {
    void editInterfaceOrToast(runtime, { behaviour: { [key]: value } as never });
  }

  const codeLooks = () => [
    { look: "light" as const, label: c().code_theme.light, themes: INTERFACE_CODE_THEMES.light },
    { look: "dark" as const, label: c().code_theme.dark, themes: INTERFACE_CODE_THEMES.dark },
  ];
  function codeOptions(themes: readonly string[]): { value: string; label: string }[] {
    return [{ value: "", label: c().code_theme.appDefault }, ...themes.map((theme) => ({ value: theme, label: CODE_THEME_LABELS[theme as keyof typeof CODE_THEME_LABELS] ?? theme }))];
  }
  function chooseCode(look: "light" | "dark", value: string): void {
    void editInterfaceOrToast(runtime, { behaviour: { code_theme: { [look]: value || null } } as never });
  }

  return (
    <SettingsCard testID="interface-behaviour">
      <Text role="header" class="text-[14px] font-semibold text-ink">{t().ui.sections.behaviour}</Text>
      <View class="flex-col border-t border-line-subtle">
        <SettingsRow title={c().focus_mode.name} titleId="interface-focus-mode" desc={c().focus_mode.hint}>
          <Switch
            testID="interface-focus-mode-toggle"
            label={c().focus_mode.name}
            checked={focusMode.on}
            onChange={(on) => focusMode.set(on)}
          />
        </SettingsRow>
        <Each of={shownRows()} key={(row) => row.key}>
          {(row) => {
            const current = () => props.behaviour[row().key] ?? null;
            return (
              <SettingsRow title={row().name} titleId={row().titleId} desc={row().hint ?? ""}>
                <InterfaceSegmented
                  testID={`behaviour-${row().key}`}
                  ariaLabel={row().name}
                  value={(current() ?? "") as string}
                  onPick={(value) => choose(row().key, value === "" ? null : value)}
                  options={[
                    { value: "", label: c().default, testID: `behaviour-${row().key}-default` },
                    ...row().values.map((value) => ({ value, label: row().labels[value] ?? value, testID: `behaviour-${row().key}-${value}` })),
                  ]}
                />
              </SettingsRow>
            );
          }}
        </Each>
        <SettingsRow title={c().code_theme.name} titleId="interface-code-theme" desc={c().code_theme.hint} last={props.phone}>
          <View role="group" testID="behaviour-code_theme" accessibilityLabel={c().code_theme.name} class={`flex-row flex-wrap gap-x-3 gap-y-2 justify-end ${narrowWindow() ? "w-full" : ""}`}>
            <Each of={codeLooks()} key={(row) => row.look}>
              {(row) => (
                <View class={`flex-row items-center gap-[6px] min-w-0 ${narrowWindow() ? "grow" : ""}`}>
                  <Text class="text-[12px] text-ink-muted">{row().label}</Text>
                  <Select
                    size="sm"
                    testID={`behaviour-code_theme-${row().look}`}
                    value={props.behaviour.code_theme?.[row().look] ?? ""}
                    options={codeOptions(row().themes)}
                    ariaLabel={`${c().code_theme.name} · ${row().label}`}
                    title={`${c().code_theme.name} · ${row().label}`}
                    onChange={(value) => chooseCode(row().look, value)}
                  />
                </View>
              )}
            </Each>
          </View>
        </SettingsRow>
        <If when={!props.phone}>
          <SettingsRow title={c().open_placement.name} titleId="interface-open-placement" desc={c().open_placement.hint} last>
            <Text class="text-[12px] text-ink-muted">{c().desktopOnly}</Text>
          </SettingsRow>
        </If>
      </View>
    </SettingsCard>
  );
}
