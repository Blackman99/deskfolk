/**
 * The desktop workbench cluster: the layout itself, its localStorage persistence, the effects
 * that keep it in step with the selected conversation and the live snapshot, and the pane-open /
 * terminal-tab / window-menu plumbing that acts on it.
 *
 * Lives beside `Shell.svelte` rather than inside it so the shell's own script can stay about the
 * three-column skeleton. Everything here is wired to one Shell instance: the constructor
 * takes getters for whatever it needs to read from that instance, and never snapshots them.
 */
import { untrack } from "svelte";
import type { SessionSummary, Terminal } from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import { classifySession, youBotPeer } from "../sidebar/session-groups.ts";
import { spendCopyFor } from "../spend/spend-copy.ts";
import { orderTerminals, statusLabel, terminalNames } from "../overlays/terminals.ts";
import { hideDesktopWindow, listenToWindow } from "../tauri.ts";
import {
  activateTab,
  allLeaves,
  closeLeaf as closeWorkbenchPane,
  closeTab as closeWorkbenchTab,
  closeTabs as closeWorkbenchTabs,
  emptyLayout,
  emptyLayout as freshLayout,
  focusLeaf,
  leafById,
  replaceTabParams,
  splitLeaf,
} from "./layout-tree.ts";
import { healLayout, loadWorkbenchLayout, saveWorkbenchLayout } from "./workbench-layout.ts";
import { contentOfTab, contentsEqual, PANE_KIND_SET, type PaneContent } from "./pane-content.ts";
import { paneMin, WB_FALLBACK_MIN } from "./pane-mins.ts";
import type { WorkbenchLayout, WorkbenchTab } from "./layout-types.ts";
import {
  activeSessionId,
  dropDuplicateBoundTabs,
  existingTarget,
  findKind,
  openContent,
} from "./pane-open.ts";
import type { PreviewHandle } from "./preview-context.ts";
import {
  MENU_COMMANDS,
  applyCommand,
  type CommandContext,
  type WorkbenchCommand,
} from "./workbench-commands.ts";

export type ShellWorkbenchDeps = {
  runtime: () => MessengerRuntime;
  wide: () => boolean;
  shellWidth: () => number;
  shellEl: () => HTMLElement | null;
  sessionsById: () => ReadonlyMap<string, SessionSummary>;
  titleOf: (session: SessionSummary) => string;
  t: () => Copy;
};

export class ShellWorkbench {
  private readonly getRuntime: () => MessengerRuntime;
  private readonly getWide: () => boolean;
  private readonly getShellWidth: () => number;
  private readonly getShellEl: () => HTMLElement | null;
  private readonly getSessionsById: () => ReadonlyMap<string, SessionSummary>;
  private readonly titleOf: (session: SessionSummary) => string;
  private readonly getT: () => Copy;

  layout = $state<WorkbenchLayout>(loadWorkbenchLayout() ?? emptyLayout("wb-root"));
  private paneSeq = 0;
  private selectionInitialized = false;
  private spendInitialized = false;
  /** The previews on screen, by tab, so one holding an unsaved edit can be asked before it turns. */
  private readonly previewPanes = new Map<string, PreviewHandle>();

  constructor(deps: ShellWorkbenchDeps) {
    this.getRuntime = deps.runtime;
    this.getWide = deps.wide;
    this.getShellWidth = deps.shellWidth;
    this.getShellEl = deps.shellEl;
    this.getSessionsById = deps.sessionsById;
    this.titleOf = deps.titleOf;
    this.getT = deps.t;

    /**
     * The two directions the conversation and the arrangement follow each other.
     *
     * Each tracks only its own side. Tracking both makes them fight — the same shape of bug the
     * URL effects in `+page.svelte` carry a comment about — and each is a no-op once the two
     * already agree, so they settle rather than ping-pong.
     */
    $effect(() => {
      if (!this.getWide()) return;
      const runtime = this.getRuntime();
      const id = runtime.selectedId;
      const restoring = !this.selectionInitialized;
      this.selectionInitialized = true;
      if (!id) return;
      untrack(() => {
        const leaf = leafById(this.layout, this.layout.focus.leafId);
        const active = leaf?.tabs.find((tab) => tab.id === leaf.activeTabId);
        // A remembered tool tab is in front of the URL's underlying conversation.
        if (restoring && active && active.kind !== "chat") return;
        if (activeSessionId(this.layout) === id) return;
        this.commitLayout(
          openContent(this.layout, { kind: "chat", sessionId: id }, { id: this.freshPaneId, replaceActive: true }),
        );
      });
    });

    /**
     * Terminal tabs name sessions the snapshot does not carry, so the list is read as soon as the
     * workbench is connected — and again after a reconnect — rather than when a terminal opens.
     */
    $effect(() => {
      const runtime = this.getRuntime();
      if (!this.getWide() || runtime.connection !== "connected") return;
      untrack(() => void runtime.refreshTerminals());
    });

    /** Drop tabs whose conversation or terminal has gone, the way pinned rows are cleaned. */
    $effect(() => {
      const runtime = this.getRuntime();
      const live = {
        sessionIds: new Set(runtime.snapshot.sessions.map((row) => row.id)),
        terminalIds: runtime.terminalsLoaded ? new Set(runtime.terminals.map((row) => row.id)) : null,
        knownKinds: PANE_KIND_SET,
      };
      // Only a bound on the window: the workbench keeps its floating panes inside its own box. A
      // guessed height here pulled up, on the next snapshot, any pane left lower than it allowed.
      const viewport = {
        x: 0,
        y: 0,
        width: this.getShellWidth(),
        height: untrack(() => this.getShellEl()?.clientHeight) || Number.POSITIVE_INFINITY,
      };
      untrack(() => {
        const healed = dropDuplicateBoundTabs(
          healLayout(this.layout, live, viewport, WB_FALLBACK_MIN, this.freshPaneId()),
          this.freshPaneId,
        );
        if (healed !== this.layout) this.commitLayout(healed);
      });
    });

    /**
     * While the workbench is on, every "open this" in the app lands in a pane rather than in a
     * full-screen layer. Cleared below the breakpoint, where those layers are still the app.
     *
     * The terminal page is a phone screen. A wide window opens a terminal tab instead, and a tab
     * stays out of the address, so a page left open while the window grows leaves the address too.
     */
    $effect(() => {
      const runtime = this.getRuntime();
      if (!this.getWide() || !runtime.terminalOpen) return;
      untrack(() => runtime.closeTerminal());
    });

    $effect(() => {
      const runtime = this.getRuntime();
      if (!this.getWide()) {
        runtime.paneOpener = null;
        return;
      }
      runtime.paneOpener = (content) => {
        untrack(() => {
          // "The terminal", asked for without naming one, is the one you have if there is one.
          if (content.kind === "terminal" && !content.terminalId) void this.showTerminal();
          else this.openGuarded(this.ownSettings(content));
        });
      };
      return () => {
        runtime.paneOpener = null;
      };
    });

    /**
     * The native menu owns its accelerators on the Mac, so a command picked there is handed to the
     * page rather than guessed at by it (on Windows the page catches Ctrl+W itself and comes here
     * too — see `matchesCloseTab`).
     */
    $effect(() => {
      if (!this.getWide()) return;
      return listenToWindow("pane-command", (id) => {
        if (typeof id === "string") this.runMenuCommand(id);
      });
    });

    /** URL restores and browser Back use the same singleton tab as the sidebar. */
    $effect(() => {
      if (!this.getWide()) return;
      const runtime = this.getRuntime();
      const spend = runtime.spendOpen;
      const restoring = !this.spendInitialized;
      this.spendInitialized = true;
      untrack(() => {
        if (spend) {
          this.openGuarded({ kind: "spend" });
          return;
        }
        if (restoring) return;
        const leaf = leafById(this.layout, this.layout.focus.leafId);
        const tab = leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
        if (leaf && tab?.kind === "spend") {
          const selectedId = runtime.selectedId;
          if (selectedId) this.openGuarded({ kind: "chat", sessionId: selectedId });
          else this.onPaneCloseTab(leaf.id, tab.id);
        }
      });
    });

    /** Following the active pane keeps Stop, the composer and the URL pointing at one conversation. */
    $effect(() => {
      if (!this.getWide()) return;
      const runtime = this.getRuntime();
      const id = activeSessionId(this.layout);
      const leaf = leafById(this.layout, this.layout.focus.leafId);
      const tab = leaf?.tabs.find((candidate) => candidate.id === leaf.activeTabId);
      untrack(() => {
        runtime.spendOpen = tab?.kind === "spend";
        if (id && runtime.selectedId !== id) void runtime.selectSession(id, { preservePage: true });
      });
    });
  }

  freshPaneId = (): string => `wb-${Date.now().toString(36)}-${++this.paneSeq}`;

  commitLayout = (next: WorkbenchLayout): void => {
    if (next === this.layout) return;
    this.layout = next;
    saveWorkbenchLayout(next);
  };

  /** What a tab is called. The layout carries ids; the names come from what they point at. */
  paneTitle = (tab: WorkbenchTab): string => {
    const t = this.getT();
    const content = contentOfTab(tab);
    if (!content) return t.pane.title;
    switch (content.kind) {
      case "chat":
        return this.sessionName(content.sessionId);
      case "terminal": {
        const row = this.getRuntime().terminals.find((candidate) => candidate.id === content.terminalId);
        return row ? (this.terminalNamesById.get(row.id) ?? row.title) : t.terminal.title;
      }
      case "workspace":
        return content.selected ? (content.selected.split("/").pop() ?? t.sidebar.workspace) : t.sidebar.workspace;
      case "routines":
        return t.routines.title;
      case "spend":
        return spendCopyFor(this.getRuntime().snapshot.settings.locale === "en" ? "en" : "zh").title;
      case "trace": {
        const name = this.sessionName(content.sessionId);
        if (content.view === "board") return t.pane.boardOf(name);
        if (content.view === "spec") return t.pane.specOf(name);
        return t.pane.flowOf(name);
      }
      case "preview":
        return content.sessionId ? t.pane.artifactsOf(this.sessionName(content.sessionId)) : t.pane.title;
    }
  };

  /** The conversation's own name, the same words its chat tab uses. */
  sessionName = (sessionId: string): string => {
    const runtime = this.getRuntime();
    const session = runtime.snapshot.sessions.find((row) => row.id === sessionId);
    return session ? this.titleOf(session) : this.getT().top.deleted;
  };

  /**
   * A direct conversation's own settings are its Bot's profile, however they were asked for — the
   * header's button or the Bot's avatar in the transcript. One spelling, so the header can tell
   * they are open and toggling them finds them.
   */
  ownSettings = (content: PaneContent): PaneContent => {
    if (content.kind !== "chat" || content.side?.kind !== "settings" || !content.side.botId) return content;
    const session = this.getSessionsById().get(content.sessionId);
    if (!session || classifySession(session) !== "you-bot" || youBotPeer(session) !== content.side.botId) {
      return content;
    }
    return { ...content, side: { kind: "settings", botId: null } };
  };

  trackPreviewPane = (tabId: string, pane: PreviewHandle | null): void => {
    if (pane) this.previewPanes.set(tabId, pane);
    else this.previewPanes.delete(tabId);
  };

  /**
   * Open through the layout, asking first when this would turn a conversation's preview away
   * from a file with an unsaved edit. That preview is its conversation's only one, so "open
   * beside it instead" is not on offer; its own save / discard / cancel question decides.
   */
  openGuarded = (content: PaneContent): void => {
    const open = () => this.commitLayout(openContent(this.layout, content, { id: this.freshPaneId }));
    const at = existingTarget(this.layout, content);
    const pane = at ? this.previewPanes.get(at.tab.id) : undefined;
    const current = at ? contentOfTab(at.tab) : null;
    if (at && pane?.blocksClose() && !(current && contentsEqual(current, content))) {
      // Bring the question to where the keyboard is, then turn only once it is answered.
      this.commitLayout(activateTab(focusLeaf(this.layout, at.leafId), at.leafId, at.tab.id));
      pane.requestLeaveFromParent(open);
      return;
    }
    open();
  };

  /** Fill a pane from its own empty state: whatever you pick lands in that pane, not elsewhere. */
  openInPane = (leafId: string, content: PaneContent): void => {
    const focused = focusLeaf(this.layout, leafId);
    this.commitLayout(openContent(focused, content, { id: this.freshPaneId, replaceActive: true }));
  };

  /**
   * A terminal tab is one shell. A new tab starts its own and is bound to it before it shows, so
   * two tabs are never the same terminal. If it cannot start one it opens anyway and says why.
   */
  openNewTerminal = async (leafId: string | null): Promise<void> => {
    const created = await this.getRuntime().startTerminal();
    const content: PaneContent = {
      kind: "terminal",
      terminalId: created?.id ?? null,
      cwd: created?.cwd ?? null,
    };
    if (leafId && leafById(this.layout, leafId)) this.openInPane(leafId, content);
    else this.commitLayout(openContent(this.layout, content, { id: this.freshPaneId }));
  };

  /** Reopen the nearest terminal tab, creating a shell when none is open. */
  showTerminal = async (): Promise<void> => {
    const open = findKind(this.layout, "terminal");
    if (open) {
      this.commitLayout(activateTab(focusLeaf(this.layout, open.leafId), open.leafId, open.tab.id));
      return;
    }
    await this.openNewTerminal(null);
  };

  /**
   * Sessions no tab shows. Closing a terminal tab never stops its shell, and a phone can start one,
   * so what is still there has to be reachable from where you open things.
   */
  untabbedTerminals: Terminal[] = $derived.by(() => {
    const shown = new Set(
      allLeaves(this.layout)
        .flatMap((leaf) => leaf.tabs)
        .filter((tab) => tab.kind === "terminal")
        .map((tab) => tab.params.terminalId),
    );
    return orderTerminals(this.getRuntime().terminals.filter((row) => !shown.has(row.id)));
  });

  terminalNamesById: Map<string, string> = $derived.by(() => terminalNames(this.getRuntime().terminals));

  /** A session's name, and how it ended when it has. */
  terminalName = (row: Terminal): string => {
    const name = this.terminalNamesById.get(row.id) ?? row.title;
    const status = statusLabel(row, this.getT());
    return status ? `${name} · ${status}` : name;
  };

  /** Write the session a terminal pane settled on back into its tab, so a restart comes back to it. */
  bindTerminalTab = (leafId: string, tabId: string, terminalId: string | null): void => {
    const runtime = this.getRuntime();
    const leaf = leafById(this.layout, leafId);
    const tab = leaf?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.kind !== "terminal") return;
    if ((tab.params.terminalId ?? null) === terminalId) return;
    const cwd = (terminalId && runtime.terminals.find((row) => row.id === terminalId)?.cwd) || tab.params.cwd;
    const params: Record<string, string> = {};
    if (terminalId) params.terminalId = terminalId;
    if (cwd) params.cwd = cwd;
    this.commitLayout(replaceTabParams(this.layout, leafId, tabId, params));
  };

  /**
   * A command by its native-menu id. Closing a tab closes the one in front of you and, once there
   * is nothing left to close, asks the window to hide — which is what 关窗 has always meant.
   */
  runMenuCommand = (id: string): void => {
    if (id === "pane-reset") {
      this.commitLayout(freshLayout(this.freshPaneId()));
      return;
    }
    if (id === "view-spend") {
      this.getRuntime().openSpend();
      return;
    }
    if (id === "pane-close-tab" && allLeaves(this.layout).every((leaf) => leaf.tabs.length === 0)) {
      void hideDesktopWindow();
      return;
    }
    const command = MENU_COMMANDS[id];
    if (command) this.runWorkbenchCommand(command);
  };

  runWorkbenchCommand = (command: WorkbenchCommand): void => {
    if (command.kind === "close-pane") {
      this.onPaneClose(this.layout.focus.leafId);
      return;
    }
    this.commitLayout(
      applyCommand(this.layout, command, this.workbenchCommandContext(), (current, leafId, axis, side) =>
        splitLeaf(current, leafId, axis, side, [], { leaf: this.freshPaneId(), branch: this.freshPaneId() }),
      ),
    );
  };

  private workbenchCommandContext(): CommandContext {
    return {
      viewport: { x: 0, y: 0, width: this.getShellWidth(), height: this.getShellEl()?.clientHeight || 800 },
      mins: paneMin,
      ids: this.freshPaneId,
      newPaneMin: WB_FALLBACK_MIN,
    };
  }

  onPaneClose = (leafId: string): void => {
    const leaf = leafById(this.layout, leafId);
    if (!leaf) return;
    const blocked = leaf.tabs.find((tab) => this.previewPanes.get(tab.id)?.blocksClose());
    if (blocked) {
      const pane = this.previewPanes.get(blocked.id)!;
      this.commitLayout(activateTab(focusLeaf(this.layout, leafId), leafId, blocked.id));
      pane.requestLeaveFromParent(() => this.onPaneClose(leafId));
      return;
    }
    this.commitLayout(closeWorkbenchPane(this.layout, leafId, this.freshPaneId()));
  };

  onPaneCloseTab = (leafId: string, tabId: string): void => {
    this.commitLayout(closeWorkbenchTab(this.layout, leafId, tabId, this.freshPaneId()));
  };

  /** Close others, to the right, all: asked about first, like closing the pane, when one holds an unsaved edit. */
  onPaneCloseTabs = (leafId: string, tabIds: string[]): void => {
    const leaf = leafById(this.layout, leafId);
    if (!leaf) return;
    const blocked = leaf.tabs.find((tab) => tabIds.includes(tab.id) && this.previewPanes.get(tab.id)?.blocksClose());
    if (blocked) {
      const pane = this.previewPanes.get(blocked.id)!;
      this.commitLayout(activateTab(focusLeaf(this.layout, leafId), leafId, blocked.id));
      pane.requestLeaveFromParent(() => this.onPaneCloseTabs(leafId, tabIds));
      return;
    }
    this.commitLayout(closeWorkbenchTabs(this.layout, leafId, tabIds, this.freshPaneId()));
  };
}
