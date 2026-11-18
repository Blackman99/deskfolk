import type { ProjectPathLookup } from "@real-bot/protocol";
import { isHostCitedPath } from "../overlays/artifacts.ts";

type Locator = { locateProjectPath(sessionId: string, path: string): Promise<ProjectPathLookup> };

/** Where a cited path is to be opened, or what was found instead when it is nowhere one place. */
export type CitedPathAnswer =
  | { path: string }
  | { path: null; matches: number };

/**
 * A project session's agent (ADR 0095) cites paths relative to wherever it was working — the
 * project directory, or one repository inside it — never to the app's workspace, which is what a
 * bare path opens against. So before such a path is opened the Mac is asked where it is, and the
 * absolute path it gives is what opens. A path written absolute or from `~` says where it is.
 *
 * Found places are remembered for the conversation; misses are asked again, as the agent may write
 * the file later. A lookup that could not be made leaves the path as written, so the preview says
 * what went wrong as it always did.
 */
export class ProjectCitedPaths {
  private readonly found = new Map<string, Promise<ProjectPathLookup>>();

  constructor(private readonly client: () => Locator | null) {}

  /** Null when `path` says where it is itself; else where the Mac finds it in project session `sessionId`. */
  resolve(sessionId: string, path: string): Promise<CitedPathAnswer> | null {
    if (isHostCitedPath(path)) return null;
    return this.lookup(sessionId, path).then(
      (lookup): CitedPathAnswer => (lookup.path ? { path: lookup.path } : { path: null, matches: lookup.matches.length }),
      (): CitedPathAnswer => ({ path }),
    );
  }

  private lookup(sessionId: string, path: string): Promise<ProjectPathLookup> {
    const key = `${sessionId}\u0000${path}`;
    const known = this.found.get(key);
    if (known) return known;
    const client = this.client();
    if (!client) return Promise.reject(new Error("API unavailable"));
    const asked = client.locateProjectPath(sessionId, path).then(
      (lookup) => {
        if (!lookup.path) this.found.delete(key);
        return lookup;
      },
      (error: unknown) => {
        this.found.delete(key);
        throw error;
      },
    );
    this.found.set(key, asked);
    return asked;
  }
}
