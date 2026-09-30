/**
 * One confirm at a time, and the small cluster of open/delete actions that arm it.
 *
 * These used to be five booleans that each cleared the other four on the way up; every opener,
 * every close path and the window handler had to keep that list in sync. Lives beside
 * `Shell.svelte` rather than inside it, taking getters for whatever it needs to read from that
 * instance, and never snapshotting them — a delete that is still in flight when the session
 * switches has to see the switch, not the session it started against.
 */
import type { SessionSummary } from "@real-bot/protocol";
import type { GroupDetailDraft } from "../panels/group-edit.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { classifySession, youBotPeer } from "../sidebar/session-groups.ts";
import {
  visibleDangerKind,
  type DangerAction,
  type DangerKind,
  type DangerSource,
} from "./danger-confirm.ts";

export type DangerConfirm = {
  /** Picks the copy, and says which close paths drop this confirm. */
  kind: DangerKind;
  /** What the confirm button does. Whoever opens the dialog knows; the shell does not. */
  run: DangerAction;
  running?: boolean;
  /** The session this group / history confirm acts on. Independent of the open chat. */
  sessionId?: string;
  /** The Bot this confirm acts on, so it goes when that Bot leaves the roster. */
  botId?: string;
  /** The endpoint this is about, so the confirm goes when someone else deletes it. */
  providerId?: string;
  /** Drawer/settings confirms go when that surface closes. A sidebar menu confirm does not. */
  source?: DangerSource;
  /**
   * A group / history confirm's box to erase what you said there as well (ADR 0040), off until you
   * tick it. Read when the confirm runs, not when it opens.
   */
  eraseQuotes?: boolean;
};

export type ShellDangerConfirmDeps = {
  runtime: () => MessengerRuntime;
  /** The conversation a group / history / bot confirm falls back to when no id is named. */
  selected: () => SessionSummary | null;
  sessionsById: () => ReadonlyMap<string, { kind: string }>;
  groupDetail: () => GroupDetailDraft;
  setProfileFailed: (value: boolean) => void;
  setSaveFailed: (value: boolean) => void;
  closeNestedProfile: () => void;
};

export class ShellDangerConfirm {
  private readonly getRuntime: () => MessengerRuntime;
  private readonly getSelected: () => SessionSummary | null;
  private readonly getSessionsById: () => ReadonlyMap<string, { kind: string }>;
  private readonly getGroupDetail: () => GroupDetailDraft;
  private readonly setProfileFailed: (value: boolean) => void;
  private readonly setSaveFailed: (value: boolean) => void;
  private readonly closeNestedProfile: () => void;

  dangerConfirm = $state<DangerConfirm | null>(null);
  confirmingIndependent = $state(false);

  constructor(deps: ShellDangerConfirmDeps) {
    this.getRuntime = deps.runtime;
    this.getSelected = deps.selected;
    this.getSessionsById = deps.sessionsById;
    this.getGroupDetail = deps.groupDetail;
    this.setProfileFailed = deps.setProfileFailed;
    this.setSaveFailed = deps.setSaveFailed;
    this.closeNestedProfile = deps.closeNestedProfile;
  }

  /** A group or history confirm follows the session it named, not whichever chat is open. */
  get dangerConfirmKind(): DangerKind | null {
    const snapshot = this.getRuntime().snapshot;
    return visibleDangerKind(this.dangerConfirm, {
      selectedId: this.getSelected()?.id ?? null,
      sessions: this.getSessionsById(),
      botIds: new Set(snapshot.bots.map((bot) => bot.id)),
      providerIds: new Set(snapshot.providers.map((provider) => provider.id)),
    });
  }

  /** The native confirmation consumes its own keyboard events before this fallback. */
  get escapeDismissesDanger(): boolean {
    const kind = this.dangerConfirmKind;
    return kind !== null && kind !== "skill" && kind !== "memory";
  }

  /** The session drawer's backdrop refuses to close while one of its own confirms is up. */
  get drawerHasDanger(): boolean {
    const kind = this.dangerConfirmKind;
    return kind === "bot" || kind === "group" || kind === "history";
  }

  async confirmDanger(): Promise<void> {
    const pending = this.dangerConfirm;
    if (!pending || pending.running) return;
    pending.running = true;
    try {
      await pending.run(() => this.dangerConfirm === pending);
    } finally {
      pending.running = false;
    }
  }

  /** Ticks or clears the open confirm's box, if it has one. */
  setDangerOption(checked: boolean): void {
    if (this.dangerConfirm && !this.dangerConfirm.running) this.dangerConfirm.eraseQuotes = checked;
  }

  /** Drop the confirm only when it is one of these kinds, as the per-flag resets used to. */
  clearDanger(...kinds: DangerKind[]): void {
    if (this.dangerConfirm && kinds.includes(this.dangerConfirm.kind)) this.dangerConfirm = null;
  }

  /**
   * Deferred so the click that dismisses does not also reach the backdrop underneath. A timeout,
   * not `requestAnimationFrame`: a window in the tray paints nothing, and a dismissal should not
   * wait for the window to come back.
   */
  dismissDangerConfirm(): void {
    const pending = this.dangerConfirm;
    if (pending?.running) return;
    setTimeout(() => {
      if (this.dangerConfirm === pending) this.dangerConfirm = null;
    }, 0);
  }

  openDeleteProviderConfirm(id: string): void {
    this.dangerConfirm = { kind: "provider", run: () => this.deleteProvider(id), providerId: id, source: "settings" };
  }

  private async deleteProvider(id: string): Promise<void> {
    const pending = this.dangerConfirm;
    this.setSaveFailed(false);
    const error = await this.getRuntime().deleteProvider(id);
    if (this.dangerConfirm !== pending) return;
    if (error) {
      this.setSaveFailed(true);
      this.dangerConfirm = null;
      return;
    }
    this.dangerConfirm = null;
  }

  openDeleteBotConfirm(botId?: string, source: DangerSource = "drawer"): void {
    const selected = this.getSelected();
    const selectedPeer = selected ? youBotPeer(selected) : null;
    const id = botId ?? this.getRuntime().profileBotId ?? selectedPeer ?? null;
    if (!id) return;
    this.dangerConfirm = { kind: "bot", run: () => this.deleteProfile(id), botId: id, source };
  }

  openDeleteGroupConfirm(sessionId?: string, source: DangerSource = "drawer"): void {
    const id = sessionId ?? this.getSelected()?.id ?? null;
    if (!id) return;
    this.dangerConfirm = { kind: "group", run: () => this.deleteGroupSession(id), sessionId: id, source, eraseQuotes: false };
  }

  openClearHistoryConfirm(sessionId?: string, source: DangerSource = "drawer"): void {
    const id = sessionId ?? this.getSelected()?.id ?? null;
    if (!id) return;
    this.dangerConfirm = { kind: "history", run: () => this.clearGroupHistory(id), sessionId: id, source, eraseQuotes: false };
  }

  private async deleteProfile(botId: string): Promise<void> {
    const pending = this.dangerConfirm;
    this.setProfileFailed(false);
    const runtime = this.getRuntime();
    const error = await runtime.deleteBot(botId);
    if (this.dangerConfirm !== pending) return;
    if (error) {
      this.setProfileFailed(true);
      return;
    }
    this.dangerConfirm = null;
    // Read fresh, not the values at the top of this call: the selection can have moved on while
    // the delete was in flight.
    const selected = this.getSelected();
    const selectedPeer = selected ? youBotPeer(selected) : null;
    const selectedKind = selected ? classifySession(selected) : null;
    if (runtime.profileBotId === botId || selectedPeer === botId) {
      if (selectedKind === "you-bot") runtime.closeSessionSettings();
      else this.closeNestedProfile();
    }
  }

  private async deleteGroupSession(sessionId: string): Promise<void> {
    const pending = this.dangerConfirm;
    if (this.getGroupDetail().sessionId === sessionId) this.getGroupDetail().failed = false;
    const runtime = this.getRuntime();
    const error = await runtime.deleteSession(sessionId, { eraseQuotes: pending?.eraseQuotes === true });
    if (this.dangerConfirm !== pending) return;
    if (error) {
      if (this.getGroupDetail().sessionId === sessionId) this.getGroupDetail().failed = true;
      return;
    }
    this.dangerConfirm = null;
    if (runtime.selectedId === sessionId) runtime.closeSessionSettings();
  }

  private async clearGroupHistory(sessionId: string): Promise<void> {
    const pending = this.dangerConfirm;
    if (this.getGroupDetail().sessionId === sessionId) this.getGroupDetail().failed = false;
    const error = await this.getRuntime().clearSessionHistory(sessionId, { eraseQuotes: pending?.eraseQuotes === true });
    if (this.dangerConfirm !== pending) return;
    if (error) {
      if (this.getGroupDetail().sessionId === sessionId) this.getGroupDetail().failed = true;
      return;
    }
    this.dangerConfirm = null;
  }
}
