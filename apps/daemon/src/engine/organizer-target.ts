/**
 * Where the calls that keep the board, trace and plan in order run (ADR 0075): the organizer, the
 * scribe, and the judges of a sample and of seams. On the model chosen under Settings › Models ›
 * Organizing model when there is one, else on the default endpoint's default model as before,
 * left to think as the endpoint likes. A chosen model thinks as much as the call wants: `high` for
 * the organizer and the judges, a little for the scribe, which runs on every line and which no turn
 * waits for. A call that sends pictures runs on it only when its catalog says it takes them.
 */
import type { Store } from "../store";
import type { Creds, EndpointTarget } from "./types";

/** `vision`: a judge about to send frames (a sample's or a seam's), which needs a model that sees. */
export type OrganizerPurpose = "organizer" | "scribe" | "vision";

export type OrganizerTargetDeps = {
  store: Store;
  credentials: () => Promise<Creds | null>;
  /** The default endpoint's default model, which none of these calls leaves unless you chose one. */
  routingTarget: (creds: Creds) => EndpointTarget | null;
};

export function createOrganizerTarget(deps: OrganizerTargetDeps): (purpose: OrganizerPurpose) => Promise<EndpointTarget | null> {
  const { store } = deps;
  return async (purpose) => {
    const creds = await deps.credentials().catch(() => null);
    if (!creds) return null;
    const fallback = deps.routingTarget(creds);
    const chosen = store.settingsCached().organizer_model;
    // The setting reads as none once its endpoint no longer lists the model; one with no key is not ready here either.
    const provider = chosen ? creds.providers.find((row) => row.id === chosen.provider_id) : undefined;
    if (!chosen || !provider) return fallback;
    // Only a model marked as taking pictures is sent them; unmarked is not known, and stays on the default.
    if (purpose === "vision" && store.catalogEntries().find((entry) => entry.providerId === chosen.provider_id && entry.name === chosen.model)?.input_image !== true) {
      return fallback;
    }
    return {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      apiFormat: provider.apiFormat,
      workspaceId: provider.workspaceId,
      providerId: provider.id,
      providerName: provider.name,
      model: chosen.model,
      thinkingLevel: purpose === "scribe"
        ? store.scribeThinkingLevelFor(chosen.model, provider.id)
        : store.strongThinkingLevelFor(chosen.model, provider.id),
    };
  };
}
