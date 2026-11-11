/**
 * A conversation's settings (`SessionSettingsDrawer.svelte`), in either of the two places they
 * open: beside the conversation in its workbench pane (`beside`), or as the drawer over the shell
 * (and the page on a phone). Both are the same sheet with the same head and panes. The state they
 * run on, the unsaved group draft, which danger confirm is armed, which section a phone shows, the
 * open profile pane, is the shell's, passed in as values with an `on…Change` beside each (the
 * Svelte `bind:`s).
 *
 * The drawer is an nsh/base `Dialog` with its own scrim: a press on the scrim closes it (unless a
 * danger confirm is up), Escape walks the shell's chain (the confirm, a nested Bot, an open
 * editor, then the drawer). `profileBackdrop` (the Svelte `backdropClick()`, which keeps a
 * text-selection drag from closing it) has no use here: the scrim's own press is a press.
 * `profilePane.backFromEditor()` is reported through `onProfilePane`.
 */
import { Text, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import type { backdropClick } from "../../m/click-outside";
import type { ShellDangerConfirm } from "../../m/overlays/danger-confirm.svelte";
import type { GroupDetailDraft } from "../../m/panels/group-edit";
import { classifySession, youBotPeer, type SessionGroup } from "../../m/sidebar/session-groups";
import { copy, runtime } from "../../runtime";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { GroupPane } from "./GroupPane";
import { ProfilePane, type ProfilePaneApi } from "./ProfilePane";
import { SettingsHead } from "./SettingsHead";
import { WheelLayer } from "../../platform/wheel-layer";

export type SessionSettingsDrawerProps = {
  narrow: boolean;
  botsById: ReadonlyMap<string, Bot>;
  sessionsById: ReadonlyMap<string, SessionSummary>;
  danger: ShellDangerConfirm;
  openProfile: (botId: string, sessionId?: string) => void;
  /** Settings beside this conversation on the workbench, for this Bot when one is named. Null for the drawer. */
  beside: { sessionId: string; botId: string | null } | null;
  closePaneSide: (sessionId: string) => void;
  selected: SessionSummary | null;
  selectedKind: SessionGroup | null;
  nestedProfile: boolean;
  profileBot: Bot | null;
  /** Unused: the scrim's own press closes the drawer (see the head of this file). */
  profileBackdrop?: ReturnType<typeof backdropClick>;
  closeNestedProfile: () => void;
  closeCurrentDrawerScreen: () => void;
  /** The profile pane's `backFromEditor()` / `backFromDetail()`, as the pane is built. */
  onProfilePane?: (api: ProfilePaneApi | undefined) => void;
  profileFailed: boolean;
  onProfileFailedChange: (failed: boolean) => void;
  paneMobileDetail: boolean;
  onPaneMobileDetailChange: (open: boolean) => void;
  groupDetail: GroupDetailDraft;
  onGroupDetailChange: (detail: GroupDetailDraft) => void;
};

export function SessionSettingsDrawer(props: SessionSettingsDrawerProps) {
  const t = () => copy();
  let profilePane: ProfilePaneApi | undefined;
  const registerPane = (api: ProfilePaneApi) => {
    profilePane = api;
    props.onProfilePane?.(api);
  };

  /**
   * The Bot's profile, keyed on the Bot so switching Bots remounts the pane (`{#key bot.id}`). The
   * pane reads the live row through `bot()`, not the keyed item, so a change to the Bot reaches it.
   */
  const profile = (bot: () => Bot, kind: () => SessionGroup | null, props2: { onDeleteBot: () => void; onClearHistory: () => void }) => (
    <Each of={[bot().id]} key={(id) => id}>
      {() => (
        <ProfilePane
          bot={bot()}
          selectedKind={kind()}
          profileFailed={props.profileFailed}
          onProfileFailedChange={props.onProfileFailedChange}
          mobileDetail={props.paneMobileDetail}
          onMobileDetailChange={props.onPaneMobileDetailChange}
          openDangerConfirm={(kind2, run) => (props.danger.dangerConfirm = { kind: kind2, run, source: "drawer" })}
          clearDanger={(kind2) => props.danger.clearDanger(kind2)}
          onDeleteBot={props2.onDeleteBot}
          onClearHistory={props2.onClearHistory}
          onHandle={registerPane}
        />
      )}
    </Each>
  );

  /** One header per screen: on a phone the section brings its own, with the way back in it. */
  const headHidden = () => props.narrow && props.paneMobileDetail;
  const headBox = (back: boolean) =>
    props.narrow
      ? `shrink-0 min-h-[56px] justify-center pt-[14px] pr-3 ${back ? "pl-1" : "pl-4"} bg-pane border-b border-line`
      : "shrink-0 px-5 pt-4 pb-[2px] bg-pane border-b border-line";

  const beside = (place: { sessionId: string; botId: string | null }) => {
    const session = () => props.sessionsById.get(place.sessionId);
    const kind = () => {
      const row = session();
      return row ? classifySession(row) : null;
    };
    const shownBotId = () => {
      const row = session();
      return place.botId ?? (kind() === "you-bot" && row ? youBotPeer(row) : null);
    };
    const paneBot = () => {
      const id = shownBotId();
      return id ? props.botsById.get(id) : undefined;
    };
    return (
      <View testID="session-settings" class="flex-1 min-h-0 bg-bg overflow-hidden">
        <If when={!headHidden()}>
          <View class={headBox(false)}>
            <SettingsHead
              group={kind() === "group" && !paneBot()}
              nested={false}
              onBack={() => {}}
              onClose={() => props.closePaneSide(place.sessionId)}
              groupSession={kind() === "group" && !paneBot() && session() ? session()! : null}
              narrow={props.narrow}
              botsById={props.botsById}
              detail={props.groupDetail}
              onDetailChange={props.onGroupDetailChange}
            />
          </View>
        </If>
        <If
          when={paneBot()}
          else={
            <If when={session()} else={<View class="flex-1 items-center justify-center"><Text testID="pane-settings-gone" class="text-[13px] text-ink-muted">{t().top.deleted}</Text></View>}>
              {(row) => (
                <GroupPane
                  selected={row()}
                  detail={props.groupDetail}
                  onDetailChange={props.onGroupDetailChange}
                  mobileDetail={props.paneMobileDetail}
                  onMobileDetailChange={props.onPaneMobileDetailChange}
                  onOpenProfile={(id) => props.openProfile(id, place.sessionId)}
                  onDeleteGroup={() => props.danger.openDeleteGroupConfirm(place.sessionId)}
                  onClearHistory={() => props.danger.openClearHistoryConfirm(place.sessionId)}
                />
              )}
            </If>
          }
        >
          {(bot) =>
            profile(() => paneBot() ?? bot(), kind, {
              onDeleteBot: () => props.danger.openDeleteBotConfirm(bot().id),
              onClearHistory: () => props.danger.openClearHistoryConfirm(place.sessionId),
            })
          }
        </If>
      </View>
    );
  };

  /** Escape: the shell's chain. A confirm first, a nested Bot, an open editor, then the drawer. */
  const escape = () => {
    if (props.danger.drawerHasDanger) props.danger.dismissDangerConfirm();
    else if (props.nestedProfile && props.narrow) runtime.closeSessionSettings();
    else if (props.nestedProfile) props.closeNestedProfile();
    else if (profilePane?.backFromEditor()) return;
    else runtime.closeSessionSettings();
  };

  const Drawer = () => (
    <Dialog
      open
      testID="session-settings-drawer"
      animation="fade"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      onCancel={escape}
      class="bg-transparent"
      style={{ width: windowSize().width, height: windowSize().height }}
    >
      <WheelLayer>
        <View class="flex-1 flex-row">
          <If when={!props.narrow}>
            <View
              testID="profile-backdrop"
              accessible={false}
              class="flex-1 bg-modal-backdrop"
              onPress={() => {
                if (props.danger.drawerHasDanger) return;
                runtime.closeSessionSettings();
              }}
            />
          </If>
          <View
            testID="session-settings"
            class={`min-h-0 bg-bg overflow-hidden ${props.narrow ? "border-l-0" : "border-l border-line"}`}
            style={{
              width: props.narrow ? windowSize().width : Math.min(460, Math.round(windowSize().width * 0.94)),
              boxShadow: props.narrow ? undefined : shadow("sheet-end"),
            }}
          >
            <If when={!headHidden()}>
              <View class={headBox(props.nestedProfile)}>
                <SettingsHead
                  group={props.selectedKind === "group"}
                  nested={props.nestedProfile}
                  onBack={() => (props.narrow ? runtime.closeSessionSettings() : props.closeNestedProfile())}
                  onClose={props.closeCurrentDrawerScreen}
                  groupSession={props.selectedKind === "group" && !props.nestedProfile && props.selected ? props.selected : null}
                  subjectBot={props.profileBot}
                  subjectSession={props.selected}
                  narrow={props.narrow}
                  botsById={props.botsById}
                  detail={props.groupDetail}
                  onDetailChange={props.onGroupDetailChange}
                />
              </View>
            </If>
            <If
              when={props.profileBot}
              else={
                <If when={props.selected}>
                  {(row) => (
                    <GroupPane
                      selected={row()}
                      detail={props.groupDetail}
                      onDetailChange={props.onGroupDetailChange}
                      mobileDetail={props.paneMobileDetail}
                      onMobileDetailChange={props.onPaneMobileDetailChange}
                      onOpenProfile={(id) => props.openProfile(id)}
                      onDeleteGroup={() => props.danger.openDeleteGroupConfirm()}
                      onClearHistory={() => props.danger.openClearHistoryConfirm()}
                    />
                  )}
                </If>
              }
            >
              {(bot) =>
                profile(() => props.profileBot ?? bot(), () => props.selectedKind, {
                  onDeleteBot: () => props.danger.openDeleteBotConfirm(),
                  onClearHistory: () => props.danger.openClearHistoryConfirm(),
                })
              }
            </If>
          </View>
        </View>
      </WheelLayer>
    </Dialog>
  );

  return (
    <If when={props.beside} else={<If when={runtime.sessionSettingsOpen && props.selected}><Drawer /></If>}>
      {(place) => beside(place())}
    </If>
  );
}
