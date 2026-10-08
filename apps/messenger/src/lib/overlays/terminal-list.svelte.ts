import type { Terminal } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import type { Snapshot } from "../snapshot.ts";
import type { PaneContent } from "../workbench/pane-content.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client a read or
 * a new shell rides on, the workspace a shell starts in, and where a started shell is shown — a
 * pane, or the terminal page (`openTerminal`, which lives with the other overlays).
 */
export interface TerminalListHost {
  readonly api: MessengerApi | null;
  readonly snapshot: Snapshot;
  startTerminal(cwd?: string): Promise<Terminal | null>;
  toPane(content: PaneContent): boolean;
  openTerminal(): void;
}

/**
 * The terminal sessions the daemon holds: the list, whether it has been read yet, and starting a
 * new shell. Which page or pane shows them is the overlays' business. `MessengerRuntime` forwards
 * every field and method here under the same public names, and reaches back in through
 * {@link TerminalListHost}.
 */
export class TerminalList {
  constructor(private readonly host: TerminalListHost) {}

  /** Sessions the daemon holds. Lifecycle only; the bytes are a stream, not state. */
  terminals = $state<Terminal[]>([]);
  /** Whether `terminals` has been read at all. An empty list before that means "not asked yet". */
  terminalsLoaded = $state(false);

  /**
   * A new shell in the workspace (or in `cwd`, a folder in it), in the list before the next read
   * comes back: a desktop tab bound to it must not be healed away for naming a session nobody has
   * heard of yet. Null when there is no workspace or the daemon would not start one; the tab says
   * so itself.
   */
  async startTerminal(cwd?: string): Promise<Terminal | null> {
    const api = this.host.api;
    const root = this.host.snapshot.settings.workspace_path;
    const where = cwd ?? root;
    if (!api || !root || !where) return null;
    try {
      const created = await api.openTerminal(where, 24, 80);
      if (this.host.api === api && !this.terminals.some((row) => row.id === created.id)) {
        this.terminals = [...this.terminals, created];
      }
      return created;
    } catch {
      return null;
    }
  }

  /**
   * A shell started in `cwd` and put in front of you: a tab of its own on the desktop, the phone's
   * terminal page elsewhere, which shows the newest live session first. Nothing opens when the
   * shell would not start.
   */
  async openTerminalAt(cwd: string): Promise<void> {
    const created = await this.host.startTerminal(cwd);
    if (!created) return;
    if (this.host.toPane({ kind: "terminal", terminalId: created.id, cwd: created.cwd })) return;
    this.host.openTerminal();
  }

  /** The daemon is the list's source of truth; events keep it fresh after this first read. */
  async refreshTerminals(): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    try {
      const items = await api.terminals();
      if (this.host.api === api) {
        this.terminals = items;
        this.terminalsLoaded = true;
      }
    } catch {
      // A list that will not load is not worth a banner; the pane shows its own failure.
    }
  }
}
