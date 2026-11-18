import { state } from "../../lib/reactive";
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
  #terminals$s = state<Terminal[]>([]);
	get terminals(): Terminal[] { return this.#terminals$s.get(); }
	set terminals(value: Terminal[]) { this.#terminals$s.set(value); }
  /** Whether `terminals` has been read at all. An empty list before that means "not asked yet". */
  #terminalsLoaded$s = state(false);
	get terminalsLoaded() { return this.#terminalsLoaded$s.get(); }
	set terminalsLoaded(value) { this.#terminalsLoaded$s.set(value); }

  /**
   * Sessions the daemon has forgotten. A daemon from before the fix in `terminals.ts` sends one
   * more upsert after `terminal.removed` — the hung-up shell's exit — which put a closed session
   * back in the list, as finished. Ids are never reused, so these stay out for good.
   */
  readonly #removed = new Set<string>();

  /** A session's row as an event brings it: new, or changed, unless it has been removed. */
  upsertTerminal(row: Terminal): void {
    if (this.#removed.has(row.id)) return;
    this.terminals = [...this.terminals.filter((existing) => existing.id !== row.id), row];
  }

  /** The daemon forgot a session (`terminal.removed`, or ended here). */
  dropTerminal(id: string): void {
    this.#removed.add(id);
    this.terminals = this.terminals.filter((existing) => existing.id !== id);
  }

  /**
   * A new shell in the workspace (or in `cwd`, a folder in it or a project's directory), in the list
   * before the next read comes back: a desktop tab bound to it must not be healed away for naming a
   * session nobody has heard of yet. Null when there is neither a `cwd` nor a workspace, or the
   * daemon would not start one; the tab says so itself. A project session needs no workspace, so a
   * shell in its directory does not either.
   */
  async startTerminal(cwd?: string): Promise<Terminal | null> {
    const api = this.host.api;
    const where = cwd ?? this.host.snapshot.settings.workspace_path;
    if (!api || !where) return null;
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
   * The session the phone's terminal page shows (`TerminalPage.tsx`), kept while the page is closed
   * so coming back reattaches to the same shell. Null, or a session the daemon no longer has: the
   * page picks the newest live one.
   */
  #pageTerminalId$s = state<string | null>(null);
	get pageTerminalId() { return this.#pageTerminalId$s.get(); }
	set pageTerminalId(value) { this.#pageTerminalId$s.set(value); }

  /**
   * A shell started in `cwd` and put in front of you: a tab of its own on the desktop, the phone's
   * terminal page elsewhere, showing that shell. Nothing opens when the shell would not start.
   */
  async openTerminalAt(cwd: string): Promise<void> {
    const created = await this.host.startTerminal(cwd);
    if (!created) return;
    if (this.host.toPane({ kind: "terminal", terminalId: created.id, cwd: created.cwd })) return;
    this.pageTerminalId = created.id;
    this.host.openTerminal();
  }

  /**
   * The daemon is the list's source of truth; events keep it fresh after this first read. True once
   * this read has come back, so a caller can tell "no sessions" from "not read on this link yet".
   */
  async refreshTerminals(): Promise<boolean> {
    const api = this.host.api;
    if (!api) return false;
    try {
      const items = await api.terminals();
      if (this.host.api !== api) return false;
      this.terminals = items;
      this.terminalsLoaded = true;
      return true;
    } catch {
      // A list that will not load is not worth a banner; the pane shows its own failure.
      return false;
    }
  }

  /**
   * End a session: what runs in it stops and the daemon forgets it. Out of the list at once, so
   * nothing goes on naming it until the next read. One already gone (a 404) is not an error, and
   * one the link could not reach comes back with that read, still running.
   */
  async endTerminal(id: string): Promise<void> {
    const api = this.host.api;
    if (!api) return;
    try {
      await api.closeTerminal(id);
    } catch {
      // Already gone, or the link is down: the read below says which.
      if (this.host.api === api) this.terminals = this.terminals.filter((row) => row.id !== id);
      await this.refreshTerminals();
      return;
    }
    if (this.host.api === api) this.dropTerminal(id);
    await this.refreshTerminals();
  }
}
