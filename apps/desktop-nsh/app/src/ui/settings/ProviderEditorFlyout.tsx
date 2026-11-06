/**
 * The endpoint editor that slides over the settings (`settings/ProviderEditorFlyout.svelte`): a
 * `Modal` (580 wide; the whole page on a phone) with the head's title (add / connection / models /
 * model settings), the autosave state, the connector tiles while adding or the `ProviderForm`
 * after, and on a phone the name and host above the form and a status line under it.
 *
 * The shell owns the editor state and the controller (`m/settings/provider-editor.svelte.ts`); this
 * only reads `providerEditor` and calls what it is given. Differences from the Svelte flyout:
 * the shell's `providerForm` ref is gone, `providerDetailModel` goes with `onProviderDetailModelChange`
 * instead of `bind:`, and the head's back chevron and ✕ are `Modal`'s own (a phone's chevron steps
 * back, a desktop's ✕ closes), not `SettingsSubpageButton`s.
 *
 * Props: `providerEditor`; `providerDetailModel`; `onProviderDetailModelChange`; `providerSaving`;
 * `providerSavedTick`; `pendingCredentials` (the modal's block, drawn at the top); `backFromProviderEditor`;
 * `closeProviderEditor`; `editorKeySet(target)`; `setProviderDraft`; `pickConnector`;
 * `fetchProviderModels`; `persistProviderEditor`; `measure(target, model)` (the speed test).
 */
import { computed, Text, View, type JSX } from "nsh";
import type { ConnectorId, ModelSpeed } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { providerHost, type ProviderDraft, type ProviderEditorState } from "../../m/settings/provider-form.ts";
import { Modal, narrowWindow } from "../Modal";
import { AutosaveState } from "./AutosaveState";
import { ConnectorPicker } from "./ConnectorPicker";
import { ProviderForm } from "./ProviderForm";

export function ProviderEditorFlyout(props: {
  providerEditor: ProviderEditorState | null;
  providerDetailModel: string | null;
  onProviderDetailModelChange: (model: string | null) => void;
  providerSaving: boolean;
  providerSavedTick: number;
  pendingCredentials?: JSX.Element;
  backFromProviderEditor: () => void;
  closeProviderEditor: () => void;
  editorKeySet: (target: "add" | string) => boolean;
  setProviderDraft: (draft: ProviderDraft) => void;
  pickConnector: (id: ConnectorId | null) => void;
  fetchProviderModels: () => Promise<void>;
  persistProviderEditor: (editor: ProviderEditorState) => Promise<void>;
  measure?: (target: string, model: string) => Promise<{ ok: true; speed: ModelSpeed } | { ok: false; error: string }>;
}) {
  const t = () => copy();
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const editor = () => props.providerEditor;
  const hasErrors = () => {
    const e = editor();
    return Boolean(e && (e.failed || Object.values(e.errors).some(Boolean)));
  };
  const title = () => {
    const e = editor();
    if (!e) return "";
    if (props.providerDetailModel) return t().settings.modelSettings;
    if (e.target === "add") return t().settings.providerAdd;
    return e.view === "models" ? t().settings.providerModels : t().settings.providerConnection;
  };
  const backLabel = () => (props.providerDetailModel ? t().common.back : locale() === "en" ? "Back to model providers" : "返回模型服务");
  const statusLine = () =>
    props.providerSaving
      ? t().sidebar.autoSaving
      : hasErrors()
        ? t().settings.saveFailed
        : props.providerSavedTick > 0
          ? t().sidebar.autoSaved
          : t().sidebar.autoSaveHint;
  const prefix = () => (editor()?.target === "add" ? "provider-add" : `provider-${editor()?.target}`);

  /** Changes only when the editor moves to another endpoint or view, so the form starts fresh then and not on every key. */
  const formKey = computed(() => {
    const e = editor();
    return e ? `${e.target}:${e.view}` : "";
  });
  const form = () => {
    void formKey();
    return (
      <ProviderForm
        draft={editor()!.draft}
        errors={editor()!.errors}
        failed={editor()!.failed}
        fetching={editor()!.fetching}
        fetchError={editor()!.fetchError}
        view={editor()!.view}
        fieldPrefix={prefix()}
        keySet={props.editorKeySet(editor()!.target)}
        detailModel={props.providerDetailModel}
        onDetailModelChange={props.onProviderDetailModelChange}
        onChange={props.setProviderDraft}
        onFetch={() => void props.fetchProviderModels()}
        measure={editor()!.target === "add" || !props.measure ? undefined : (model) => props.measure!((editor() as ProviderEditorState).target, model)}
      />
    );
  };

  return (
    <If when={runtime.settingsOpen && editor()}>
      <Modal
        testID="provider-editor"
        title={title()}
        closeLabel={t().common.close}
        backLabel={backLabel()}
        width={580}
        maxHeight={0.88}
        pageOnPhone
        onClose={() => (narrowWindow() ? props.backFromProviderEditor() : props.closeProviderEditor())}
        headExtra={
          <If when={!narrowWindow()}>
            <AutosaveState saving={props.providerSaving} failed={editor()?.failed === true} saved={props.providerSavedTick > 0} />
          </If>
        }
        bodyClass={narrowWindow() ? "px-4 pt-5 pb-6 gap-4" : "px-5 py-[18px] gap-[14px]"}
        foot={
          <If when={narrowWindow()}>
            <View testID="provider-mobile-status" class="flex-1 flex-row items-center justify-center gap-3">
              <Text testID="provider-mobile-status-text" class={`text-[12px] ${hasErrors() ? "text-danger-text" : "text-ink-muted"}`}>
                {statusLine()}
              </Text>
              <If when={editor()?.failed}>
                <View
                  role="button"
                  testID="provider-retry"
                  accessibilityLabel={t().settings.retry}
                  disabled={props.providerSaving}
                  onPress={() => editor() && void props.persistProviderEditor(editor()!)}
                  class="min-h-11 px-3 justify-center rounded-(--radius-sm) bg-danger-bg disabled:opacity-[0.45]"
                >
                  <Text class="text-[13px] text-danger-text">{t().settings.retry}</Text>
                </View>
              </If>
            </View>
          </If>
        }
      >
        {props.pendingCredentials}
        <If when={narrowWindow() && editor()?.target !== "add"}>
          <View testID="provider-editor-context" class="flex-col gap-1 mb-1">
            <Text class="text-[20px] font-semibold text-ink">{editor()?.draft.name ?? ""}</Text>
            <Text class="text-[12px] text-ink-muted">{providerHost(editor()?.draft.baseUrl)}</Text>
          </View>
        </If>
        <If when={editor()?.picking} else={<>{() => form()}</>}>
          <ConnectorPicker onPick={props.pickConnector} />
        </If>
      </Modal>
    </If>
  );
}
