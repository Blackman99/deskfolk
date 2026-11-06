/**
 * Roles and the settings window: the roles page (a tab, and a page with its head), one call's editor,
 * one call's node, the model ladder and the whole settings window (`SettingsModal`) with the shell's
 * part played by the story: it owns `saveFailed`, the endpoint editor's state, the confirmations and
 * the phone's drill-down, and calls the window's Back through its handle.
 *
 * `story-show-<roles|page|call|node|ladder|modal>` picks the part. The ladder part runs on an
 * in-memory ladder (`story-ladder` reads what it saved) over two endpoints and a Claude Code and an
 * agent the story answers for, since the fixture daemon has no endpoint to list models from.
 * `story-add-provider` makes a real endpoint on the runtime (`T-routing`, two models) and
 * `story-read` reads what the daemon holds into `story-probe`; `story-cleanup` takes back what a test
 * changed.
 */
import type { AgentsStatusResponse, ClaudeCodeStatus, ModelLadderRung, Provider } from "@real-bot/protocol";
import { Scroll, signal, Text, View } from "nsh";
import { copy, runtime } from "../src/runtime";
import { dangerCopy } from "../src/m/overlays/danger-confirm.ts";
import type { ProviderEditorState } from "../src/m/settings/provider-form.ts";
import { ModelLadder, type ModelLadderApi } from "../src/m/settings/model-ladder.svelte.ts";
import { builtinModelsOf } from "../src/m/settings/builtin-models.ts";
import { routingNodeView } from "../src/m/settings/routing-map.ts";
import { DangerDialog } from "../src/ui/overlays/DangerDialog";
import { CallEditor } from "../src/ui/settings/CallEditor";
import { ModelLadderCard } from "../src/ui/settings/ModelLadderCard";
import { RolesPage } from "../src/ui/settings/RolesPage";
import { RoutingNode } from "../src/ui/settings/RoutingNode";
import { SettingsModal, type SettingsModalHandle } from "../src/ui/settings/SettingsModal";

const PARTS = ["roles", "page", "call", "node", "ladder", "modal"] as const;
type Part = (typeof PARTS)[number];

const stamp = "2026-11-06T08:00:00.000Z";
const fakeProvider = (id: string, name: string, models: string[]): Provider => ({
  id,
  name,
  base_url: "http://127.0.0.1:9/v1",
  key_set: true,
  models,
  model_catalog: [],
  available_models: models,
  default_model: models[0] ?? null,
  created_at: stamp,
  updated_at: stamp,
});
const LADDER_PROVIDERS = [fakeProvider("p-one", "Alpha", ["light", "mid", "heavy"]), fakeProvider("p-two", "Beta", ["other"])];

export default function SettingsRouting() {
  const part = signal<Part>("roles");
  const log = signal("");
  const probe = signal("");
  const roleBack = signal(0);

  // The ladder part: an in-memory ladder with rungs on two endpoints.
  const saved = signal<string>("[]");
  const mem: { items: ModelLadderRung[] } = {
    items: [
      { provider_id: "p-one", model: "light" },
      { provider_id: "p-one", model: "mid" },
      { provider_id: "p-two", model: "other" },
    ],
  };
  const memApi: ModelLadderApi = {
    modelLadder: async () => ({ items: mem.items, available: true }),
    setModelLadder: async (items) => {
      mem.items = items;
      saved.set(JSON.stringify(items.map((rung) => ("runner" in rung ? `${rung.model}@${rung.runner}:${rung.effort ?? ""}` : rung.model))));
      return { items, available: true };
    },
  };
  const ladder = new ModelLadder(() => memApi);
  void ladder.load();
  const claudeAsk = async (): Promise<ClaudeCodeStatus> => {
    throw new Error("404");
  };
  const agentsAsk = async (): Promise<AgentsStatusResponse> => {
    throw new Error("404");
  };

  // The settings window's part: what the shell owns.
  const saveFailed = signal(false);
  const providerEditor = signal<ProviderEditorState | null>(null);
  const confirmingIndependent = signal(false);
  const mobileDetail = signal(false);
  const deleting = signal<string | null>(null);
  let handle: SettingsModalHandle | null = null;

  async function patchImmediate(patch: { locale?: "zh" | "en"; theme?: "system" | "light" | "dark"; launch_at_login?: boolean }): Promise<boolean> {
    saveFailed.set(false);
    const error = await runtime.patchSettings(patch);
    if (error) saveFailed.set(true);
    return error === null;
  }

  const read = async () => {
    const api = runtime.client;
    if (!api) return;
    try {
      const [fresh, list] = await Promise.all([api.snapshot(), api.listPlaybooks()]);
      probe.set(
        JSON.stringify({
          providers: (await api.providers()).map((row) => row.name),
          builtin: fresh.settings.builtin_models ?? null,
          defaultPlaybook: fresh.settings.default_playbook ?? null,
          playbooks: list.items.map((item) => ({ id: item.id, name: item.name, rev: item.revision })),
        }),
      );
    } catch (error) {
      probe.set(`error:${String(error)}`);
    }
  };

  const addProvider = async () => {
    const error = await runtime.createProvider({ name: "T-routing", base_url: "http://127.0.0.1:9/v1", api_key: "k", models: ["t-one", "t-two"], default_model: "t-one" });
    log.set(error ? "provider:error" : "provider:added");
    await read();
  };

  /** Takes back what a test changed: the endpoint it made, the call models, the default engine, the engines of its own. */
  const cleanup = async () => {
    const api = runtime.client;
    if (!api) return;
    try {
      for (const row of await api.providers()) if (row.name.startsWith("T-")) await api.deleteProvider(row.id);
      await runtime.patchSettings({ builtin_models: { reader: null, organizer: null }, default_playbook: "general" });
      for (const item of (await api.listPlaybooks()).items) if (!item.builtin) await api.deletePlaybook(item.id).catch(() => null);
      runtime.settingsOpen = false;
      providerEditor.set(null);
      await read();
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

  const snapshot = () => runtime.snapshot;
  const nodeView = () => routingNodeView("reader", snapshot().settings, []);
  const onAgent = () => Object.values(snapshot().settings.builtin_models ?? {}).some((chosen) => chosen !== null && typeof chosen === "object" && "runner" in chosen);

  return (
    <View testID="settings-routing" class="flex-1 min-h-0 bg-bg">
      <View class="flex-row flex-wrap items-center gap-2 p-3 border-b border-line">
        {PARTS.map((name) =>
          button(
            `story-show-${name}`,
            name,
            () => {
              part.set(name);
              runtime.settingsOpen = name === "modal";
            },
            part() === name,
          ),
        )}
        {button("story-read", "read", () => void read())}
        {button("story-cleanup", "cleanup", () => void cleanup())}
        {button("story-add-provider", "add endpoint", () => void addProvider())}
        {button("story-pending", "pending", () => (runtime.pendingMutation = runtime.pendingMutation ? null : { id: "m-1", code: "unknown" }))}
        {button("story-settings-back", "settings back", () => log.set(`back:${handle?.backWithinSettings()}`))}
        <Text testID="story-log" class="text-[12px] text-ink-muted">{`log:${log()}`}</Text>
        <Text testID="story-roles-back" class="text-[12px] text-ink-muted">{`roles-back:${roleBack()}`}</Text>
        <Text testID="story-ladder" class="text-[12px] text-ink-muted">{`ladder:${saved()}`}</Text>
        <Text testID="story-settings" class="text-[12px] text-ink-muted">{`settings:${runtime.settingsOpen ? "open" : "closed"}:${mobileDetail() ? "detail" : "list"}:${saveFailed() ? "failed" : "ok"}`}</Text>
      </View>
      <Text testID="story-probe" class="px-3 py-1 text-[10px] text-ink-muted">{`probe:${probe()}`}</Text>
      <If when={part() === "roles"}>
        <RolesPage />
      </If>
      <If when={part() === "page"}>
        <RolesPage host="page" onBack={() => roleBack.set(roleBack() + 1)} />
      </If>
      <If when={part() === "call"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6 max-w-[460px]">
            <CallEditor role="reader" />
          </View>
        </Scroll>
      </If>
      <If when={part() === "node"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6 gap-4 max-w-[460px]">
            <RoutingNode
              role="reader"
              view={{ ...nodeView(), prompts: [] }}
              providers={snapshot().providers}
              settings={snapshot().settings}
              defaultModel={snapshot().settings.endpoint_default_model}
              patch={(patch) => runtime.patchSettings(patch)}
              pickable={snapshot().providers.length > 0 || onAgent()}
              claudeStatus={null}
              agents={null}
              promptsFailed={false}
              ui="zh"
              botNames={new Map()}
              onOpenPrompt={(item) => log.set(`prompt:${item.id}`)}
            />
            <Text testID="story-node-model" class="text-[12px] text-ink-muted">{`reader:${JSON.stringify(builtinModelsOf(snapshot().settings).chosen.reader ?? null)}`}</Text>
          </View>
        </Scroll>
      </If>
      <If when={part() === "ladder"}>
        <Scroll class="flex-1 min-h-0">
          <View class="p-6 max-w-[620px]">
            <ModelLadderCard ladder={ladder} providers={LADDER_PROVIDERS} claudeCode={claudeAsk} agents={agentsAsk} />
          </View>
        </Scroll>
      </If>
      <If when={part() === "modal"}>
        <SettingsModal
          workbench
          mobileSettingsDetail={mobileDetail()}
          onMobileSettingsDetailChange={(value) => mobileDetail.set(value)}
          saveFailed={saveFailed()}
          onSaveFailedChange={(value) => saveFailed.set(value)}
          providerEditor={providerEditor()}
          onProviderEditorChange={(value) => providerEditor.set(value)}
          confirmingProvider={deleting() !== null}
          confirmingIndependent={confirmingIndependent()}
          onConfirmingIndependentChange={(value) => confirmingIndependent.set(value)}
          patchImmediate={patchImmediate}
          openDeleteProviderConfirm={(id) => deleting.set(id)}
          closeSettings={() => {
            runtime.settingsOpen = false;
            log.set("closed");
          }}
          onHandle={(h) => (handle = h)}
        />
      </If>
      <If when={deleting()}>
        {(id) => (
          <DangerDialog
            copy={dangerCopy("provider", copy())}
            onDismiss={() => deleting.set(null)}
            onConfirm={() => {
              void runtime.deleteProvider(id());
              deleting.set(null);
            }}
          />
        )}
      </If>
    </View>
  );
}
