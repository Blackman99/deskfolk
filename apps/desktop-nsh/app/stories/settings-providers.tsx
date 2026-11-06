/** The model providers page with its editor flyout and delete confirmation, and the MCP servers page. */
import { Scroll, signal, Text, View } from "nsh";
import { copy, runtime } from "../src/runtime";
import { dangerCopy } from "../src/m/overlays/danger-confirm.ts";
import { ProviderEditorController } from "../src/m/settings/provider-editor.svelte.ts";
import type { ProviderEditorState } from "../src/m/settings/provider-form.ts";
import { DangerDialog } from "../src/ui/overlays/DangerDialog";
import { McpSettings } from "../src/ui/settings/McpSettings";
import { ProviderEditorFlyout } from "../src/ui/settings/ProviderEditorFlyout";
import { ProvidersTab } from "../src/ui/settings/ProvidersTab";
import { SettingsCard } from "../src/ui/settings/SettingsCard";

export default function SettingsProviders() {
  runtime.settingsOpen = true;
  const providerEditor = signal<ProviderEditorState | null>(null);
  const saveFailed = signal(false);
  const deleting = signal<string | null>(null);
  const deleteBusy = signal(false);
  const controller = new ProviderEditorController({
    runtime: () => runtime,
    snapshot: () => runtime.snapshot,
    t: () => copy(),
    providerEditor: () => providerEditor(),
    setProviderEditor: (value) => providerEditor.set(value),
    setSaveFailed: (value) => saveFailed.set(value),
  });

  /** The shell's Back: out of a model's page, then out of the form back to the tiles, then out of the editor. */
  function backFromProviderEditor(): void {
    if (controller.providerDetailModel) {
      controller.providerDetailModel = null;
      return;
    }
    if (controller.backToConnectorPicker()) return;
    controller.closeProviderEditor();
  }

  async function setDefaultProvider(id: string): Promise<void> {
    saveFailed.set(false);
    const error = await runtime.patchSettings({ default_provider_id: id });
    if (error) saveFailed.set(true);
  }

  async function confirmDelete(): Promise<void> {
    const id = deleting();
    if (!id || deleteBusy()) return;
    deleteBusy.set(true);
    saveFailed.set(false);
    const error = await runtime.deleteProvider(id);
    deleteBusy.set(false);
    if (error) saveFailed.set(true);
    deleting.set(null);
  }

  /** What the runtime itself says (a fresh GET, not the snapshot): the test reads it from `api-state`. */
  const apiState = signal("");
  let seq = 0;
  const refreshApi = async () => {
    const api = runtime.client;
    if (!api) return;
    const [providers, servers] = await Promise.all([api.providers(), api.mcpServers()]);
    apiState.set(
      JSON.stringify({
        seq: (seq += 1),
        providers: providers.map((row) => ({ id: row.id, name: row.name, url: row.base_url, key: row.key_set, models: row.models, default: row.default_model })),
        mcp: servers.map((row) => ({ name: row.name, transport: row.transport, command: row.command, args: row.args, url: row.url, enabled: row.enabled, note: row.usage_note })),
      }),
    );
  };
  /** Takes away what a test made (names starting with "T-"), so the next file finds the fixture as it was. */
  const cleanup = async () => {
    const api = runtime.client;
    if (!api) return;
    for (const row of await api.providers()) if (row.name.startsWith("T-")) await api.deleteProvider(row.id);
    for (const row of await api.mcpServers()) if (row.name.startsWith("T-")) await api.deleteMcpServer(row.id);
    await refreshApi();
  };

  return (
    <Scroll class="flex-1 bg-bg">
      <View class="flex-col gap-4 p-6">
        <If when={saveFailed()}>
          <Text testID="story-save-failed" class="text-[12px] font-medium text-warn-text">
            {copy().settings.saveFailed}
          </Text>
        </If>
        <ProvidersTab
          providerSaving={controller.providerSaving}
          openAddProvider={() => controller.openAddProvider()}
          openEditProvider={(id) => controller.openEditProvider(id)}
          openProviderModels={(id) => controller.openProviderModels(id)}
          openDeleteProviderConfirm={(id) => deleting.set(id)}
          setDefaultProvider={setDefaultProvider}
          setProviderDefaultModel={(id, model) => controller.setProviderDefaultModel(id, model)}
        />
        <SettingsCard testID="mcp-card">
          <McpSettings />
        </SettingsCard>
        <View class="flex-row items-center gap-3">
          <View role="button" testID="api-refresh" onPress={() => void refreshApi()} class="px-2 py-1 border border-line rounded-(--radius-sm)">
            <Text class="text-[12px]">GET</Text>
          </View>
          <View role="button" testID="api-cleanup" onPress={() => void cleanup()} class="px-2 py-1 border border-line rounded-(--radius-sm)">
            <Text class="text-[12px]">cleanup</Text>
          </View>
          <Text testID="api-state" class="text-[11px] text-ink-muted">{apiState()}</Text>
        </View>
      </View>
      <ProviderEditorFlyout
        providerEditor={providerEditor()}
        providerDetailModel={controller.providerDetailModel}
        onProviderDetailModelChange={(model) => (controller.providerDetailModel = model)}
        providerSaving={controller.providerSaving}
        providerSavedTick={controller.providerSavedTick}
        backFromProviderEditor={backFromProviderEditor}
        closeProviderEditor={() => controller.closeProviderEditor()}
        editorKeySet={(target) => controller.editorKeySet(target)}
        setProviderDraft={(draft) => controller.setProviderDraft(draft)}
        pickConnector={(id) => controller.pickConnector(id)}
        fetchProviderModels={() => controller.fetchProviderModels()}
        persistProviderEditor={(editor) => controller.persistProviderEditor(editor)}
        measure={(target, model) => runtime.speedTest(target, model)}
      />
      <If when={deleting()}>
        <DangerDialog
          copy={dangerCopy("provider", copy())}
          busy={deleteBusy()}
          onDismiss={() => deleting.set(null)}
          onConfirm={() => void confirmDelete()}
        />
      </If>
    </Scroll>
  );
}
