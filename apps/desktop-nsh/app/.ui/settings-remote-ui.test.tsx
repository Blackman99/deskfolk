import { expect, test } from "nsh/test";
import { copyFor } from "../src/m/copy.ts";
import { RELAY_GUIDE_COMMANDS } from "../src/m/settings/relay-guide.ts";
import { parseIceLines, iceLines } from "../src/ui/settings/remote-screen-ice";
import { openStory } from "./fixture";

const t = copyFor("zh");

async function remote() {
  const app = await openStory("settings-remote-ui");
  await app.waitFor("id:page-remote", { timeout: 10_000 });
  await app.waitFor("id:remote-footnote");
  return app;
}

test("one ICE server per line, and a line that is not stun: or turn: refuses the lot", () => {
  const servers = parseIceLines("stun:relay.example.com:3478\n\n  turn:relay.example.com:3478?transport=udp me secret  \n");
  expect(servers).toEqual([
    { urls: ["stun:relay.example.com:3478"] },
    { urls: ["turn:relay.example.com:3478?transport=udp"], username: "me", credential: "secret" },
  ]);
  expect(iceLines(servers!)).toBe("stun:relay.example.com:3478\nturn:relay.example.com:3478?transport=udp me secret");
  expect(parseIceLines("https://relay.example.com")).toBeNull();
});

test("the badge says what state the relay link is in, and only a state that needs it explains itself", async () => {
  const app = await remote();
  await app.press("id:mock-online");
  await app.waitUntil(() => app.texts().includes(t.remote.statusOnline));
  expect(app.shows("text:" + t.remote.experimental)).toBe(false);
  await app.press("id:mock-gated");
  await app.waitUntil(() => app.texts().includes(t.remote.statusGated));
  expect(app.texts()).toContain(t.remote.experimental);
  await app.press("id:mock-sealed");
  await app.waitFor("id:remote-setup-note");
  expect(app.texts()).toContain(t.remote.setupNeedsDevSwitch);
  expect(app.shows("id:remote-connect")).toBe(false);
});

test("the connect form names the field a bad address is in, and asks for all three before it connects", async () => {
  const app = await remote();
  await app.press("id:mock-off");
  await app.waitFor("id:remote-connect");
  expect(app.enabled("id:remote-connect-submit")).toBe(false);
  await app.type("id:relay-connect-origin", "not a url");
  await app.type("id:relay-connect-id", "my-relay");
  await app.type("id:relay-connect-token", "a".repeat(43));
  await app.waitUntil(() => app.enabled("id:remote-connect-submit"));
  await app.press("id:remote-connect-submit");
  await app.waitFor("id:relay-connect-origin-error");
  expect(app.texts()).toContain(t.remote.hostConnectInvalidOrigin);
  expect(app.texts().some((text) => text.startsWith("log:connect"))).toBe(false);
  await app.clear("id:relay-connect-origin");
  await app.type("id:relay-connect-origin", "https://relay.example.com");
  await app.press("id:remote-connect-submit");
  await app.waitUntil(() => app.texts().includes("log:connect:https://relay.example.com|my-relay"));
  expect(app.shows("id:relay-connect-origin-error")).toBe(false);
  // The token is checked before it is spent.
  await app.clear("id:relay-connect-token");
  await app.type("id:relay-connect-token", "short");
  await app.press("id:remote-connect-submit");
  await app.waitFor("id:relay-connect-token-error");
  expect(app.texts()).toContain(t.remote.hostConnectInvalidToken);
});

test("the relay guide opens on its summary, copies a command, and links the full guide", async () => {
  const app = await remote();
  await app.press("id:mock-off");
  await app.waitFor("id:relay-guide-summary");
  expect(app.shows("id:relay-guide-body")).toBe(false);
  await app.press("id:relay-guide-summary");
  await app.waitFor("id:relay-guide-body");
  expect(app.texts()).toContain(t.remote.relayGuideLead);
  expect(app.texts()).toContain(RELAY_GUIDE_COMMANDS.up);
  expect(app.shows("id:relay-guide-pairingOff")).toBe(true);
  await app.press("id:relay-guide-copy-up");
  await app.waitUntil(() => app.clipboard() === RELAY_GUIDE_COMMANDS.up);
  await app.waitUntil(() => app.texts().includes(t.chat.copied));
  await app.press("id:relay-guide-full");
  await app.waitUntil(() => app.openedUrls().length > 0);
  expect(app.openedUrls()[0]).toMatch(/^https:/);
  await app.press("id:relay-guide-summary");
  await app.waitFor("id:relay-guide-body", { state: "gone" });
});

test("pairing: the code to paste, both fingerprints, then approve or cancel", async () => {
  const app = await remote();
  await app.press("id:mock-online");
  await app.waitFor("id:pairing-start");
  expect(app.texts()).toContain(t.remote.hostPairEmpty);
  await app.press("id:mock-offer");
  await app.waitFor("id:pairing-code");
  expect(app.texts()).toContain("dfpair1.CODE0123456789");
  expect(app.shows("id:pairing-waiting")).toBe(true);
  expect(app.shows("id:pairing-confirm")).toBe(false);
  await app.press("id:pairing-copy");
  await app.waitUntil(() => app.clipboard() === "dfpair1.CODE0123456789");
  await app.waitUntil(() => app.texts().includes("copied:true"));
  await app.press("id:mock-confirm");
  await app.waitFor("id:pairing-confirm");
  expect(app.texts()).toContain(t.remote.hostPairArrived("Pixel 9"));
  expect(app.shows("id:pairing-needs-hello")).toBe(true);
  expect(app.shows("id:pairing-dismiss")).toBe(false);
  await app.press("id:pairing-cancel-confirm");
  await app.waitFor("id:pairing-code", { state: "gone" });
  await app.waitFor("id:pairing-start");
});

test("a finished or failed pairing says so and offers its way on", async () => {
  const app = await remote();
  await app.press("id:mock-paired");
  await app.waitFor("id:pairing-done");
  expect(app.texts()).toContain(t.remote.hostPairDone);
  await app.press("id:pairing-close");
  await app.waitFor("id:pairing-done", { state: "gone" });
  await app.press("id:mock-failed");
  await app.waitFor("id:pairing-failed");
  expect(app.texts()).toContain(t.remote.hostPairExpired);
  expect(app.shows("id:pairing-retry")).toBe(true);
  await app.press("id:pairing-failed-close");
  await app.waitFor("id:pairing-failed", { state: "gone" });
});

test("paired devices list with their last activity; removing asks for a second press", async () => {
  const app = await remote();
  await app.press("id:mock-devices");
  await app.waitFor("id:host-device-dev1");
  expect(app.texts()).toContain("Pixel 9");
  expect(app.texts()).toContain(t.remote.lastActiveUnknown);
  expect(app.texts()).toContain(t.remote.lastActive("1小时前"));
  expect(app.shows("id:host-remove-confirm-dev1")).toBe(false);
  await app.press("id:host-remove-dev1");
  await app.waitFor("id:host-remove-confirm-dev1");
  expect(app.texts()).toContain(t.remote.removeDeviceConfirm("Pixel 9"));
  expect(app.shows("id:host-remove-confirm-dev2")).toBe(false);
  await app.press("id:mock-online");
  await app.waitFor("text:" + t.remote.hostPairEmpty);
});

test("the Mac's remote screen: the switch, who is connected, and the ICE servers it saves", async () => {
  const app = await remote();
  await app.press("id:page-screen");
  await app.waitFor("id:remote-screen-sharing");
  expect(app.texts()).toContain(t.screen.macSharingOff);
  expect(app.texts()).toContain(t.screen.macActive("Android Chrome", t.screen.direct));
  expect(app.texts()).toContain(t.screen.macTraffic("3.0", "2336×1510"));
  expect(app.shows("id:remote-screen-lowered")).toBe(true);
  expect(app.shows("id:remote-screen-vnc")).toBe(false);
  // The ICE field starts as the saved servers; saving is only possible once it was edited.
  expect(app.value("id:remote-screen-ice")).toBe("stun:relay.example.com:3478");
  expect(app.enabled("id:remote-screen-ice-save")).toBe(false);
  await app.clear("id:remote-screen-ice");
  await app.type("id:remote-screen-ice", "http://nope");
  await app.press("id:remote-screen-ice-save");
  await app.waitFor("id:remote-screen-ice-error");
  await app.clear("id:remote-screen-ice");
  await app.type("id:remote-screen-ice", "turn:relay.example.com:3478 me secret");
  await app.press("id:remote-screen-ice-save");
  await app.waitFor("id:remote-screen-ice-error", { state: "gone" });
  await app.waitUntil(() => !app.enabled("id:remote-screen-ice-save"));
  await app.press("id:remote-screen-disconnect");
  await app.waitFor("id:remote-screen-disconnect", { state: "gone" });
  await app.press("id:remote-screen-toggle");
  await app.waitFor("id:remote-screen-sharing", { state: "gone" });
});

test("on Windows with no VNC server answering, the card says how to set TightVNC up and links its download", async () => {
  const app = await remote();
  await app.press("id:page-screen");
  await app.waitFor("id:remote-screen-sharing");
  await app.press("id:mock-windows");
  await app.waitFor("id:remote-screen-vnc");
  expect(app.texts()).toContain(t.screen.macVncSteps);
  await app.press("id:remote-screen-sharing-open");
  await app.waitUntil(() => app.openedUrls().includes("https://www.tightvnc.com/download.php"));
});

test("the remote session page shows the runtime's maintenance and asks twice before a forced restart or a stop", async () => {
  const app = await remote();
  await app.press("id:page-session");
  await app.waitFor("id:remote-maintenance");
  expect(app.texts()).toContain(t.remote.version("0.4.0"));
  expect(app.texts()).toContain(t.remote.modeWindow);
  expect(app.texts()).toContain(t.remote.restartAvailable);
  expect(app.texts()).toContain(t.remote.drainWaiting(2));
  expect(app.texts()).toContain(t.remote.noOtherDevices);
  expect(app.texts()).toContain(t.remote.pushDenied);
  expect(app.enabled("id:remote-force-restart")).toBe(true);
  expect(app.shows("id:remote-force-confirm")).toBe(false);
  await app.press("id:remote-force-restart");
  await app.waitFor("id:remote-force-confirm");
  expect(app.texts()).toContain(t.remote.forceWarn);
  await app.press("id:remote-force-cancel");
  await app.waitFor("id:remote-force-confirm", { state: "gone" });
  await app.press("id:remote-stop");
  await app.waitFor("id:remote-stop-confirm");
  await app.press("id:remote-stop-cancel");
  await app.waitFor("id:remote-stop-confirm", { state: "gone" });
});
