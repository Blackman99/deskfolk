import type { ApiFormat } from "./providers.ts";

/**
 * Built-in connectors (ADR 0072): vendors whose addresses the app already knows, so adding one
 * takes only a key. A connector is not stored on the endpoint: an endpoint is one when its base URL
 * is one of the connector's plans, so an endpoint typed in by hand at the same address is one too.
 * Display names and plan labels live in the messenger's copy, not here.
 */
export const CONNECTOR_IDS = ["anthropic", "xiaomi", "qwen", "deepseek"] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];

/** One address a vendor serves, with the keys sold for it: a subscription plan or pay-as-you-go, per region. */
export type ConnectorPlan = {
  id: string;
  baseUrl: string;
};

export type Connector = {
  id: ConnectorId;
  apiFormat: ApiFormat;
  /**
   * Tried in this order when a key is entered; the first whose model list takes the key is used.
   * A vendor's plans each take only their own keys, so at most one of them should.
   */
  plans: readonly ConnectorPlan[];
  /** Whether the key may need a workspace sent with it (Anthropic's keys not scoped to one workspace). */
  workspace: boolean;
};

export const CONNECTORS: readonly Connector[] = [
  {
    id: "anthropic",
    apiFormat: "anthropic",
    plans: [{ id: "api", baseUrl: "https://api.anthropic.com" }],
    workspace: true,
  },
  {
    id: "xiaomi",
    apiFormat: "openai",
    plans: [
      { id: "token-plan-cn", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" },
      { id: "token-plan-sgp", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
      { id: "token-plan-ams", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" },
      { id: "payg", baseUrl: "https://api.xiaomimimo.com/v1" },
    ],
    workspace: false,
  },
  {
    // Bailian's Coding Plan is left out: its model list answers any key, so it cannot be told apart
    // by trying the key, and its terms keep it to coding tools.
    id: "qwen",
    apiFormat: "openai",
    plans: [
      { id: "token-plan", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
      { id: "payg-cn", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { id: "payg-intl", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    ],
    workspace: false,
  },
  {
    // DeepSeek's own API, at the address its docs give (`…/v1` is the same API). Its `dsh` harness
    // is not a local agent the app runs (ADR 0079): its models are reached here.
    id: "deepseek",
    apiFormat: "openai",
    plans: [{ id: "api", baseUrl: "https://api.deepseek.com" }],
    workspace: false,
  },
];

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === "string" && (CONNECTOR_IDS as readonly string[]).includes(value);
}

export function connectorById(id: string): Connector | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}

/**
 * The connector and plan an endpoint's address belongs to, or null for any other address. Case,
 * trailing slashes and, for Anthropic's format, a trailing `/v1` (requests go to `…/v1/messages`
 * either way) make no difference; the format has to match.
 */
export function connectorFor(
  baseUrl: string | null | undefined,
  apiFormat: ApiFormat | undefined,
): { connector: Connector; plan: ConnectorPlan } | null {
  const format = apiFormat ?? "openai";
  const address = comparableUrl(baseUrl ?? "", format);
  if (!address) return null;
  for (const connector of CONNECTORS) {
    if (connector.apiFormat !== format) continue;
    const plan = connector.plans.find((item) => comparableUrl(item.baseUrl, format) === address);
    if (plan) return { connector, plan };
  }
  return null;
}

/** Read by hand, as `local-endpoint.ts` does: this package runs where `URL` may not be declared. */
function comparableUrl(raw: string, format: ApiFormat): string | null {
  const match = /^(https?):\/\/([^/?#@\s]+)(\/[^?#\s]*)?$/i.exec(raw.trim());
  if (!match) return null;
  let path = (match[3] ?? "").replace(/\/+$/, "").toLowerCase();
  if (format === "anthropic") path = path.replace(/\/v1$/, "");
  return `${match[1]!.toLowerCase()}://${match[2]!.toLowerCase()}${path}`;
}
