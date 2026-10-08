import type { EndpointModel, EndpointModelInput } from "./models.ts";

/**
 * The wire format an endpoint speaks: `openai` is Chat Completions (`POST …/chat/completions`, a
 * Bearer key); `anthropic` is Anthropic's Messages API (`POST …/v1/messages`, an `x-api-key`), which
 * Anthropic serves and many other vendors and proxies copy. The app's own calls work the same on
 * either; only what goes over the wire differs.
 */
export const API_FORMATS = ["openai", "anthropic"] as const;
export type ApiFormat = (typeof API_FORMATS)[number];

export function isApiFormat(value: unknown): value is ApiFormat {
  return typeof value === "string" && (API_FORMATS as readonly string[]).includes(value);
}

export type Provider = {
  id: string;
  name: string;
  base_url: string | null;
  /** Absent from a daemon older than Anthropic-format endpoints, which read every one as `openai`. */
  api_format?: ApiFormat;
  key_set: boolean;
  /** Enabled completion names; a subset of what the endpoint offers. */
  models: string[];
  model_catalog: EndpointModel[];
  /** Last list the endpoint's `/models` returned, kept so the picker survives reopening. */
  available_models: string[];
  default_model: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateProviderRequest = {
  name: string;
  base_url: string;
  /** Absent is `openai`. */
  api_format?: ApiFormat;
  api_key?: string;
  models?: EndpointModelInput[];
  available_models?: string[];
  default_model?: string | null;
};

export type PatchProviderRequest = {
  name?: string;
  base_url?: string;
  api_format?: ApiFormat;
  api_key?: string;
  models?: EndpointModelInput[];
  available_models?: string[];
  default_model?: string | null;
};
