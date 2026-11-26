/**
 * Shared reactive Git summary store keyed by project directory (ADR 0118).
 * Keeps `PaneChatBar` subtitles and open `GitPane` tabs synchronized without bloating `runtime.svelte.ts`
 * or adding git data to the global `SessionSummary` snapshot.
 */
import type { GitRepoSummary } from "@real-bot/protocol";
import { state } from "../../lib/reactive.ts";
import type { MessengerApi } from "../messenger-api.ts";

export type GitSummaryEntry = {
  summary: GitRepoSummary | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number;
};

const SUMMARY_STALE_MS = 10_000;

class ProjectGitSummaryStore {
  #entries$s = state<Record<string, GitSummaryEntry>>({});
  #version$s = state(0);
  private readonly inflight = new Map<string, Promise<GitRepoSummary | null>>();

  get version(): number {
    return this.#version$s.get();
  }

  get(projectDir: string): GitSummaryEntry | null {
    return this.#entries$s.get()[projectDir] ?? null;
  }

  /** Triggers a lightweight summary fetch if none is cached or if `force` / TTL expired. */
  async ensure(
    api: MessengerApi | null,
    sessionId: string,
    projectDir: string,
    opts: { force?: boolean; quick?: boolean } = {},
  ): Promise<GitRepoSummary | null> {
    if (!api || !projectDir) return null;
    const existing = this.get(projectDir);
    if (!opts.force && existing && !existing.loading && Date.now() - existing.fetchedAt < SUMMARY_STALE_MS) {
      return existing.summary;
    }
    const key = `${projectDir}:${opts.quick ? "q" : "f"}`;
    const running = this.inflight.get(key);
    if (running) return running;

    const current = this.#entries$s.get();
    this.#entries$s.set({
      ...current,
      [projectDir]: {
        summary: existing?.summary ?? null,
        loading: true,
        error: null,
        fetchedAt: existing?.fetchedAt ?? 0,
      },
    });

    const p = api
      .gitSummary(sessionId, { quick: opts.quick })
      .then((summary) => {
        const latest = this.#entries$s.get();
        this.#entries$s.set({
          ...latest,
          [projectDir]: { summary, loading: false, error: null, fetchedAt: Date.now() },
        });
        this.#version$s.set(this.#version$s.get() + 1);
        return summary;
      })
      .catch((err) => {
        const latest = this.#entries$s.get();
        const prev = latest[projectDir];
        this.#entries$s.set({
          ...latest,
          [projectDir]: {
            summary: prev?.summary ?? null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            fetchedAt: Date.now(),
          },
        });
        return prev?.summary ?? null;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });

    this.inflight.set(key, p);
    return p;
  }

  /** Marks a directory stale so active views refetch on next tick. */
  bump(): void {
    this.#version$s.set(this.#version$s.get() + 1);
  }
}

export const projectGitStore = new ProjectGitSummaryStore();
