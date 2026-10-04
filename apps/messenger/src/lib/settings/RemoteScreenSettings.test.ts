import { expect, test } from "bun:test";
import { iceLines, parseIceLines } from "./RemoteScreenSettings.svelte";

test("one ICE server per line, a TURN server with its username and credential", () => {
  const servers = parseIceLines("stun:relay.example.com:3478\n\n  turn:relay.example.com:3478?transport=udp me secret  \n");
  expect(servers).toEqual([
    { urls: ["stun:relay.example.com:3478"] },
    { urls: ["turn:relay.example.com:3478?transport=udp"], username: "me", credential: "secret" },
  ]);
  expect(iceLines(servers!)).toBe("stun:relay.example.com:3478\nturn:relay.example.com:3478?transport=udp me secret");
  expect(parseIceLines("")).toEqual([]);
});

test("anything that is not a stun: or turn: address is refused whole", () => {
  for (const bad of ["https://relay.example.com", "stun:relay.example.com extra words here", "relay.example.com:3478"]) {
    expect(parseIceLines(`stun:ok.example:3478\n${bad}`)).toBeNull();
  }
});

test("the card says when a phone's smooth mode has the screen lowered, and to what", async () => {
  const { flushSync } = await import("svelte");
  const { render } = await import("../test-render.ts");
  const { copyFor } = await import("../copy.ts");
  const { default: RemoteScreenSettings } = await import("./RemoteScreenSettings.svelte");
  const t = copyFor("zh");
  const base = { enabled: true, iceServers: [], sharing: true, direct: true, sessions: [{ deviceId: "d1", deviceName: "Android Chrome", mode: "direct" as const, since: 0, toPhone: 0, fromPhone: 0 }] };
  let status: Record<string, unknown> = { ...base, lowered: { width: 2336, height: 1510, fromWidth: 4112, fromHeight: 2658 } };
  const view = render(RemoteScreenSettings as never, { api: { remoteScreen: async () => status }, t, pollMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  flushSync();
  expect(view.host.querySelector('[data-testid="remote-screen-lowered"]')?.textContent?.trim()).toBe(t.screen.macLowered("2336×1510", "4112×2658"));
  status = base;
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
  expect(view.host.querySelector('[data-testid="remote-screen-lowered"]')).toBeNull();
  view.close();
});

test("on Windows, with no VNC server answering, the card says how to set TightVNC up and links its download", async () => {
  const { flushSync } = await import("svelte");
  const { render, click } = await import("../test-render.ts");
  const { copyFor } = await import("../copy.ts");
  const { default: RemoteScreenSettings } = await import("./RemoteScreenSettings.svelte");
  const t = copyFor("zh");
  const opened: unknown[] = [];
  const internals = { invoke: async (command: string, args: unknown) => { opened.push([command, args]); } };
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  const status = { enabled: true, iceServers: [], sharing: false, direct: true, sessions: [] };
  const mount = (windows: boolean) => render(RemoteScreenSettings as never, { api: { remoteScreen: async () => status }, t, pollMs: 60_000, windows });
  try {
    const pc = mount(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync();
    expect(pc.host.querySelector('[data-testid="remote-screen-vnc"]')?.textContent).toContain("TightVNC");
    click([...pc.host.querySelectorAll("button")].find((button) => button.textContent?.trim() === t.screen.macSharingSettings));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual([["open_external_url", { url: "https://www.tightvnc.com/download.php" }]]);
    pc.close();
    // A Mac has its own Screen Sharing: no install steps, and the button opens its Sharing pane.
    const mac = mount(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync();
    expect(mac.host.querySelector('[data-testid="remote-screen-vnc"]')).toBeNull();
    mac.close();
  } finally {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  }
});
