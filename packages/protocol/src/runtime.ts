import type { LOCAL_API_BIND, LOCAL_API_NAME } from "./constants.ts";

export type HealthResponse = {
  ok: true;
  name: typeof LOCAL_API_NAME;
};

export type RuntimeResponse = {
  pid: number;
  bind: typeof LOCAL_API_BIND;
  version?: string;
  mode?: "window" | "standalone" | "none";
  stopped?: boolean;
  restart?: "available" | "unavailable";
};

/**
 * `GET /v1/capabilities`: this build's engine, not the app version. A phone page is deployed
 * separately from the daemon it talks to and can be the newer of the two, so it reads this instead
 * of assuming its own build's features are all there (ADR 0040's version gate).
 */
export type CapabilitiesResponse = {
  schema_level: number;
  engine_level: number;
  features: string[];
};

/**
 * `POST /v1/capabilities/raise`, local only (never on the remote whitelist): a developer's word that
 * this data folder's engine level may go up although an installed app that shares it predates the
 * version gate, which would not honor what the level writes if opened without this daemon (ADR
 * 0041). Recorded, then carried out at once; answered with `CapabilitiesResponse`. `by` is
 * `script` from `apps/daemon/scripts/engine-level.ts`, `api` otherwise. `DELETE` on the same path
 * takes the word back and leaves the level where it is.
 */
/** `level`: how far the opt-in lets the data folder go (1 up to this build's top level, which it defaults to). */
export type RaiseEngineLevelRequest = { accept_older_app: true; by?: "api" | "script"; level?: number };

export type LocalApiDescriptor = {
  pid: number;
  port: number;
  token: string;
  started_at: string;
};

export type LocalApiDiscovery = {
  port: number;
  token: string;
};

export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "not_found"
  | "conflict"
  | "key_write_pending"
  | "credential_superseded"
  | "receipt_expired"
  | "not_retryable"
  | "invalid_args"
  | "not_a_member"
  | "ambiguous"
  | "denied"
  | "not_text"
  | "too_large"
  | "failed";

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export type ListPage<T> = {
  items: T[];
  next?: string | null;
};
