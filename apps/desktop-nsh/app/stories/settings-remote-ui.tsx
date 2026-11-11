/**
 * Settings › Remote access and Settings › Interface: the relay guide, the Mac's remote screen card,
 * the remote tab (pairing a phone, devices, remote session) and the interface tab (ADR 0106) with
 * its five cards. A row of buttons at the top switches the page and sets the runtime's remote state
 * the way the daemon would report it, so every state can be reached.
 */
import { Scroll, signal, Text, View } from "nsh";
import type { RemoteScreenStatus } from "@real-bot/protocol";
import { copy, runtime } from "../src/runtime";
import { parseHostRelay, type HostRelayField } from "../src/m/remote/pairing-host.ts";
import type { LocalApi } from "../src/m/local-api.ts";
import { ToastHost } from "../src/ui/ToastHost";
import { RelayGuide } from "../src/ui/settings/RelayGuide";
import { RemoteScreenSettings } from "../src/ui/settings/RemoteScreenSettings";
import { RemoteSessionSettings } from "../src/ui/settings/RemoteSessionSettings";
import { RemoteTab } from "../src/ui/settings/RemoteTab";
import { InterfaceTab, type InterfaceTabController } from "../src/ui/settings/InterfaceTab";

type Page = "remote" | "interface" | "guide" | "screen" | "session";

const FINGERPRINT = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const DEVICE_PRINT = "99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa";

function Chip(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.id} onPress={props.onPress} class="px-2 py-1 border border-line rounded-(--radius-sm) bg-pane">
      <Text class="text-[11px] text-ink">{props.label}</Text>
    </View>
  );
}

export default function SettingsRemoteUi() {
  const page = signal<Page>("remote");
  const pairingCopied = signal(false);
  const relayForm = signal({ origin: "", relayId: "", bootstrap: "" });
  const relayInvalid = signal<HostRelayField | null>(null);
  const log = signal("");
  const handle = signal<InterfaceTabController | null>(null);

  // A fake local API for the standalone remote screen card.
  const screen = signal<RemoteScreenStatus>({
    enabled: true,
    iceServers: [{ urls: ["stun:relay.example.com:3478"] }],
    sharing: false,
    direct: true,
    sessions: [{ deviceId: "d1", deviceName: "Android Chrome", mode: "direct", since: 0, toPhone: 3 * 1024 * 1024, fromPhone: 0, framebuffer: { width: 2336, height: 1510 } }],
    lowered: { width: 2336, height: 1510, fromWidth: 4112, fromHeight: 2658 },
  } as RemoteScreenStatus);
  const screenApi = {
    kind: "local",
    remoteScreen: async () => screen(),
    setRemoteScreen: async (body: { enabled?: boolean; iceServers?: RemoteScreenStatus["iceServers"] }) => {
      screen.set({ ...screen(), ...(body.enabled === undefined ? {} : { enabled: body.enabled }), ...(body.iceServers ? { iceServers: body.iceServers } : {}) });
      return screen();
    },
    disconnectRemoteScreen: async () => {
      screen.set({ ...screen(), sessions: [] });
      return screen();
    },
  } as unknown as LocalApi;
  const windows = signal(false);

  // The interface profile through the runtime, for tests to seed and read back (the daemon keeps one per run).
  const profileText = signal("");
  const edit = (patch: Record<string, unknown>) => async () => {
    await runtime.client?.patchInterface({ patch: patch as never });
  };
  const readProfile = async () => {
    profileText.set("");
    const state = await runtime.client?.getInterface();
    if (!state) return;
    const { css, behaviour, tokens, copy: words, enabled } = state.profile;
    profileText.set(JSON.stringify({ css, behaviour, tokens, copy: words, enabled, revisions: state.recent.map((head) => head.id) }));
  };

  async function connectRelay(): Promise<void> {
    const parsed = parseHostRelay(relayForm());
    if ("invalid" in parsed) {
      relayInvalid.set(parsed.invalid);
      return;
    }
    relayInvalid.set(null);
    log.set(`connect:${parsed.relay.origin}|${parsed.relay.relayId}`);
    if (await runtime.connectHost(parsed.relay)) relayForm.set({ origin: "", relayId: "", bootstrap: "" });
  }

  const status = (state: "off" | "online" | "activation_gated" | "connecting", devices = 0, diagnostic: string | null = null) => () => {
    runtime.remoteStatus = { state, devices, diagnostic };
    runtime.hostPairing = null as never;
  };
  const pairing = (value: unknown) => () => {
    runtime.remoteStatus = { state: "online", diagnostic: null, devices: 1 };
    runtime.hostPairing = value as never;
  };

  const lang = () => runtime.snapshot.settings.locale;
  return (
    <View class="flex-col flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-2">
        <Chip id="page-remote" label="remote" onPress={() => page.set("remote")} />
        <Chip id="page-interface" label="interface" onPress={() => page.set("interface")} />
        <Chip id="page-guide" label="guide" onPress={() => page.set("guide")} />
        <Chip id="page-screen" label="screen" onPress={() => page.set("screen")} />
        <Chip
          id="page-session"
          label="session"
          onPress={() => {
            runtime.maintenance = { version: "0.4.0", mode: "window", reachability: "ok", restart: "available", stopped: false, drain: { phase: "draining", remaining: 2, forced: false }, devices: [] };
            runtime.uvReady = true;
            runtime.pushPermission = "denied";
            page.set("session");
          }}
        />
        <Chip id="mock-off" label="off" onPress={status("off")} />
        <Chip id="mock-sealed" label="sealed" onPress={status("off", 0, "sealed_runtime_required")} />
        <Chip id="mock-gated" label="gated" onPress={status("activation_gated")} />
        <Chip id="mock-online" label="online" onPress={status("online", 0)} />
        <Chip
          id="mock-devices"
          label="devices"
          onPress={() => {
            status("online", 2)();
            runtime.hostDevices = [
              { id: "dev1", name: "Pixel 9", lastActiveAt: Math.floor(Date.now() / 1000) - 3600 },
              { id: "dev2", name: "iPad", lastActiveAt: null },
            ];
          }}
        />
        <Chip id="mock-offer" label="offer" onPress={pairing({ phase: "offer", pairingId: "p1", code: "dfpair1.CODE0123456789", expiresUnix: 9999999999, fingerprint: FINGERPRINT })} />
        <Chip
          id="mock-confirm"
          label="confirm"
          onPress={pairing({ phase: "confirm", pairingId: "p1", code: "dfpair1.CODE0123456789", expiresUnix: 9999999999, fingerprint: FINGERPRINT, name: "Pixel 9", deviceFingerprint: DEVICE_PRINT, challenge: "c", note: "hello_not_configured" })}
        />
        <Chip id="mock-paired" label="paired" onPress={pairing({ phase: "paired", deviceId: "dev1" })} />
        <Chip id="mock-failed" label="failed" onPress={pairing({ phase: "failed", error: "expired" })} />
        <Chip id="mock-windows" label="windows" onPress={() => windows.set(!windows())} />
        <Chip id="seed-reset" label="reset" onPress={edit({ reset: ["tokens", "behaviour", "css", "copy"], enabled: true })} />
        <Chip id="seed-copy" label="copy" onPress={edit({ copy: { zh: { "composer.send": "发出去" } } })} />
        <Chip id="seed-motion" label="motion" onPress={edit({ behaviour: { motion: "reduce" }, tokens: { light: { "--accent": "red" } } })} />
        <Chip id="seed-css-other" label="css" onPress={edit({ css: { set: ".bot { color: blue }" } })} />
        <Chip id="read-profile" label="read" onPress={() => void readProfile()} />
        <Text testID="profile" class="text-[11px] text-ink-muted">{`profile=${profileText()}`}</Text>
        <Chip id="probe-back" label="back" onPress={() => log.set(`back:${handle()?.backFromSection()}`)} />
        <Text testID="log" class="text-[11px] text-ink-muted">{`log:${log()}`}</Text>
        <Text testID="section-title" class="text-[11px] text-ink-muted">{`title:${handle()?.sectionTitle() ?? ""}`}</Text>
        <Text testID="copied-mark" class="text-[11px] text-ink-muted">{`copied:${pairingCopied()}`}</Text>
      </View>
      <If when={page() === "remote"}>
        <Scroll class="flex-1 px-4 py-2">
          <RemoteTab
            locale={lang()}
            relativeTimeNow={Date.now()}
            pairingCopied={pairingCopied()}
            onPairingCopiedChange={(v) => pairingCopied.set(v)}
            relayForm={relayForm()}
            onRelayFormChange={(next) => relayForm.set(next)}
            relayInvalid={relayInvalid()}
            connectRelay={connectRelay}
          />
        </Scroll>
      </If>
      <If when={page() === "guide"}>
        <Scroll class="flex-1 px-4 py-2">
          <RelayGuide locale={lang()} />
        </Scroll>
      </If>
      <If when={page() === "session"}>
        <Scroll class="flex-1 px-4 py-2">
          <RemoteSessionSettings />
        </Scroll>
      </If>
      <If when={page() === "screen"}>
        <Scroll class="flex-1 px-4 py-2">
          <RemoteScreenSettings api={screenApi} pollMs={400} windows={windows()} />
        </Scroll>
      </If>
      <If when={page() === "interface"}>
        <InterfaceTab snapshot={runtime.snapshot} locale={lang()} controller={(h) => handle.set(h)} />
      </If>
      <ToastHost />
    </View>
  );
}
