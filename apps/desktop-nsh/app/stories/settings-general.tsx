/**
 * The settings dialog's general pages: the navigation, General, Behavior, Models (with the speech
 * card), About, and the built-in call's model picker. The dialog itself (`SettingsModal`) is a later
 * job, so this story is the caller: it holds the active tab, saves through `runtime` as the dialog
 * does and lets one part show at a time (`story-show-<part>`).
 */
import { Scroll, signal, Text, View } from "nsh";
import { copy, runtime } from "../src/runtime";
import { builtinModelsOf, builtinPatch } from "../src/m/settings/builtin-models.ts";
import { gatedIndependentStatus, type IndependentStatus } from "../src/m/settings/independent-runtime.ts";
import { focusMode } from "../src/m/chat/focus-mode.svelte.ts";
import { updateChecker } from "../src/m/update-checker.svelte.ts";
import { AboutTab } from "../src/ui/settings/AboutTab";
import { BehaviorTab } from "../src/ui/settings/BehaviorTab";
import { GeneralTab } from "../src/ui/settings/GeneralTab";
import { ModelsTab } from "../src/ui/settings/ModelsTab";
import { createModelsState } from "../src/ui/settings/models-tab";
import { SettingsNav, type SettingsTab } from "../src/ui/settings/SettingsNav";
import { SideModelCard } from "../src/ui/settings/SideModelCard";

const PARTS = ["nav", "general", "behavior", "models", "model-card", "about"] as const;
type Part = (typeof PARTS)[number];

export default function SettingsGeneral() {
  const part = signal<Part>("general");
  const active = signal<SettingsTab>("general");
  const log = signal("");
  const saved = signal("");
  const workspaceError = signal<"empty" | "invalid" | undefined>(undefined);
  const independent = signal<IndependentStatus>(gatedIndependentStatus("gated"));
  const independentBusy = signal(false);
  const readOnly = signal(false);
  const t = () => copy();
  const modelsState = createModelsState((of) => (of === "endpoints" ? t().settings.modelsSectionEndpoints : t().speech.title));
  // The shell starts the checker (`routes/+page.svelte`); a story has no shell page, so it does.
  updateChecker.start();

  /** What the runtime itself says (a fresh GET of the snapshot, not the page's copy): the test reads `api-state`. */
  const apiState = signal("");
  let seq = 0;
  let baseline: { theme: string; locale: string; launch: boolean; mode: string | null; workspace: string } | null = null;
  const refreshApi = async () => {
    const api = runtime.client;
    if (!api) return;
    const fresh = await api.snapshot();
    const settings = fresh.settings;
    baseline ??= {
      theme: settings.theme,
      locale: settings.locale,
      launch: settings.launch_at_login,
      mode: settings.permission_mode ?? null,
      workspace: settings.workspace_path ?? "",
    };
    apiState.set(
      JSON.stringify({
        seq: (seq += 1),
        theme: settings.theme,
        locale: settings.locale,
        launch: settings.launch_at_login,
        mode: settings.permission_mode ?? null,
        workspace: settings.workspace_path ?? "",
        speech: settings.speech ?? null,
        builtin: settings.builtin_models ?? null,
        botModes: Object.fromEntries(fresh.bots.map((bot) => [bot.name, bot.permission_mode ?? null])),
      }),
    );
  };
  /** Gives a Bot a permission mode of its own (or takes it away), as the Bot's panel does. */
  const setBotMode = async (mode: "read_only" | null) => {
    const api = runtime.client;
    const writer = runtime.snapshot.bots.find((bot) => bot.name === "Writer");
    if (api && writer) await api.patchBot(writer.id, { permission_mode: mode } as never);
    await refreshApi();
  };
  /** Puts back what a test changed, so the next file finds the fixture as it was. */
  const restore = async () => {
    const api = runtime.client;
    if (!api) return;
    await refreshApi();
    const base = baseline;
    if (base) await runtime.patchSettings({ theme: base.theme as never, locale: base.locale as never, launch_at_login: base.launch, permission_mode: (base.mode ?? "auto") as never, workspace_path: base.workspace });
    await runtime.patchSpeech({ enabled: false, preset: "custom", base_url: "", model: "", api_key: "" } as never).catch(() => null);
    await runtime.patchSettings({ builtin_models: { reader: null } });
    await setBotMode(null);
  };

  const snapshot = () => runtime.snapshot;
  const legacy = () => builtinModelsOf(snapshot().settings).legacy;
  const hasLocale = () => (snapshot().settings.locale === "en" ? "en" : "zh");

  return (
    <View class="flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-3 border-b border-line">
        <Each of={PARTS} key={(item) => item}>
          {(item) => (
            <View role="button" testID={`story-show-${item()}`} onPress={() => part.set(item())} class={`px-2 py-1 border rounded-(--radius-sm) ${part() === item() ? "border-brand" : "border-line"}`}>
              <Text class="text-[12px] text-ink">{item()}</Text>
            </View>
          )}
        </Each>
        <View role="button" testID="api-refresh" onPress={() => void refreshApi()} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px] text-ink">read</Text></View>
        <View role="button" testID="story-restore" onPress={() => void restore()} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px] text-ink">restore</Text></View>
        <View role="button" testID="story-bot-mode" onPress={() => void setBotMode("read_only")} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px] text-ink">bot mode</Text></View>
        <Text testID="api-state" class="text-[10px] text-ink-muted">{apiState()}</Text>
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log()}`}</Text>
        <View role="button" testID="story-readonly" onPress={() => readOnly.set(!readOnly())} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px] text-ink">read-only</Text></View>
        <View role="button" testID="story-ws-error" onPress={() => workspaceError.set("empty")} class="px-2 py-1 border border-line rounded-(--radius-sm)"><Text class="text-[12px] text-ink">ws error</Text></View>
        <Text testID="story-focus" class="text-[12px] text-ink-muted">{`focus:${focusMode.on ? "on" : "off"}`}</Text>
        <Text testID="story-saved" class="text-[12px] text-ink-muted">{`saved:${saved()}`}</Text>
        <Text testID="story-active" class="text-[12px] text-ink-muted">{`active:${active()}`}</Text>
      </View>
      <If when={part() === "nav"}>
        <View class="flex-1 min-h-0">
          <SettingsNav
            activeSettingsTab={active()}
            openSettingsTab={(tab) => active.set(tab)}
            generalHasError={true}
            modelsHasError={false}
            promptCounts={{ edited: 2, conflict: true }}
            lessonsTabVisible={true}
            remoteTabVisible={true}
            behaviorTabVisible={true}
            interfaceTabVisible={true}
            closeSettings={() => log.set("close")}
          />
        </View>
      </If>
      <If when={part() === "general"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6">
            <GeneralTab
              locale={hasLocale()}
              patchImmediate={async (patch) => {
                const ok = (await runtime.patchSettings(patch)) === null;
                saved.set(ok ? "yes" : "no");
                return ok;
              }}
              workspaceReadOnly={readOnly()}
              fieldErrors={{ workspace: workspaceError() }}
              clearWorkspaceError={() => workspaceError.set(undefined)}
              persistWorkspace={async (path) => {
                const error = await runtime.patchSettings({ workspace_path: path });
                if (error !== null) workspaceError.set("invalid");
                log.set(`workspace:${path}`);
              }}
              independent={independent()}
              independentBusy={independentBusy()}
              independentReason={(status) => `原因：${status.error ?? "gated"}`}
              requestIndependent={(next) => log.set(`independent:${next}`)}
            />
          </View>
        </Scroll>
      </If>
      <If when={part() === "behavior"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6">
            <BehaviorTab />
          </View>
        </Scroll>
      </If>
      <If when={part() === "models"}>
        <View class="flex-1 min-h-0">
          <ModelsTab
            state={modelsState}
            notices={<Text testID="models-notice" class="text-[12px] text-ink-muted">notice</Text>}
            endpoints={<Text testID="models-endpoints" class="text-[13px] text-ink">endpoints list</Text>}
          />
        </View>
        <Text testID="models-title" class="p-2 text-[12px] text-ink-muted">{`title:${modelsState.sectionTitle() ?? ""}`}</Text>
        <View role="button" testID="models-back" onPress={() => log.set(`back:${modelsState.backFromSection()}`)} class="p-2">
          <Text class="text-[12px] text-ink">back</Text>
        </View>
      </If>
      <If when={part() === "model-card"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6 gap-4">
            <SideModelCard
              kind="reader"
              providers={snapshot().providers}
              chosen={builtinModelsOf(snapshot().settings).chosen.reader ?? null}
              defaultModel="fixture"
              patch={(patch) => runtime.patchSettings(patch)}
              toPatch={(next) => builtinPatch("reader", next, legacy())}
              title="阅读模型"
              followDefault={(model) => `跟随默认${model ? `（${model}）` : ""}`}
              failed="没能保存模型"
              framed
            />
          </View>
        </Scroll>
      </If>
      <If when={part() === "about"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6">
            <AboutTab locale={hasLocale()} />
          </View>
        </Scroll>
      </If>
    </View>
  );
}
