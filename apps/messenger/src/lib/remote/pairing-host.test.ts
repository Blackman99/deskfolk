import { afterEach, expect, test } from "bun:test";
import { ApiError } from "../api.ts";
import type { LocalApi } from "../local-api.ts";
import { confirmPairing, initializeHost, parseHostRelay } from "./pairing-host.ts";
import { RemoteAdmin, type RemoteAdminHost } from "./remote-admin.svelte.ts";

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
const globals = globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } };
afterEach(() => { delete globals.__TAURI_INTERNALS__; });

/** The loopback route a source run answers setup on; the packaged daemon has none. */
function loopback(answer: (request: Record<string, unknown>) => unknown = () => ({})) {
  const sent: Array<Record<string, unknown>> = [];
  const api = { remoteSetup: async (request: Record<string, unknown>) => { sent.push(request); return answer(request); } } as unknown as LocalApi;
  return { api, sent };
}
function window(invoke: Invoke): Array<{ command: string; args: Record<string, unknown> }> {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  globals.__TAURI_INTERNALS__ = { invoke: async (command, args) => { calls.push({ command, args }); return invoke(command, args); } };
  return calls;
}
const relay = { origin: "https://relay.example.com", relayId: "home", bootstrap: "A".repeat(43) };
const challenge = `${"c".repeat(43)}=`, proof = `${"p".repeat(43)}=`;

test("the connect form is read the way the daemon checks it, before the token is spent", () => {
  expect(parseHostRelay({ ...relay, origin: " https://relay.example.com/ ", bootstrap: ` ${relay.bootstrap}\n` })).toEqual({ relay });
  expect(parseHostRelay({ ...relay, origin: "http://relay.example.com" })).toEqual({ invalid: "origin" });
  expect(parseHostRelay({ ...relay, origin: "https://relay.example.com/pair" })).toEqual({ invalid: "origin" });
  expect(parseHostRelay({ ...relay, origin: "relay.example.com" })).toEqual({ invalid: "origin" });
  expect(parseHostRelay({ ...relay, relayId: "my relay" })).toEqual({ invalid: "relayId" });
  expect(parseHostRelay({ ...relay, bootstrap: "A".repeat(42) })).toEqual({ invalid: "bootstrap" });
  expect(parseHostRelay({ ...relay, bootstrap: `${"A".repeat(42)}=` })).toEqual({ invalid: "bootstrap" });
});

test("the packaged window registers the Mac over its own channel, with a fresh host id", async () => {
  const { api, sent } = loopback();
  const calls = window(async () => ({ ok: true, value: { state: "online", diagnostic: null, devices: 0 } }));
  expect(await initializeHost(api, relay)).toEqual({ state: "online", diagnostic: null, devices: 0 });
  const request = calls[0].args.request as { operation: string; config: { hostId: string }; bootstrap: string };
  expect(calls[0].command).toBe("remote_local_setup");
  expect(request).toMatchObject({ operation: "initialize", config: { origin: relay.origin, relayId: "home" }, bootstrap: relay.bootstrap });
  expect(request.config.hostId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(sent).toEqual([]);
});

test("what the packaged window answers is final: its daemon has no loopback route to retry", async () => {
  const { api, sent } = loopback();
  window(async () => ({ ok: false, error: "relay_bootstrap" }));
  const refused = await initializeHost(api, relay).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(ApiError);
  expect((refused as ApiError).code).toBe("relay_bootstrap");

  window(async () => { throw "desktop_channel_unavailable"; });
  expect(((await initializeHost(api, relay).catch((error: unknown) => error)) as ApiError).code).toBe("desktop_channel_unavailable");
  expect(sent).toEqual([]);
});

test("a development window's refusal falls through to the loopback route and its stand-in", async () => {
  const { api, sent } = loopback((request) => request.operation === "dev_authenticate" ? { proof } : { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" });
  // Both commands refuse a dev origin before doing anything.
  window(async () => { throw "disabled"; });
  expect(await confirmPairing(api, "01ARZ3NDEKTSV4RRFFQ69G5FAV", challenge)).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
  expect(sent.map((request) => request.operation)).toEqual(["dev_authenticate", "confirm_pair"]);
});

test("Touch ID's proof pairs; a dismissed sheet asks no stand-in and spends nothing", async () => {
  const { api, sent } = loopback();
  const calls = window(async (command, args) => {
    if (command === "remote_native_confirmation") return { ok: true, proof, diagnostic: "local_confirmation" };
    return { ok: true, value: { deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAW", echoed: args.request } };
  });
  expect(await confirmPairing(api, "01ARZ3NDEKTSV4RRFFQ69G5FAV", challenge)).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
  expect(calls.map((call) => call.command)).toEqual(["remote_native_confirmation", "remote_local_setup"]);
  expect(calls[1].args.request).toEqual({ operation: "confirm_pair", pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", proof });

  const declined = window(async () => ({ ok: false, diagnostic: "cancelled" }));
  expect(((await confirmPairing(api, "01ARZ3NDEKTSV4RRFFQ69G5FAV", challenge).catch((error: unknown) => error)) as ApiError).code).toBe("cancelled");
  expect(declined.map((call) => call.command)).toEqual(["remote_native_confirmation"]);
  expect(sent).toEqual([]);
});

function admin(api: LocalApi) {
  const host: RemoteAdminHost = { api: api as unknown as RemoteAdminHost["api"], remote: false, stopped: false, start() {}, sessionView: () => { throw new Error("unused"); } };
  return new RemoteAdmin(host);
}

test("the card keeps the approve step after a dismissed sheet, and fails on anything else", async () => {
  const { api } = loopback();
  const remote = admin(api);
  const confirm = { phase: "confirm" as const, pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", code: "rb1", expiresUnix: 2_000_000_000, fingerprint: "a", name: "Pixel", deviceFingerprint: "b", challenge };
  remote.hostPairing = confirm;
  window(async () => ({ ok: false, diagnostic: "cancelled" }));
  await remote.confirmHostPairing();
  expect(remote.hostPairing).toEqual(confirm);

  window(async () => ({ ok: false, diagnostic: "expired" }));
  await remote.confirmHostPairing();
  expect(remote.hostPairing).toEqual({ phase: "failed", error: "expired" });
});

test("connecting takes the daemon's answer as the card's next state, and names a refusal", async () => {
  const { api } = loopback();
  const remote = admin(api);
  window(async () => ({ ok: false, error: "relay_unreachable" }));
  expect(await remote.connectHost(relay)).toBe(false);
  expect(remote.hostSetupError).toBe("relay_unreachable");
  expect(remote.hostSetupBusy).toBe(false);

  window(async () => ({ ok: true, value: { state: "online", diagnostic: null, devices: 0 } }));
  expect(await remote.connectHost(relay)).toBe(true);
  expect(remote.hostSetupError).toBeNull();
  expect(remote.remoteStatus).toEqual({ state: "online", diagnostic: null, devices: 0 });
});
