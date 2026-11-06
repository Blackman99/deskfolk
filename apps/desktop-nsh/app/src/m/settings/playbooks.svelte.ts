// Ported from apps/messenger/src/lib by scripts/port-messenger.ts; edited here since.
// Source: 0dc5c1d0b91e7f39
import { state } from "../../lib/reactive";
import type { Playbook, PlaybookDiff, PlaybookImpact, PlaybookList, PlaybookRevision, PlaybookStepId } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";

/** Why a change did not land: the engine changed meanwhile (the latest is loaded), or it failed. */
export type PlaybookSaveError = "conflict" | "failed";

/**
 * The engines (ADR 0085) as Roles and the conversation pickers show them: read once and again on
 * `playbook.changed`, each change sent with the revision it was made on. A change refused because
 * the engine changed meanwhile reloads the list and says so; the change is not tried again.
 */
export class Playbooks {
  #list$s = state<PlaybookList | null>(null);
	get list(): PlaybookList | null { return this.#list$s.get(); }
	set list(value: PlaybookList | null) { this.#list$s.set(value); }
  /** The engines could not be read at all: a daemon older than engines, or none to ask. */
  #failed$s = state(false);
	get failed() { return this.#failed$s.get(); }
	set failed(value) { this.#failed$s.set(value); }
  #error$s = state<PlaybookSaveError | null>(null);
	get error(): PlaybookSaveError | null { return this.#error$s.get(); }
	set error(value: PlaybookSaveError | null) { this.#error$s.set(value); }
  /** What the daemon said when it refused a change as it stood (a step of your own it could not take); null otherwise. */
  #message$s = state<string | null>(null);
	get message(): string | null { return this.#message$s.get(); }
	set message(value: string | null) { this.#message$s.set(value); }
  #saving$s = state(false);
	get saving() { return this.#saving$s.get(); }
	set saving(value) { this.#saving$s.set(value); }

  constructor(private readonly client: () => MessengerApi | null) {}

  get items(): Playbook[] {
    return this.list?.items ?? [];
  }

  get defaultId(): string {
    return this.list?.default_id ?? "general";
  }

  find(id: string | null | undefined): Playbook | undefined {
    return id ? this.items.find((item) => item.id === id) : undefined;
  }

  async load(): Promise<void> {
    const api = this.client();
    if (!api) return;
    try {
      const list = await api.listPlaybooks();
      if (this.client() !== api) return;
      this.list = list;
      this.failed = false;
    } catch {
      if (this.client() === api) this.failed = true;
    }
  }

  private async change<T>(write: (api: MessengerApi) => Promise<T>): Promise<T | null> {
    const api = this.client();
    if (!api) return null;
    this.saving = true;
    this.error = null;
    this.message = null;
    try {
      const out = await write(api);
      await this.load();
      return out;
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      this.error = status === 409 ? "conflict" : "failed";
      if (status === 422 && error instanceof Error && error.message) this.message = error.message;
      await this.load();
      return null;
    } finally {
      this.saving = false;
    }
  }

  /** The whole diff of an engine, as it is to be. */
  save(id: string, diff: PlaybookDiff): Promise<Playbook | null> {
    const revision = this.find(id)?.revision_id ?? null;
    return this.change((api) => api.savePlaybook(id, diff, revision));
  }

  /** One step back to its built-in; the whole engine when `step` is null. */
  reset(id: string, step: PlaybookStepId | null): Promise<Playbook | null> {
    const revision = this.find(id)?.revision_id ?? null;
    return this.change((api) => api.resetPlaybook(id, step, revision));
  }

  create(from: string, name: string): Promise<Playbook | null> {
    return this.change((api) => api.createPlaybook(from, name));
  }

  rename(id: string, name: string): Promise<Playbook | null> {
    const revision = this.find(id)?.revision_id ?? null;
    return this.change((api) => api.renamePlaybook(id, name, revision));
  }

  remove(id: string): Promise<void | null> {
    return this.change((api) => api.deletePlaybook(id));
  }

  /**
   * What moving to this engine would leave standing, when it works in no jobs and moving is worth a
   * word first (ADR 0103): one conversation, or all that follow the default. Null when there is
   * nothing to say, or it could not be asked: the move does not wait on it.
   */
  async impactOf(id: string, sessionId?: string): Promise<PlaybookImpact | null> {
    const api = this.client();
    if (!api || this.find(id)?.resolved.jobs.on !== false) return null;
    try {
      return await api.playbookImpact(sessionId ?? null);
    } catch {
      return null;
    }
  }

  async revisions(id: string): Promise<PlaybookRevision[]> {
    const api = this.client();
    if (!api) return [];
    try {
      return await api.playbookRevisions(id);
    } catch {
      return [];
    }
  }
}

/** An engine's name: a built-in's from the copy, a custom one's its own. */
export function playbookName(playbook: Pick<Playbook, "id" | "builtin" | "name"> | undefined, builtinNames: Record<string, string>): string {
  if (!playbook) return "";
  return playbook.builtin ? (builtinNames[playbook.id] ?? playbook.id) : (playbook.name ?? playbook.id);
}
