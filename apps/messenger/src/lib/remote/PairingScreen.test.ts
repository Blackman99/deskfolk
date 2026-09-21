import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import PairingScreen from "./PairingScreen.svelte";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { fill, render } from "../test-render.ts";
import { hostSigningFingerprint } from "./fingerprint.ts";
import { base64url, generateIdentity, identityPublic } from "@real-bot/remote";

test("pairing screen shows the full fingerprint and refuses URL payloads", async () => {
  const host = identityPublic(generateIdentity());
  const qr = {
    v: 1,
    pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    expiresUnix: Math.floor(Date.now() / 1000) + 120,
    relayOrigin: "https://relay.example.test",
    relayId: "fixture",
    hostDhPublic: base64url(host.dh),
    hostSigningPublic: base64url(host.signing),
    trustEpoch: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    secret: base64url(crypto.getRandomValues(new Uint8Array(32))),
  };
  const runtime = fakeRuntime();
  const { host: el, close } = render(PairingScreen, { runtime, t: copyFor("en") });
  fill(el.querySelector("textarea"), JSON.stringify(qr));
  flushSync();
  expect(el.querySelector("[data-testid=host-fingerprint]")?.textContent?.replace(/\s/g, "")).toBe(
    hostSigningFingerprint(qr.hostSigningPublic),
  );
  fill(el.querySelector("textarea"), "https://evil.test/?p=/tmp/secret");
  expect(el.querySelector(".field-error")?.textContent).toContain("cannot be a URL");
  close();
});
