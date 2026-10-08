/** Which push endpoints a phone may hand us, and reading its subscription keys. */
import { WEB_PUSH_PAYLOAD, type PushSubscribeRequestV2 } from "@real-bot/protocol";
import { fromBase64url } from "@real-bot/remote";
import { createPublicKey } from "node:crypto";
import { HttpError } from "../errors";
import { sha256 } from "../request-digest";

/** Adding a domain requires code and docs review. The relay never sends. */
export const PUSH_ALLOWED_HOSTS = [
  "*.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
] as const;
export const PUSH_PLAINTEXT = JSON.stringify(WEB_PUSH_PAYLOAD);

export const ENDPOINT_MAX = 2048;

export type PushSubscribeMaterials = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expires_at?: number | null;
};

export function isAllowedPushHost(host: string): boolean {
  const hostname = host.trim().toLowerCase();
  if (
    !hostname ||
    hostname.startsWith(".") ||
    hostname.endsWith(".") ||
    hostname.includes("..") ||
    /[^a-z0-9.-]/.test(hostname)
  ) {
    return false;
  }
  if (hostname === "fcm.googleapis.com" || hostname === "updates.push.services.mozilla.com") return true;
  if (!hostname.endsWith(".push.apple.com")) return false;
  const prefix = hostname.slice(0, -".push.apple.com".length);
  return prefix.length > 0 && !prefix.startsWith(".") && !prefix.endsWith(".") && !prefix.includes("..");
}

export function parsePushEndpoint(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > ENDPOINT_MAX) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  if (url.port && url.port !== "443") {
    throw new HttpError(422, "invalid_args", "push endpoint rejected: non-default port");
  }
  if (url.href !== value && url.href !== `${value}/`) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  const host = url.hostname;
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !isAllowedPushHost(host)) {
    throw new HttpError(422, "invalid_args", "push endpoint rejected");
  }
  return url;
}

export function endpointHash(endpoint: string): string {
  return sha256(Buffer.from(endpoint));
}

export function validateP256Point(bytes: Uint8Array): void {
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new HttpError(422, "invalid_args", "push key must be 65-byte uncompressed point");
  }
  try {
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(bytes.subarray(1, 33)).toString("base64url"),
        y: Buffer.from(bytes.subarray(33, 65)).toString("base64url"),
      },
      format: "jwk",
    });
  } catch {
    throw new HttpError(422, "invalid_args", "push key is not a valid P-256 point");
  }
}

export function keyBytes(value: string, length: number): Uint8Array {
  try {
    const bytes = fromBase64url(value, length);
    if (length === 65) {
      validateP256Point(bytes);
    }
    return bytes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "invalid_args", "push keys rejected");
  }
}

export function parseSubscribeV2(body: Record<string, unknown>): PushSubscribeRequestV2 {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, "invalid_args", "invalid body");
  }
  if (!Object.hasOwn(body, "mode") || !Object.hasOwn(body, "if_device_revision")) {
    throw new HttpError(409, "client_upgrade_required", "push subscription requires push_settings_v2 format");
  }
  const allowedKeys = [
    "application_server_key_fingerprint",
    "auth",
    "endpoint",
    "expires_at",
    "if_device_revision",
    "mode",
    "p256dh",
  ];
  const keys = Object.keys(body).sort();
  for (const k of keys) {
    if (!allowedKeys.includes(k)) {
      throw new HttpError(422, "invalid_args", `unexpected property: ${k}`);
    }
  }
  if (body.mode !== "enable" && body.mode !== "refresh") {
    throw new HttpError(422, "invalid_args", "mode must be enable or refresh");
  }
  if (
    typeof body.if_device_revision !== "number" ||
    !Number.isSafeInteger(body.if_device_revision) ||
    body.if_device_revision < 0
  ) {
    throw new HttpError(422, "invalid_args", "if_device_revision must be a non-negative integer");
  }
  if (
    typeof body.application_server_key_fingerprint !== "string" ||
    body.application_server_key_fingerprint.length === 0
  ) {
    throw new HttpError(422, "invalid_args", "application_server_key_fingerprint is required");
  }
  if (typeof body.endpoint !== "string" || typeof body.p256dh !== "string" || typeof body.auth !== "string") {
    throw new HttpError(422, "invalid_args", "invalid remote properties");
  }
  parsePushEndpoint(body.endpoint);
  keyBytes(body.p256dh, 65);
  keyBytes(body.auth, 16);
  let expires_at: number | null | undefined;
  if (Object.hasOwn(body, "expires_at")) {
    if (body.expires_at === null) expires_at = null;
    else if (typeof body.expires_at === "number" && Number.isSafeInteger(body.expires_at) && body.expires_at >= 0) {
      expires_at = body.expires_at;
    } else {
      throw new HttpError(422, "invalid_args", "invalid expires_at");
    }
  }
  return {
    mode: body.mode,
    if_device_revision: body.if_device_revision,
    application_server_key_fingerprint: body.application_server_key_fingerprint,
    endpoint: body.endpoint,
    p256dh: body.p256dh,
    auth: body.auth,
    expires_at,
  };
}
