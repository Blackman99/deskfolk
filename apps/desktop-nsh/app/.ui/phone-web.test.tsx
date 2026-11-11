import { expect, test } from "nsh/test";
import { base64url, encodePairingCode, generateIdentity, identityPublic, type PairingQr } from "../../../../packages/remote/src/index.ts";
import { copyFor } from "../src/m/copy.ts";
import { formatFingerprint, hostSigningFingerprint } from "../src/m/remote/fingerprint.ts";
import { pairingPayload } from "../src/ui/remote/pairing-code";
import { openStory } from "./fixture";

const t = copyFor("zh").remote;
/** `stories/phone-web.tsx`'s relay (not imported: that would bundle the screen into the test itself). */
const STORY_RELAY = "https://127.0.0.1:9";

/** A pairing offer as a Mac makes one, for relay `relayOrigin`, open `life` seconds from now. */
function offer(relayOrigin = STORY_RELAY, life = 300): PairingQr {
  const host = identityPublic(generateIdentity());
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    issuedAt: life > 0 ? now : now - 400,
    expiresUnix: now + life,
    relayOrigin,
    relayId: "fixture",
    trustEpoch: 1,
    hostDhPublic: base64url(host.dh),
    hostSigningPublic: base64url(host.signing),
    secret: base64url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

async function screen() {
  const app = await openStory("phone-web");
  await app.waitFor("id:pairing-screen", { timeout: 10_000 });
  return app;
}

test("a compact code is read against the page's origin, never one the pasted text names", () => {
  const qr = offer();
  const code = encodePairingCode(qr);
  const read = JSON.parse(pairingPayload(code, STORY_RELAY)) as PairingQr;
  expect(read).toEqual(qr);
  // The same code read on another page aims at that page, as the messenger reads it.
  expect((JSON.parse(pairingPayload(code, "https://relay.example.test")) as PairingQr).relayOrigin).toBe("https://relay.example.test");
  // No HTTPS page origin (a desktop, an opaque frame): handed on as pasted, for the messenger to refuse.
  expect(pairingPayload(code, "")).toBe(code);
  expect(pairingPayload(code, "http://127.0.0.1:9")).toBe(code);
  expect(pairingPayload(code, "null")).toBe(code);
  // Anything else is the messenger's to judge: a URL, the JSON form, a code that does not decode.
  for (const raw of ["https://evil.test/?p=/tmp/secret", JSON.stringify(qr), "rb1not-a-code", "  "]) expect(pairingPayload(raw, STORY_RELAY)).toBe(raw);
});

test("the screen asks for the Mac's pairing content, and submits nothing while it is empty", async () => {
  const app = await screen();
  for (const line of [t.pairTitle, t.pairLead, t.pairHint, t.pairPaste, t.pairSubmit]) expect(app.texts()).toContain(line);
  expect(app.enabled("id:pairing-submit")).toBe(false);
  // Blanks are no content either.
  await app.type("id:pairing-qr", "   ");
  expect(app.enabled("id:pairing-submit")).toBe(false);
  expect(app.shows("id:pairing-waiting")).toBe(false);
  expect(app.shows("id:pairing-error")).toBe(false);
});

test("a URL, a code that does not read and an expired window each say so", async () => {
  const app = await screen();
  await app.type("id:pairing-qr", "https://evil.test/?p=/tmp/secret");
  await app.waitUntil(() => app.texts().includes(t.pairUrl));
  await app.clear("id:pairing-qr");
  await app.waitUntil(() => !app.shows("id:pairing-error"));
  await app.type("id:pairing-qr", "rb1AAAA");
  await app.waitUntil(() => app.texts().includes(t.pairInvalid));
  await app.clear("id:pairing-qr");
  await app.type("id:pairing-qr", encodePairingCode(offer(STORY_RELAY, -100)));
  await app.waitUntil(() => app.texts().includes(t.pairExpired));
  expect(app.shows("id:host-fingerprint")).toBe(false);
});

test("a compact code shows the relay it came from and the Mac's whole fingerprint", async () => {
  const app = await screen();
  const qr = offer();
  await app.type("id:pairing-qr", encodePairingCode(qr));
  await app.waitFor("id:host-fingerprint");
  expect(app.texts()).toContain(STORY_RELAY);
  expect(app.texts()).toContain(formatFingerprint(hostSigningFingerprint(qr.hostSigningPublic)));
  expect(app.shows("id:pairing-error")).toBe(false);
  expect(app.enabled("id:pairing-submit")).toBe(true);
});

test("a submitted code the relay refuses leaves the refusal for when the field is cleared", async () => {
  const app = await screen();
  await app.type("id:pairing-qr", encodePairingCode(offer()));
  await app.waitFor("id:host-fingerprint");
  await app.press("id:pairing-submit");
  // Nothing listens on the story's relay: the submission is refused and the button comes back.
  await app.waitUntil(() => app.texts().includes(t.pairSubmit) && app.enabled("id:pairing-submit"), { timeout: 15_000 });
  await app.clear("id:pairing-qr");
  await app.waitUntil(() => app.texts().includes(t.pairRejected));
});

test("on a phone the card is the page", async () => {
  const app = await openStory("phone-web", { width: 390, height: 844, platform: "ios" });
  await app.waitFor("id:pairing-screen", { timeout: 10_000 });
  expect(app.texts()).toContain(t.pairTitle);
  await app.type("id:pairing-qr", encodePairingCode(offer()));
  await app.waitFor("id:host-fingerprint");
  expect(app.enabled("id:pairing-submit")).toBe(true);
});
