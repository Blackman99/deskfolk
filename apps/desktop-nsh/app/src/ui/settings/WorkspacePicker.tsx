/**
 * The workspace folder field (`settings/WorkspacePicker.svelte`): a button that shows the chosen
 * folder (the whole path is its tooltip) and a second that chooses or changes it.
 *
 * On this computer a press asks the shell's folder dialog through the Tauri bridge
 * (`pickWorkspaceFolder` of `m/settings/pick-workspace.ts`: the host command
 * `tauri.pick_workspace_folder` with `{ current, title }`). Where the Mac is reached remotely
 * (`remote`) there is no dialog, so a panel under the field browses the host's folders through
 * `api.hostTree`: Up, Use this folder, Cancel, and each sub-folder to open.
 *
 * Props: `id` (the field's `testID`, default "workspace"); `path`; `chooseLabel`, `changeLabel`
 * (the second button's words, by whether `path` is empty); `emptyLabel`; `unavailableLabel`;
 * `dialogTitle`; `onChange(path)`; `remote`; `api` (a `MessengerApi` with `hostTree`; needed when
 * `remote`); `browseHint`, `permissionHint`, `truncatedHint`, `confirmHint`; `upLabel`,
 * `useLabel`, `cancelLabel`; `shown(path)` (how the path reads on the button; as it is by default).
 * Test ids: the field `id`, `${id}-choose`, `host-browse`, `host-browse-path`, `host-browse-up`,
 * `host-browse-use`, `host-browse-cancel`, `host-browse-item:<name>`.
 */
import { Scroll, signal, Text, View } from "nsh";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { pickWorkspaceFolder, workspacePickerAvailable, type HostTreePage } from "../../m/settings/pick-workspace.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";

function SmallButton(props: { label: string; disabled?: boolean; onPress: () => void; testID?: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class="cursor-pointer select-none disabled:cursor-default justify-center px-3 py-[6px] rounded-(--radius-md) bg-chip border border-chip-line hover:bg-pane hover:border-line-hover group disabled:opacity-[0.7]"
    >
      <Text class="text-[12px] font-medium text-ink-secondary group-hover:text-brand">{props.label}</Text>
    </View>
  );
}

export function WorkspacePicker(props: {
  id?: string;
  path: string;
  chooseLabel: string;
  changeLabel: string;
  emptyLabel: string;
  unavailableLabel: string;
  dialogTitle: string;
  onChange: (path: string) => void;
  remote?: boolean;
  api?: Pick<MessengerApi, "hostTree"> | null;
  browseHint?: string;
  permissionHint?: string;
  truncatedHint?: string;
  confirmHint?: string;
  upLabel?: string;
  useLabel?: string;
  cancelLabel?: string;
  shown?: (path: string) => string;
}) {
  const id = () => props.id ?? "workspace";
  const busy = signal(false);
  const failed = signal(false);
  const permission = signal(false);
  const browsing = signal(false);
  const page = signal<HostTreePage | null>(null);
  const browseError = signal("");
  const canPick = () => props.remote === true || workspacePickerAvailable();
  const display = () => props.path.trim();
  const actionLabel = () => (display() ? props.changeLabel : props.chooseLabel);

  async function load(dir: string): Promise<void> {
    if (!props.api) return;
    busy.set(true);
    // A folder that failed before says nothing about this one.
    failed.set(false);
    browseError.set("");
    permission.set(false);
    try {
      page.set(await props.api.hostTree(dir));
      browsing.set(true);
    } catch (error) {
      failed.set(true);
      const denied = Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "host_permission");
      permission.set(denied);
      browseError.set(denied ? (props.permissionHint ?? "") : props.unavailableLabel);
    } finally {
      busy.set(false);
    }
  }

  async function choose(): Promise<void> {
    if (busy()) return;
    if (props.remote) {
      if (!props.api) {
        failed.set(true);
        return;
      }
      await load(props.path.trim() || "");
      return;
    }
    if (!canPick()) {
      failed.set(true);
      return;
    }
    busy.set(true);
    failed.set(false);
    try {
      const picked = await pickWorkspaceFolder(props.path, props.dialogTitle);
      if (picked) props.onChange(picked);
    } catch {
      failed.set(true);
    } finally {
      busy.set(false);
    }
  }

  function useCurrent(): void {
    const current = page();
    if (!current) return;
    props.onChange(current.path);
    browsing.set(false);
  }

  return (
    <View class="flex-col">
      <View role="group" accessibilityLabel={props.dialogTitle} class="flex-row flex-wrap gap-2 items-stretch">
        <View
          role="button"
          testID={id()}
          accessibilityLabel={display() || props.emptyLabel}
          accessibilityState={{ busy: busy(), disabled: busy() }}
          tooltip={tip(display() || props.emptyLabel)}
          disabled={busy()}
          onPress={() => void choose()}
          class="cursor-pointer select-none disabled:cursor-default flex-1 min-w-[192px] flex-row items-center gap-2 px-3 py-2 rounded-(--radius-md) bg-input-bg border border-line hover:border-line-hover focus-visible:border-field-focus-border disabled:opacity-[0.7]"
        >
          <Icon name="folder" size={16} class="tint-ink-muted" />
          <Text class={`flex-1 min-w-0 line-clamp-1 font-mono text-[13px] ${display() ? "text-ink" : "text-ink-muted"}`}>
            {display() ? (props.shown ? props.shown(display()) : display()) : props.emptyLabel}
          </Text>
        </View>
        <SmallButton testID={`${id()}-choose`} label={actionLabel()} disabled={busy()} onPress={() => void choose()} />
      </View>
      <If
        when={permission() && props.permissionHint}
        else={
          <If when={!canPick() || failed()}>
            <Text testID={`${id()}-hint`} class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">
              {browseError() || props.unavailableLabel}
            </Text>
          </If>
        }
      >
        <Text testID={`${id()}-hint`} class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">
          {props.permissionHint}
        </Text>
      </If>
      <If when={browsing() ? page() : null}>
        {(current: () => HostTreePage) => (
          <View
            role="group"
            testID="host-browse"
            accessibilityLabel={props.dialogTitle}
            class="flex-col mt-2 w-full px-3 py-[10px] rounded-(--radius-md) bg-input-bg border border-line"
          >
            <Text testID="host-browse-path" class="mb-[6px] line-clamp-1 font-mono text-[13px] text-ink">
              {current().path}
            </Text>
            <If when={props.browseHint}>
              <Text class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">{props.browseHint}</Text>
            </If>
            <If when={props.confirmHint}>
              <Text class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">{props.confirmHint}</Text>
            </If>
            <View class="flex-row flex-wrap gap-2 my-2">
              <SmallButton
                testID="host-browse-up"
                label={props.upLabel ?? "Up"}
                disabled={!current().parent || busy()}
                onPress={() => void load(current().parent ?? "")}
              />
              <SmallButton testID="host-browse-use" label={props.useLabel ?? "Use this folder"} onPress={useCurrent} />
              <SmallButton testID="host-browse-cancel" label={props.cancelLabel ?? "Cancel"} onPress={() => browsing.set(false)} />
            </View>
            <Scroll class="max-h-48">
              <View class="flex-col">
                <Each of={current().items.filter((row) => row.kind === "dir")} key={(row) => row.path}>
                  {(row) => (
                    <View
                      role="button"
                      testID={`host-browse-item:${row().name}`}
                      accessibilityLabel={row().name}
                      onPress={() => void load(row().path)}
                      class="cursor-pointer select-none w-full px-2 py-[6px] rounded-(--radius-sm) hover:bg-row-hover"
                    >
                      <Text class="line-clamp-1 font-mono text-[13px] text-ink">
                        {row().name}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </Scroll>
            <If when={current().truncated}>
              <Text class="mt-[6px] text-[12px] leading-[1.4] text-ink-muted">{props.truncatedHint}</Text>
            </If>
          </View>
        )}
      </If>
    </View>
  );
}
