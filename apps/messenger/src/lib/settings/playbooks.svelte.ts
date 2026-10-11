import type { Playbook, PlaybookDiff, PlaybookList, PlaybookRevision, PlaybookStepId } from "@real-bot/protocol";
import type { MessengerApi } from "../messenger-api.ts";

/** Why a change did not land: the engine changed meanwhile (the latest is loaded), or it failed. */
export type PlaybookSaveError = "conflict" | "failed";

/**
 * The engines (ADR 0085) as Roles and the conversation pickers show them: read once and again on
 * `playbook.changed`, each change sent with the revision it was made on. A change refused because
 * the engine changed meanwhile reloads the list and says so; the change is not tried again.
 */
export class Playbooks {
  list = $state<PlaybookList | null>(null);
  /** The engines could not be read at all: a daemon older than engines, or none to ask. */
  failed = $state(false);
  error = $state<PlaybookSaveError | null>(null);
  saving = $state(false);

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
    try {
      const out = await write(api);
      await this.load();
      return out;
    } catch (error) {
      this.error = (error as { status?: number } | null)?.status === 409 ? "conflict" : "failed";
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
