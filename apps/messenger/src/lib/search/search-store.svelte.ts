import type { SearchHit } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";
import type { Connection } from "../runtime.svelte.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client and the
 * connection a search belongs to, and the highlight a jump to a hit leaves behind.
 */
export interface SearchStoreHost {
  readonly api: MessengerApi | null;
  readonly connection: Connection;
  readonly connectionSeq: number;
  setHighlightedMessage(messageId: string | null, sessionId?: string): void;
}

/**
 * The global search: the query, its hits and whether they are loading or failed, with the counter
 * that drops a reply to an older query or an older connection. `MessengerRuntime` forwards every
 * field and method here under the same names, and reaches back in through {@link SearchStoreHost}.
 */
export class SearchStore {
  constructor(private readonly host: SearchStoreHost) {}

  searchQuery = $state("");
  searchHits = $state<SearchHit[]>([]);
  searchLoading = $state(false);
  searchError = $state(false);
  searchSeq = 0;

  clearSearchHighlight(): void {
    this.host.setHighlightedMessage(null);
  }

  closeSearch(): void {
    this.searchQuery = "";
    this.searchHits = [];
    this.searchLoading = false;
    this.searchError = false;
    this.searchSeq++;
  }

  /** Clearing a query invalidates in-flight replies too; results belong to one connection. */
  async runSearch(q: string): Promise<void> {
    this.searchQuery = q;
    this.searchHits = [];
    this.searchError = false;
    const seq = ++this.searchSeq;
    const api = this.host.api;
    const connection = this.host.connectionSeq;
    const trimmed = q.trim();
    if (!api || this.host.connection !== "connected" || !trimmed) {
      this.searchLoading = false;
      return;
    }
    this.searchLoading = true;
    const current = () =>
      seq === this.searchSeq && this.host.api === api && this.host.connectionSeq === connection;
    try {
      const hits = await api.search(trimmed);
      if (!current()) return;
      this.searchHits = hits;
      this.searchError = false;
    } catch {
      if (!current()) return;
      this.searchHits = [];
      this.searchError = true;
    } finally {
      if (current()) this.searchLoading = false;
    }
  }
}
