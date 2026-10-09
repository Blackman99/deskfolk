import { connectorFor, type Connector, type ConnectorPlan, type ProbeModelsResponse } from "@real-bot/protocol";

export type PlanProbe = ({ ok: true } & ProbeModelsResponse) | { ok: false; error: string; status?: number };

export type PlanSearch =
  /** This plan's model list took the key. */
  | { kind: "found"; plan: ConnectorPlan; result: { ok: true } & ProbeModelsResponse }
  /** Every plan said the key is not theirs (401). */
  | { kind: "refused" }
  /** A plan answered something other than "not my key": the key may be right, so the search stops there. */
  | { kind: "failed"; plan: ConnectorPlan; error: string }
  /** The form moved on while a probe was out; its answer is not wanted. */
  | { kind: "stale" };

/**
 * The plans a connector's search tries (ADR 0072), the one the endpoint is on first: an endpoint
 * edited for a new key most likely stays where it was.
 */
export function planOrder(connector: Connector, baseUrl: string): ConnectorPlan[] {
  const current = connectorFor(baseUrl, connector.apiFormat);
  if (current?.connector.id !== connector.id) return [...connector.plans];
  return [current.plan, ...connector.plans.filter((plan) => plan.id !== current.plan.id)];
}

/**
 * Tries the key on each plan in turn, one at a time so one key never sits in several vendors'
 * logs at once more than it has to. A plan's 401 moves on to the next; any other refusal (a 400
 * asking for a workspace, a 5xx, no network) is about the request rather than whose key it is, so
 * it is reported as is.
 */
export async function searchPlans(
  plans: readonly ConnectorPlan[],
  probe: (plan: ConnectorPlan) => Promise<PlanProbe>,
  stillWanted: () => boolean,
): Promise<PlanSearch> {
  for (const plan of plans) {
    const result = await probe(plan);
    if (!stillWanted()) return { kind: "stale" };
    if (result.ok) return { kind: "found", plan, result };
    if (result.status !== 401) return { kind: "failed", plan, error: result.error };
  }
  return { kind: "refused" };
}

/** Anthropic's refusal of a key not scoped to a workspace, sent without one. */
export function asksForWorkspace(error: string): boolean {
  return /anthropic-workspace-id/i.test(error) && /required|must include|not scoped/i.test(error);
}
