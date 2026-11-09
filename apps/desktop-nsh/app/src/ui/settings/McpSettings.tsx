/**
 * The MCP servers page (`settings/McpSettings.svelte`): the list (search, an on/off box per
 * server, "add") and the editor over it. The editor is a `Modal` (540 wide; the whole page on a
 * phone). A saved server's name and usage note save themselves a moment after typing stops
 * (`Autosave`, 600 ms) and once more when the editor closes; changing how it connects (command,
 * arguments, address, headers, token, transport) waits for the button, which asks for a second
 * press ("confirm") first. Adding always asks twice. Reads and writes through `runtime`.
 *
 * Props: `closeSettings` (kept for parity; unused, as in the Svelte one); `registerBack`: called
 * once with a `backFromEditor()` for the settings shell's Back (true when an editor was open and
 * is now closed), the Svelte component's exported method.
 *
 * Test ids: `mcp-add`, `mcp-search`, `mcp-search-clear`, `mcp-server-<id>` (opens it),
 * `mcp-enable-<id>`, `mcp-editor-<field>` (`name`, `transport`, `url`, `headers`, `auth`,
 * `command`, `args`, `usage-note`, `enabled`), `mcp-submit`, `mcp-cancel`, `mcp-delete`.
 */
import { cleanup, effect, signal, Text, View } from "nsh";
import type { McpServer } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { Autosave } from "../../m/autosave.svelte.ts";
import {
  formatMcpArgs,
  formatMcpHeaders,
  mapMcpError,
  mcpConnectionDirty,
  planMcpSafePatch,
  requestMcpAdd,
  requestMcpSave,
  type McpDraft,
  type McpFieldErrors,
} from "../../m/settings/mcp-form.ts";
import { filterMcpServers, mcpConnectionSummary } from "../../m/settings/mcp-list.ts";
import { Checkbox } from "../Checkbox";
import { Modal, ModalAction, narrowWindow } from "../Modal";
import { Select } from "../Select";
import { tip } from "../tip";
import { AutosaveState } from "./AutosaveState";
import { Field, FieldError, FieldHint, TextField } from "./provider-fields";

function emptyDraft(): McpDraft {
  return { name: "", transport: "stdio", command: "", args: "", url: "", headers: "", auth: "", enabled: true, usageNote: "" };
}

function draftOf(server: McpServer): McpDraft {
  return {
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: formatMcpArgs(server.args),
    url: server.url ?? "",
    headers: formatMcpHeaders(server.headers),
    auth: "",
    enabled: server.enabled,
    usageNote: server.usage_note ?? "",
  };
}

export function McpSettings(props: { closeSettings?: () => void; registerBack?: (back: () => boolean) => void }) {
  const t = () => copy().settings;
  const servers = () => runtime.snapshot.mcpServers;
  const query = signal("");
  const filteredServers = () => filterMcpServers(servers(), query());
  const editor = signal<string | null>(null);
  const editing = () => servers().find((server) => server.id === editor());
  const draft = signal<McpDraft>(emptyDraft());
  const phase = signal<"edit" | "confirm">("edit");
  const errors = signal<McpFieldErrors>({});
  const failed = signal(false);
  const listFailed = signal(false);
  const busy = signal(false);
  const autosave = new Autosave();
  const toggling = signal<string[]>([]);
  let saveQueued: { id: string; draft: McpDraft } | null = null;
  let latestEditor: { id: string; draft: McpDraft } | null = null;
  const connectionDirty = () => {
    const server = editing();
    return server ? mcpConnectionDirty(server, draft()) : false;
  };
  const showSubmit = () => editor() === "add" || connectionDirty() || phase() === "confirm";

  effect(() => {
    if (editor() && editor() !== "add" && !editing() && !busy()) closeEditor();
  });

  effect(() => {
    const open = editor();
    latestEditor = open && open !== "add" ? { id: open, draft: draft() } : null;
  });

  cleanup(() => {
    autosave.cancel();
    if (latestEditor) void persistSafeFields(latestEditor.id, latestEditor.draft);
  });

  function openEditor(server?: McpServer): void {
    draft.set(server ? draftOf(server) : emptyDraft());
    phase.set("edit");
    errors.set({});
    failed.set(false);
    autosave.savedTick = 0;
    autosave.cancel();
    editor.set(server?.id ?? "add");
  }

  function backFromEditor(): boolean {
    if (!editor()) return false;
    closeEditor();
    return true;
  }
  props.registerBack?.(backFromEditor);

  function closeEditor(): void {
    if (busy()) return;
    const open = editor();
    if (open && open !== "add") flushSafeSave(open, draft());
    editor.set(null);
    draft.set(emptyDraft());
    phase.set("edit");
    errors.set({});
    failed.set(false);
    autosave.savedTick = 0;
  }

  function change(partial: Partial<McpDraft>, safe: boolean): void {
    draft.set({ ...draft(), ...partial });
    phase.set("edit");
    errors.set({});
    failed.set(false);
    if (safe && editor() && editor() !== "add") scheduleSafeSave();
  }

  function scheduleSafeSave(delay = 600): void {
    autosave.schedule(() => {
      const open = editor();
      if (open && open !== "add") void persistSafeFields(open, draft());
    }, delay);
  }

  function flushSafeSave(id: string, current: McpDraft): void {
    autosave.cancel();
    void persistSafeFields(id, current);
  }

  async function persistSafeFields(id: string, current: McpDraft): Promise<void> {
    const server = runtime.snapshot.mcpServers.find((row) => row.id === id);
    if (!server) return;
    if (autosave.saving || busy()) {
      saveQueued = { id, draft: current };
      return;
    }
    const plan = planMcpSafePatch(server, current);
    if (!plan.ok) {
      if (editor() === id) errors.set({ ...errors(), ...plan.errors });
      return;
    }
    if (Object.keys(plan.patch).length === 0) return;
    autosave.saving = true;
    failed.set(false);
    const error = await runtime.patchMcpServer(id, plan.patch);
    autosave.saving = false;
    if (error) {
      const mapped = mapMcpError(error.message);
      if (editor() === id) {
        if ("top" in mapped) failed.set(true);
        else errors.set(mapped);
      } else {
        listFailed.set(true);
      }
    } else if (editor() === id) {
      autosave.savedTick += 1;
    }
    if (saveQueued) {
      const queued = saveQueued;
      saveQueued = null;
      void persistSafeFields(queued.id, queued.draft);
    }
  }

  async function submit(): Promise<void> {
    const open = editor();
    if (busy() || !open) return;
    failed.set(false);
    errors.set({});
    const server = editing();
    const plan = open === "add" ? requestMcpAdd(phase(), draft()) : server ? requestMcpSave(phase(), server, draft()) : null;
    if (!plan) return;
    if (!plan.ok) {
      errors.set(plan.errors);
      phase.set("edit");
      return;
    }
    if (plan.phase === "confirm") {
      phase.set("confirm");
      return;
    }
    busy.set(true);
    const error =
      "body" in plan
        ? await runtime.createMcpServer(plan.body)
        : Object.keys(plan.patch).length > 0
          ? await runtime.patchMcpServer(open, plan.patch)
          : null;
    busy.set(false);
    if (!error) {
      query.set("");
      closeEditor();
      return;
    }
    const mapped = mapMcpError(error.message);
    if ("top" in mapped) failed.set(true);
    else {
      errors.set(mapped);
      phase.set("edit");
    }
  }

  async function removeServer(): Promise<void> {
    const server = editing();
    if (!server || busy()) return;
    failed.set(false);
    busy.set(true);
    const error = await runtime.deleteMcpServer(server.id);
    busy.set(false);
    if (error) failed.set(true);
    else closeEditor();
  }

  async function toggleEnabled(server: McpServer): Promise<void> {
    if (toggling().includes(server.id)) return;
    listFailed.set(false);
    toggling.set([...toggling(), server.id]);
    const error = await runtime.patchMcpServer(server.id, { enabled: !server.enabled });
    toggling.set(toggling().filter((id) => id !== server.id));
    if (error) listFailed.set(true);
  }

  const submitLabel = () =>
    phase() === "confirm"
      ? editor() === "add"
        ? t().mcpConfirmAdd
        : t().mcpConfirmEdit
      : editor() === "add"
        ? t().mcpAdd
        : t().mcpConfirmEdit;
  const submitOnReturn = () => (showSubmit() ? void submit() : undefined);
  const backLabel = () => (runtime.snapshot.settings.locale === "en" ? "Back to MCP servers" : "返回 MCP 扩展");

  return (
    <View testID="mcp-settings" class="flex-col gap-3 min-w-0">
      <View class="flex-col gap-5">
        <View class="flex-row items-center justify-between gap-3">
          <Text role="header" class="text-[14px] font-semibold text-ink">
            {t().sectionMcpServers}
          </Text>
          <View
            role="button"
            testID="mcp-add"
            accessibilityLabel={t().sectionMcpAdd}
            onPress={() => openEditor()}
            class="cursor-pointer select-none shrink-0 border border-line rounded-(--radius-sm) bg-pane px-[10px] py-[7px] hover:border-accent-border hover:bg-accent-tint"
          >
            <Text class="text-[13px] font-semibold text-brand">{t().sectionMcpAdd}</Text>
          </View>
        </View>
        <If when={servers().length > 0}>
          <View class="flex-row items-center gap-3">
            <View class="flex-1 min-w-0">
              <TextField testID="mcp-search" label={t().mcpSearch} placeholder={t().mcpSearch} value={query()} onInput={(value) => query.set(value)} />
            </View>
            <If when={query()}>
              <View role="button" testID="mcp-search-clear" accessibilityLabel={t().mcpClearSearch} onPress={() => query.set("")} class="cursor-pointer select-none shrink-0 justify-center">
                <Text class="text-[12px] font-medium text-brand">{t().mcpClearSearch}</Text>
              </View>
            </If>
          </View>
        </If>
        <If when={listFailed()}>
          <FieldError testID="mcp-list-failed">{t().saveFailed}</FieldError>
        </If>
      </View>
      <View role="region" accessibilityLabel={t().sectionMcpServers} testID="mcp-server-list" class="flex-col gap-2 p-[2px]">
        <If when={filteredServers().length === 0}>
          <View testID="mcp-empty" class="p-6 items-center">
            <Text class="text-[13px] text-ink-muted text-center">{servers().length === 0 ? t().mcpEmpty : t().mcpNoResults}</Text>
          </View>
        </If>
        <Each of={filteredServers()} key={(server) => server.id}>
          {(server) => (
            <View
              testID={`mcp-card-${server().id}`}
              class={`flex-row items-center gap-3 min-w-0 pr-3 border border-line rounded-(--radius-md) hover:border-accent-border ${server().enabled ? "bg-pane" : "bg-sidebar-bg"}`}
            >
              <View
                role="button"
                testID={`mcp-server-${server().id}`}
                accessibilityLabel={`${t().mcpEdit}: ${server().name}`}
                onPress={() => openEditor(server())}
                class="cursor-pointer select-none flex-col gap-[6px] flex-1 min-w-0 p-3 rounded-(--radius-md)"
              >
                <Text tooltip={tip(server().name)} class="text-[14px] font-semibold text-ink line-clamp-1">
                  {server().name}
                </Text>
                <View class="flex-row items-center gap-4 min-w-0 max-w-full">
                  <View class="shrink-0 border border-chip-line bg-chip rounded-(--radius-xs) px-[6px] py-[1px]">
                    <Text class="text-[10px] font-semibold text-ink-muted">{server().transport === "http" ? "HTTP" : "stdio"}</Text>
                  </View>
                  <Text tooltip={tip(mcpConnectionSummary(server()))} class="font-mono text-[12px] text-ink-muted line-clamp-1 shrink">
                    {mcpConnectionSummary(server())}
                  </Text>
                </View>
              </View>
              <Checkbox
                testID={`mcp-enable-${server().id}`}
                class="shrink-0"
                label={t().mcpEnabled}
                accessibilityLabel={`${t().mcpEnabled}: ${server().name}`}
                checked={server().enabled}
                disabled={toggling().includes(server().id)}
                onChange={() => void toggleEnabled(server())}
              />
            </View>
          )}
        </Each>
      </View>
      <If when={editor()}>
        <Modal
          testID="mcp-editor"
          title={editor() === "add" ? t().sectionMcpAdd : t().mcpEdit}
          closeLabel={copy().common.close}
          backLabel={backLabel()}
          width={540}
          maxHeight={0.88}
          pageOnPhone
          busy={busy()}
          onClose={closeEditor}
          headExtra={
            <If when={editor() !== "add" && !narrowWindow()}>
              <AutosaveState saving={autosave.saving} failed={failed()} saved={autosave.savedTick > 0} />
            </If>
          }
          foot={
            <>
              <If when={showSubmit()}>
                <ModalAction kind="primary" testID="mcp-submit" disabled={busy()} onPress={() => void submit()}>
                  {submitLabel()}
                </ModalAction>
              </If>
              <ModalAction testID="mcp-cancel" disabled={busy()} onPress={closeEditor}>
                {t().mcpCancel}
              </ModalAction>
              <If when={editing()}>
                <ModalAction kind="deny" testID="mcp-delete" disabled={busy()} onPress={() => void removeServer()}>
                  {t().mcpDelete}
                </ModalAction>
              </If>
            </>
          }
        >
          <Text class="text-[12px] text-ink-muted">{t().mcpMustConfirm}</Text>
          <If when={failed()}>
            <FieldError testID="mcp-editor-failed">{t().saveFailed}</FieldError>
          </If>
          <Field label={t().mcpName} labelID="mcp-editor-name-label">
            <TextField
              testID="mcp-editor-name"
              label={t().mcpName}
              autoFocus
              readonly={busy()}
              invalid={Boolean(errors().name)}
              value={draft().name}
              onInput={(name) => change({ name }, true)}
              onSubmit={submitOnReturn}
            />
            <If when={errors().name}>
              <FieldError testID="mcp-editor-name-error">{t().mcpNameEmpty}</FieldError>
            </If>
          </Field>
          <Field label={t().mcpTransport} labelID="mcp-editor-transport-label">
            <Select
              testID="mcp-editor-transport"
              ariaLabel={t().mcpTransport}
              disabled={busy()}
              value={draft().transport}
              options={[
                { value: "stdio", label: t().mcpTransportStdio },
                { value: "http", label: t().mcpTransportHttp },
              ]}
              onChange={(transport) => change({ transport: transport === "http" ? "http" : "stdio" }, false)}
            />
          </Field>
          <If
            when={draft().transport === "http"}
            else={
              <>
                <Field label={t().mcpCommand} labelID="mcp-editor-command-label">
                  <TextField
                    testID="mcp-editor-command"
                    label={t().mcpCommand}
                    mono
                    readonly={busy()}
                    invalid={Boolean(errors().command)}
                    value={draft().command}
                    onInput={(command) => change({ command }, false)}
                    onSubmit={submitOnReturn}
                  />
                  <If when={errors().command}>
                    <FieldError testID="mcp-editor-command-error">{t().mcpCommandEmpty}</FieldError>
                  </If>
                </Field>
                <Field label={t().mcpArgs} labelID="mcp-editor-args-label">
                  <TextField
                    testID="mcp-editor-args"
                    label={t().mcpArgs}
                    mono
                    readonly={busy()}
                    value={draft().args}
                    onInput={(args) => change({ args }, false)}
                    onSubmit={submitOnReturn}
                  />
                </Field>
              </>
            }
          >
            <Field label={t().mcpUrl} labelID="mcp-editor-url-label">
              <TextField
                testID="mcp-editor-url"
                label={t().mcpUrl}
                mono
                readonly={busy()}
                invalid={Boolean(errors().url)}
                value={draft().url}
                onInput={(url) => change({ url }, false)}
                onSubmit={submitOnReturn}
              />
              <If when={errors().url}>
                <FieldError testID="mcp-editor-url-error">{errors().url === "invalid" ? t().mcpUrlInvalid : t().mcpUrlEmpty}</FieldError>
              </If>
            </Field>
            <Field label={t().mcpHeaders} labelID="mcp-editor-headers-label">
              <TextField
                testID="mcp-editor-headers"
                label={t().mcpHeaders}
                mono
                multiline
                readonly={busy()}
                value={draft().headers}
                onInput={(headers) => change({ headers }, false)}
              />
            </Field>
            <Field label={t().mcpAuth} labelID="mcp-editor-auth-label">
              <TextField
                testID="mcp-editor-auth"
                label={t().mcpAuth}
                masked
                readonly={busy()}
                placeholder={editing()?.auth_set ? "••••" : ""}
                value={draft().auth}
                onInput={(auth) => change({ auth }, false)}
                onSubmit={submitOnReturn}
              />
              <FieldHint>{t().mcpAuthHint}</FieldHint>
            </Field>
          </If>
          <Field label={t().mcpUsageNote} labelID="mcp-editor-usage-note-label">
            <TextField
              testID="mcp-editor-usage-note"
              label={t().mcpUsageNote}
              multiline
              readonly={busy()}
              placeholder={t().mcpUsageNotePlaceholder}
              value={draft().usageNote}
              onInput={(usageNote) => change({ usageNote }, true)}
              class="min-h-[88px]"
            />
            <FieldHint>{t().mcpUsageNoteHint}</FieldHint>
          </Field>
          <If when={editor() === "add"}>
            <Checkbox
              testID="mcp-editor-enabled"
              label={t().mcpEnabled}
              checked={draft().enabled}
              disabled={busy()}
              onChange={(enabled) => change({ enabled }, false)}
            />
          </If>
        </Modal>
      </If>
    </View>
  );
}
