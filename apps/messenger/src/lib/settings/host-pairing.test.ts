import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { click, render } from "../test-render.ts";
import SettingsModal from "./SettingsModal.svelte";

const code = `rb1${"A".repeat(200)}`;
const hostFingerprint = "0a035c56b37ea8c921810ba8965c05b9675176fce7e636b77f1d4bbad0495ca7";
const deviceFingerprint = "0b59c5042cde8231d93d4c4943b077158c48311ccb14ddf14388a5f88700e3ae";

function open(hostPairing: unknown, extra: Record<string, unknown> = {}) {
  const runtime = reactive(fakeRuntime({}, {
    settingsOpen: true,
    remoteStatus: { state: "online", diagnostic: null, devices: 0 },
    hostPairing,
    hostPairingBusy: false,
    ...extra,
  }));
  const rendered = render(SettingsModal, {
    runtime,
    t: copyFor("en"),
    saveFailed: false,
    providerEditor: null,
    confirmingProvider: false,
    patchImmediate: async () => true,
    openDeleteProviderConfirm: () => {},
    closeSettings: () => {},
  });
  return { ...rendered, runtime };
}

test("an online host offers to pair a device", () => {
  const { host, runtime, close } = open(null);
  const card = host.querySelector("[data-testid=remote-pairing]");
  expect(card?.textContent).toContain("Pair a device");
  click(card?.querySelector("button"));
  expect(runtime.calls.some((c) => c.name === "startHostPairing")).toBe(true);
  close();
});

test("the code is on screen with a copy button, next to the fingerprint the device must show", () => {
  const { host, close } = open({ phase: "offer", pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", code, expiresUnix: 2_000_000_000, fingerprint: hostFingerprint });
  expect(host.querySelector("[data-testid=pairing-code]")?.textContent).toBe(code);
  expect(host.querySelector("[data-testid=pairing-copy]")).not.toBeNull();
  // Grouped, never truncated: it is compared by eye against the device.
  expect(host.querySelector("[data-testid=remote-pairing]")?.textContent).toContain("0a03 5c56");
  expect(host.querySelector("[data-testid=remote-pairing]")?.textContent).toContain("Waiting for the device");
  expect(host.querySelector("[data-testid=pairing-confirm]")).toBeNull();
  close();
});

test("a submitted device shows its own fingerprint and only then an approve button", () => {
  const { host, runtime, close } = open({
    phase: "confirm",
    pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    code,
    expiresUnix: 2_000_000_000,
    fingerprint: hostFingerprint,
    name: "Pixel",
    deviceFingerprint,
    challenge: `${"c".repeat(43)}=`,
  });
  const card = host.querySelector("[data-testid=remote-pairing]");
  expect(card?.textContent).toContain("Pixel is asking to pair");
  expect(card?.textContent).toContain("0b59 c504");
  click(host.querySelector("[data-testid=pairing-confirm]"));
  expect(runtime.calls.some((c) => c.name === "confirmHostPairing")).toBe(true);
  close();
});

test("a hosted remote session gets no pairing card at all", () => {
  const { host, close } = open(null, { remote: true, hosted: true });
  expect(host.querySelector("[data-testid=remote-pairing]")).toBeNull();
  close();
});

test("an expired window says so instead of leaving a dead code on screen", () => {
  const { host, close } = open({ phase: "failed", error: "expired" });
  expect(host.querySelector("[data-testid=remote-pairing]")?.textContent).toContain("expired");
  expect(host.querySelector("[data-testid=pairing-code]")).toBeNull();
  close();
});
