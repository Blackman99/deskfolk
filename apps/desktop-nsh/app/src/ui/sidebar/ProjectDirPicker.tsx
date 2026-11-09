/**
 * The sheet's directories for one agent (`ProjectDirPicker.svelte`, ADR 0095). To start a session
 * (`new`): each directory one press away, then a directory of your own, typed or picked on this
 * computer, browsed on the Mac's disk from a phone (there is no folder dialog there). To carry a
 * terminal session on (`import`): the directories that have any, one open at a time, with their
 * sessions.
 *
 * Props: `agent`, `mode`, `items` (the terminal sessions the sheet read once; null while they are
 * on the way), `sessions` (the app's own, for directories used only here), `onDone` (the session is
 * made and open: the first-launch wizard comes down on it).
 *
 * Not as in the messenger: the "carry on" form is the last thing of the open directory, not stuck
 * to the bottom of the scrolling body (NSH has no `position: sticky`).
 */
import { signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { ClaudeCodeSessionListing, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { importRequest, importSubtitle, newProjectRequest, tildePath } from "../../m/sidebar/import-claude-session";
import { dirDisplay, isAbsoluteDir, listingSpansAccounts, pickerDirs } from "../../m/sidebar/project-groups";
import { pickWorkspaceFolder, workspacePickerAvailable } from "../../m/settings/pick-workspace";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { FieldError, FieldHint } from "../settings/provider-fields";
import { WorkspacePicker } from "../settings/WorkspacePicker";
import { tip } from "../tip";

/** The open directory, or `OTHER` for the typed one. */
const OTHER = "\u0000other";
/** How many of a directory's sessions show before you ask for the rest. */
const FIRST = 8;

export function ProjectDirPicker(props: {
  agent: ProjectAgent;
  mode: "new" | "import";
  items: ClaudeCodeSessionListing[] | null;
  sessions: readonly SessionSummary[];
  onDone?: () => void;
}) {
  const t = () => copy();
  const dirs = () => pickerDirs(props.items ?? [], props.sessions, props.agent).filter((entry) => props.mode === "new" || entry.listings.length > 0);
  const accounts = () => listingSpansAccounts(props.items ?? []);
  const open = signal<string | null>(null);
  /** With nothing to list, the typed directory is all there is: open it. */
  const shown = () => open() ?? (props.mode === "new" && dirs().length === 0 ? OTHER : null);

  const allShown = signal(false);
  const picked = signal<ClaudeCodeSessionListing | null>(null);
  const typed = signal("");
  const pending = signal(false);
  const startError = signal<"invalid" | "failed" | null>(null);
  const importError = signal<"missing" | "failed" | null>(null);
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  const now = Date.now();
  const canPick = workspacePickerAvailable();
  const phone = () => narrowWindow();

  function toggle(key: string): void {
    open.set(shown() === key ? null : key);
    allShown.set(false);
    picked.set(null);
    startError.set(null);
    importError.set(null);
  }

  function accountOf(listing: ClaudeCodeSessionListing): string | null {
    if (!accounts()) return null;
    return listing.config_dir ? tildePath(listing.config_dir) : t().project.defaultAccount;
  }

  async function start(dir: string): Promise<void> {
    if (pending()) return;
    if (!isAbsoluteDir(dir)) {
      startError.set("invalid");
      return;
    }
    pending.set(true);
    startError.set(null);
    const failure = await runtime.createProjectSession(newProjectRequest(dir, props.agent));
    pending.set(false);
    if (failure) startError.set(failure.status === 422 || failure.status === 404 ? "invalid" : "failed");
    else props.onDone?.();
  }

  async function carryOn(): Promise<void> {
    const session = picked();
    if (!session || pending()) return;
    pending.set(true);
    importError.set(null);
    const failure = await runtime.createProjectSession(importRequest(session));
    pending.set(false);
    // A session file that went away since the list was read.
    if (failure) importError.set(failure.status === 404 ? "missing" : "failed");
    else props.onDone?.();
  }

  async function pickFolder(): Promise<void> {
    try {
      const folder = await pickWorkspaceFolder(typed(), t().project.pickTitle);
      if (folder) {
        typed.set(folder);
        startError.set(null);
      }
    } catch {
      startError.set("failed");
    }
  }

  const startFailure = () => (
    <If when={startError()}>
      {(error) => <FieldError testID="project-error">{error() === "invalid" ? t().project.dirInvalid : t().sidebar.saveFailed}</FieldError>}
    </If>
  );

  /** The name and the path of a directory, side by side. */
  const names = (label: string, path?: string) => (
    <View class="flex-1 min-w-0 flex-row items-baseline gap-2">
      <Text class="shrink-0 max-w-[60%] text-[13px] font-semibold text-ink line-clamp-1">{label}</Text>
      <If when={path}>{(p) => <Text class="min-w-0 shrink text-[12px] text-ink-muted line-clamp-1">{p()}</Text>}</If>
    </View>
  );

  return (
    <View testID="project-dirs" class="flex-col gap-[2px]">
      <If when={props.mode === "new" && shown() !== OTHER}>{startFailure()}</If>
      <If when={props.mode === "import" && props.items && dirs().length === 0}>
        <FieldHint testID="import-empty">{t().sidebar.importClaudeEmpty}</FieldHint>
      </If>
      <Each of={dirs()} key={(entry) => entry.dir}>
        {(entry) => (
          <If
            when={props.mode === "new"}
            else={
              <View testID={`picker-dir-${entry().dir}`} class={`flex-col ${shown() === entry().dir ? "rounded-(--radius-md) bg-line-subtle" : ""}`}>
                <View
                  role="button"
                  testID={`picker-head-${entry().dir}`}
                  accessibilityLabel={entry().label}
                  accessibilityState={{ expanded: shown() === entry().dir }}
                  tooltip={tip(entry().dir)}
                  onPress={() => toggle(entry().dir)}
                  class="cursor-pointer select-none flex-row items-center gap-2 w-full min-h-[44px] px-[10px] py-[6px] rounded-(--radius-md) hover:bg-row-hover"
                >
                  <Icon name={shown() === entry().dir ? "chevron-down" : "chevron-right"} size={12} class="tint-ink-muted" />
                  <Icon name="folder" size={16} class="tint-ink" />
                  {names(entry().label, tildePath(entry().dir))}
                  <If when={entry().listings.length > 0}>
                    <Text tooltip={tip(t().project.dirSessions(entry().listings.length))} class="shrink-0 text-[12px] text-ink-muted">
                      {String(entry().listings.length)}
                    </Text>
                  </If>
                </View>
                <If when={shown() === entry().dir && entry().listings.length > 0}>
                  <View class={`flex-col gap-2 pt-[2px] pr-[10px] pb-3 ${phone() ? "pl-[14px]" : "pl-[30px]"}`}>
                    <Text class="text-[12px] text-ink-muted">{t().project.carryHead}</Text>
                    <View role="list" accessibilityLabel={t().sidebar.importClaudeList} class="flex-col gap-[2px] -mx-[10px]">
                      <Each of={allShown() ? entry().listings : entry().listings.slice(0, FIRST)} key={(session) => session.session_id}>
                        {(session) => (
                          <View
                            role="button"
                            testID={`import-row-${session().session_id}`}
                            accessibilityLabel={session().title || t().sidebar.importClaudeNoTitle}
                            accessibilityState={{ selected: picked()?.session_id === session().session_id }}
                            onPress={() => {
                              picked.set(session());
                              importError.set(null);
                            }}
                            class={`cursor-pointer select-none flex-col items-start gap-[2px] min-h-[44px] px-[10px] py-[6px] rounded-[8px] min-w-0 hover:bg-row-hover ${picked()?.session_id === session().session_id ? "bg-accent-tint" : ""}`}
                          >
                            <Text class="max-w-full text-[14px] text-ink line-clamp-1">{session().title || t().sidebar.importClaudeNoTitle}</Text>
                            <Text class="max-w-full text-[12px] text-ink-muted line-clamp-1">{importSubtitle(session(), now, locale(), accountOf(session()))}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                    <If when={!allShown() && entry().listings.length > FIRST}>
                      <View class="flex-row">
                        <Button variant="ghost" size="sm" testID="picker-more" onPress={() => allShown.set(true)}>
                          {t().project.showMore(entry().listings.length - FIRST)}
                        </Button>
                      </View>
                    </If>
                    <If when={picked()}>
                      <View testID="import-form" class={`flex-col gap-2 pt-3 -mx-[10px] px-[10px] border-t border-line`}>
                        <FieldHint>{t().sidebar.importClaudeHint}</FieldHint>
                        <If when={importError()}>
                          {(error) => <FieldError testID="import-error">{error() === "missing" ? t().sidebar.importClaudeMissing : t().sidebar.saveFailed}</FieldError>}
                        </If>
                        <View class="flex-row">
                          <Button variant="primary" testID="import-submit" disabled={pending()} onPress={() => void carryOn()}>
                            {t().sidebar.importClaudeSubmit}
                          </Button>
                        </View>
                      </View>
                    </If>
                  </View>
                </If>
              </View>
            }
          >
            {/* One press starts the session there: a directory you have used is a place, not a question. */}
            <View testID={`picker-dir-${entry().dir}`}>
              <View
                role="button"
                testID={`picker-start-${entry().dir}`}
                accessibilityLabel={entry().label}
                tooltip={tip(entry().dir)}
                disabled={pending()}
                onPress={() => void start(entry().dir)}
                class="cursor-pointer select-none disabled:cursor-default group flex-row items-center gap-2 w-full min-h-[44px] px-[10px] py-[6px] rounded-(--radius-md) hover:bg-row-hover disabled:opacity-[0.6]"
              >
                <Icon name="folder" size={16} class="tint-ink" />
                {names(entry().label, tildePath(entry().dir))}
                <Icon name="plus" size={16} class="tint-ink-muted group-hover:tint-brand" />
              </View>
            </View>
          </If>
        )}
      </Each>
      <If when={props.mode === "new"}>
        <View testID="picker-other" class={`flex-col ${shown() === OTHER ? "rounded-(--radius-md) bg-line-subtle" : ""}`}>
          <View
            role="button"
            testID="picker-other-head"
            accessibilityLabel={t().project.otherDir}
            accessibilityState={{ expanded: shown() === OTHER }}
            onPress={() => toggle(OTHER)}
            class="cursor-pointer select-none flex-row items-center gap-2 w-full min-h-[44px] px-[10px] py-[6px] rounded-(--radius-md) hover:bg-row-hover"
          >
            <Icon name={shown() === OTHER ? "chevron-down" : "chevron-right"} size={12} class="tint-ink-muted" />
            <Icon name="plus" size={16} class="tint-ink" />
            {names(t().project.otherDir)}
          </View>
          <If when={shown() === OTHER}>
            <View testID="project-new" class={`flex-col gap-2 pt-[2px] pr-[10px] pb-3 ${phone() ? "pl-[14px]" : "pl-[30px]"}`}>
              <Text class={`${phone() ? "text-[14px]" : "text-[13px]"} font-semibold text-ink-secondary`}>{t().project.dirLabel}</Text>
              <If
                when={runtime.remote}
                else={
                  <View class={`flex-row gap-2 ${phone() ? "flex-col items-stretch" : "items-center"}`}>
                    <Input
                      testID="project-dir"
                      accessibilityLabel={t().project.dirLabel}
                      value={typed()}
                      placeholder={t().project.dirPlaceholder}
                      autoCapitalize="none"
                      autoCorrect={false}
                      submitBehavior="submit"
                      onChange={(e) => {
                        typed.set(e.value);
                        startError.set(null);
                      }}
                      onSubmit={() => void start(typed())}
                      class={`${phone() ? "w-full min-h-12 px-3 text-[16px]" : "flex-1 min-w-0 px-3 py-2 text-[14px]"} text-ink bg-input-bg border border-line rounded-(--radius-md) focus:border-field-focus-border`}
                    />
                    <If when={canPick}>
                      <Button icon="folder" testID="project-pick" onPress={() => void pickFolder()}>
                        {t().project.pick}
                      </Button>
                    </If>
                  </View>
                }
              >
                <WorkspacePicker
                  id="project-dir"
                  path={typed()}
                  chooseLabel={t().project.browse}
                  changeLabel={t().project.browse}
                  emptyLabel={t().project.browseEmpty}
                  unavailableLabel={t().project.browseFailed}
                  dialogTitle={t().project.pickTitle}
                  remote
                  api={runtime.client}
                  browseHint={t().project.browseHint}
                  permissionHint={t().settings.workspaceAuthorizeMac}
                  truncatedHint={t().stream.workspaceTruncated}
                  upLabel={t().settings.workspaceUp}
                  useLabel={t().settings.workspaceUseFolder}
                  cancelLabel={t().sidebar.cancel}
                  shown={dirDisplay}
                  onChange={(next) => {
                    typed.set(next);
                    startError.set(null);
                  }}
                />
              </If>
              <FieldHint>{t().project.dirHints[props.agent]}</FieldHint>
              {startFailure()}
              <View class="flex-row">
                <Button variant="primary" testID="project-start" disabled={pending() || !typed().trim()} onPress={() => void start(typed())}>
                  {t().project.start}
                </Button>
              </View>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
