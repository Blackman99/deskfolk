import { state } from "../../lib/reactive";
/**
 * Shared desktop setting for how external web links in conversations open: in-app WebView (the
 * default) or the system default browser. Synced with the interface profile when the daemon keeps
 * it; local storage stays the fallback for older daemons and tests.
 */
import {
  EXTERNAL_LINK_OPEN_DEFAULT,
  loadExternalLinkOpen,
  saveExternalLinkOpen,
  type ExternalLinkOpen,
} from "./external-link-open.ts";

type Writer = (mode: ExternalLinkOpen | null) => void;

class ExternalLinkOpenStore {
  #local$s = state<ExternalLinkOpen>(loadExternalLinkOpen());
  private get local(): ExternalLinkOpen { return this.#local$s.get(); }
  private set local(value: ExternalLinkOpen) { this.#local$s.set(value); }

  #kept$s = state<ExternalLinkOpen | undefined>(undefined);
  private get kept(): ExternalLinkOpen | undefined { return this.#kept$s.get(); }
  private set kept(value: ExternalLinkOpen | undefined) { this.#kept$s.set(value); }

  private write: Writer | null = null;

  get mode(): ExternalLinkOpen {
    return this.kept ?? this.local;
  }

  get isDefault(): boolean {
    return this.mode === EXTERNAL_LINK_OPEN_DEFAULT;
  }

  set(mode: ExternalLinkOpen): void {
    if (this.mode === mode) return;
    this.local = mode;
    saveExternalLinkOpen(mode);
    if (this.write) {
      this.kept = mode === EXTERNAL_LINK_OPEN_DEFAULT ? undefined : mode;
      this.write(mode === EXTERNAL_LINK_OPEN_DEFAULT ? null : mode);
    }
  }

  reset(): void {
    this.set(EXTERNAL_LINK_OPEN_DEFAULT);
  }

  /** This machine's non-default choice, for seeding into the interface profile once. */
  get localChoice(): ExternalLinkOpen | undefined {
    return this.local === EXTERNAL_LINK_OPEN_DEFAULT ? undefined : this.local;
  }

  adopt(kept: ExternalLinkOpen | undefined, writer: Writer | null): void {
    this.kept = kept;
    this.write = writer;
  }

  reload(): void {
    this.local = loadExternalLinkOpen();
    this.kept = undefined;
    this.write = null;
  }
}

export const externalLinkOpen = new ExternalLinkOpenStore();
