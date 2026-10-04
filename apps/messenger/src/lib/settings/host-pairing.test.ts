import { expect, test } from "bun:test";
import { flushSync } from "svelte";
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
  // The card lives on its own tab, which a runtime with no remote status does not show.
  const remoteTab = rendered.host.querySelector("[data-settings-tab=remote]");
  if (remoteTab) click(remoteTab);
  return { ...rendered, runtime };
}

test("remote access has a tab of its own, and General no longer carries the card", () => {
  const { host, close } = open(null);
  expect(host.querySelector(".settings-main-title")?.textContent).toBe("Remote access");
  expect(host.querySelector(".settings-card-remote .settings-card-title")?.textContent).toBe("Relay connection");
  click(host.querySelector("[data-settings-tab=general]"));
  expect(host.querySelector(".settings-card-remote")).toBeNull();
  expect(host.querySelector(".settings-card-workspace")).not.toBeNull();
  close();
});

test("a runtime that reports nothing about remote access shows no tab for it", () => {
  const { host, close } = open(null, { remoteStatus: null });
  expect(host.querySelector("[data-settings-tab=remote]")).toBeNull();
  expect(host.querySelector(".settings-card-remote")).toBeNull();
  close();
});

test("an online host offers to pair a device", () => {
  const { host, runtime, close } = open(null);
  const card = host.querySelector("[data-testid=remote-pairing]");
  expect(card?.textContent).toContain("Pair a device");
  click(card?.querySelector("button"));
  expect(runtime.calls.some((c) => c.name === "startHostPairing")).toBe(true);
  close();
});

test("connected devices show recent activity and require confirmation before removal", () => {
  const { host, runtime, close } = open(null, {
    hostDevices: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", name: "Pixel", lastActiveAt: 1_700_000_000 }],
  });
  const list = host.querySelector("[data-testid=host-devices]");
  expect(list?.textContent).toContain("Connected devices");
  expect(list?.textContent).toContain("Pixel");
  expect(list?.textContent).toContain("Last active");
  expect(list?.textContent).toMatch(/ago|年前/);
  click(host.querySelector("[data-testid=host-remove-01ARZ3NDEKTSV4RRFFQ69G5FAW]"));
  expect(host.querySelector("[data-testid=host-remove-confirm-01ARZ3NDEKTSV4RRFFQ69G5FAW]")?.textContent).toContain("Pixel");
  click(host.querySelector("[data-testid=host-remove-confirm-01ARZ3NDEKTSV4RRFFQ69G5FAW]"));
  expect(runtime.calls.some((c) => c.name === "removeHostDevice" && c.args[0] === "01ARZ3NDEKTSV4RRFFQ69G5FAW")).toBe(true);
  close();
});

// A reload with `?o=settings` restores the panel open, so nothing calls `openSettings()`, and at
// that moment the runtime has not connected yet. The card has to ask for the list itself.
test("a panel restored open loads the device list once the host comes online", () => {
  const { runtime, close } = open(null, { remoteStatus: null });
  // Reading `calls` before the flip would freeze the array the fixture pushes to, so the count
  // after it is the whole story: nothing while the host was still connecting, one list once on.
  runtime.remoteStatus = { state: "online", diagnostic: null, devices: 1 };
  flushSync();
  expect(runtime.calls.filter((c) => c.name === "refreshHostDevices")).toHaveLength(1);
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
  expect(host.querySelector("[data-testid=pairing-needs-hello]")).toBeNull();
  close();
});

test("an approval Windows Hello could not ask for says to set Hello up, and keeps the approve button", () => {
  const { host, close } = open({
    phase: "confirm",
    pairingId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    code,
    expiresUnix: 2_000_000_000,
    fingerprint: hostFingerprint,
    name: "Pixel",
    deviceFingerprint,
    challenge: `${"c".repeat(43)}=`,
    note: "hello_not_configured",
  });
  expect(host.querySelector("[data-testid=pairing-needs-hello]")?.textContent).toContain("Sign-in options");
  expect(host.querySelector("[data-testid=pairing-confirm]")).not.toBeNull();
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

test("a Mac not yet on a relay asks for one before offering to pair", () => {
  const { host, runtime, close } = open(null, { remoteStatus: { state: "off", diagnostic: null, devices: 0 } });
  const form = host.querySelector<HTMLFormElement>("[data-testid=remote-connect]");
  expect(form?.textContent).toContain("Relay address");
  expect(host.querySelector("[data-testid=remote-pairing]")).toBeNull();
  // A typo is named before the one-time token is spent.
  fill(host, "#relay-connect-origin", "http://relay.example.com");
  fill(host, "#relay-connect-id", "home");
  fill(host, "#relay-connect-token", "A".repeat(43));
  form?.requestSubmit();
  flushSync();
  expect(form?.textContent).toContain("https:// URL with no path");
  fill(host, "#relay-connect-origin", "https://relay.example.com/");
  form?.requestSubmit();
  flushSync();
  const connects = runtime.calls.filter((c) => c.name === "connectHost");
  expect(connects).toHaveLength(1);
  expect(connects[0].args[0]).toEqual({ origin: "https://relay.example.com", relayId: "home", bootstrap: "A".repeat(43) });
  close();
});

test("the connect form says why the relay turned the Mac away", () => {
  const { host, close } = open(null, { remoteStatus: { state: "off", diagnostic: null, devices: 0 }, hostSetupError: "relay_bootstrap" });
  expect(host.querySelector("[data-testid=remote-connect-error]")?.textContent).toContain("refused the token");
  close();
});

test("a build whose credential store cannot be set up offers no connect form", () => {
  const { host, close } = open(null, { remoteStatus: { state: "off", diagnostic: "sealed_runtime_required", devices: 0 } });
  expect(host.querySelector("[data-testid=remote-connect]")).toBeNull();
  expect(host.querySelector("[data-testid=remote-setup-note]")?.textContent).toContain("REAL_BOT_DEV_REMOTE=1");
  close();
});

test("the connect form folds away how to deploy a relay, with commands to copy and the full guide", () => {
  const { host, close } = open(null, { remoteStatus: { state: "off", diagnostic: null, devices: 0 } });
  const guide = host.querySelector<HTMLDetailsElement>("[data-testid=remote-connect] [data-testid=relay-guide]");
  expect(guide?.open).toBe(false);
  expect(guide?.querySelector("summary")?.textContent).toContain("Deploy one on your own server");
  expect(guide?.querySelector("[data-testid=relay-guide-prepare]")?.textContent).toContain("git clone https://github.com/Blackman99/deskfolk.git");
  expect(guide?.querySelector("[data-testid=relay-guide-env]")?.textContent).toContain("RELAY_PAIRING_ENABLED=1");
  expect(guide?.querySelector("[data-testid=relay-guide-up]")?.textContent).toContain("up -d --build");
  expect(guide?.querySelector("[data-testid=relay-guide-pairingOff]")?.textContent).toContain("RELAY_PAIRING_ENABLED=0");
  expect(guide?.textContent).toContain("Full deployment guide");
  close();
});

function fill(host: Element, selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
