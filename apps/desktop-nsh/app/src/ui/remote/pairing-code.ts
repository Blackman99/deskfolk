/**
 * The pairing screen's one difference from the messenger's: where the page's origin comes from.
 *
 * A compact pairing code (`rb1…`) carries no relay address. The device takes the origin it is
 * served from as the relay, so pasted text can never aim it anywhere else
 * (`decodePairingCode(code, relayOrigin)`). The messenger's `parsePairingQr` reads that origin from
 * `location.origin`, but on the web NSH runs the app in a hidden same-origin `about:blank` frame,
 * whose `location.origin` is `"null"`: every compact code would read as invalid. The realm's own
 * `self.origin` is the page's, so a compact code is decoded here with it and handed on in the JSON
 * form, which the messenger accepts as it is (offers copied before the codes were shortened). The
 * relay origin in that JSON is still the page's, never the pasted text's. ADR 0107, Phase 1c.
 */
import { decodePairingCode, PAIRING_CODE_PREFIX } from "../../../../../../packages/remote/src/pairing-code.ts";
import { httpsOrigin } from "../../m/remote/origin.ts";

/** The origin this page is served from (`self.origin`); empty where there is none (a desktop). */
export function pageOrigin(): string {
  const origin = (globalThis as { origin?: unknown }).origin;
  return typeof origin === "string" ? origin : "";
}

/**
 * What to hand the messenger's pairing for `raw`: a compact code that decodes against `origin` in
 * its JSON form; anything else (a URL, JSON, a code that does not decode) as it was pasted, for the
 * messenger to judge with its own reasons.
 */
export function pairingPayload(raw: string, origin: string = pageOrigin()): string {
  const text = raw.trim();
  if (!text.startsWith(PAIRING_CODE_PREFIX)) return raw;
  try {
    return JSON.stringify(decodePairingCode(text, httpsOrigin(origin)));
  } catch {
    return raw;
  }
}
