/**
 * The Mac's half of the remote screen (`settings/RemoteScreenSettings.svelte`): whether paired
 * devices may view and control it, whether the system's screen sharing is there to serve them, which
 * ICE servers a direct connection may use, and who is connected now. Reachable only from this
 * window: no paired device can change it. On Windows the server is a VNC server the person installs
 * (ADR 0059): while none answers, the card says how to set TightVNC up and links its download page.
 *
 * Needs from the shell: `open_external_url` with `x-apple.systempreferences:com.apple.Sharing-Settings.extension`
 * (the app's own `open_external_url` answers http(s) and mailto only, so the macOS Sharing pane does
 * not open until it also allows that one address).
 *
 * Props: `api` (the local API); `pollMs` (how often the card looks again, default 5000); `windows`
 * (the OS; default from `platform.os`). `parseIceLines` and `iceLines` are in `remote-screen-ice.ts`.
 */
import { cleanup, platform, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { RemoteScreenStatus } from "@real-bot/protocol";
import { copy } from "../../runtime";
import type { LocalApi } from "../../m/local-api.ts";
import { isTauri, readTauriInternals } from "../../m/tauri.ts";
import { Button } from "../Button";
import { Switch } from "../Switch";
import { iceLines, parseIceLines } from "./remote-screen-ice";

export function RemoteScreenSettings(props: { api: LocalApi; pollMs?: number; windows?: boolean }) {
  const t = () => copy();
  const windows = () => props.windows ?? platform.os === "windows";
  const status = signal<RemoteScreenStatus | null>(null);
  const busy = signal(false);
  const failed = signal(false);
  const iceText = signal("");
  const iceDirty = signal(false);
  const iceInvalid = signal(false);

  async function load(): Promise<void> {
    try {
      const next = await props.api.remoteScreen();
      status.set(next);
      failed.set(false);
      if (!iceDirty()) iceText.set(iceLines(next.iceServers));
    } catch {
      failed.set(true);
    }
  }

  async function update(body: Parameters<LocalApi["setRemoteScreen"]>[0]): Promise<void> {
    busy.set(true);
    try {
      status.set(await props.api.setRemoteScreen(body));
      failed.set(false);
    } catch {
      failed.set(true);
    } finally {
      busy.set(false);
    }
  }

  async function saveIce(): Promise<void> {
    const servers = parseIceLines(iceText());
    iceInvalid.set(servers === null);
    if (!servers) return;
    await update({ iceServers: servers });
    if (!failed()) iceDirty.set(false);
  }

  async function disconnect(): Promise<void> {
    busy.set(true);
    try {
      status.set(await props.api.disconnectRemoteScreen());
    } catch {
      failed.set(true);
    } finally {
      busy.set(false);
    }
  }

  /** The system's Sharing pane, or on Windows TightVNC's download page. */
  async function openSharing(): Promise<void> {
    const internals = readTauriInternals();
    if (!isTauri(internals) || !internals?.invoke) return;
    const url = windows() ? "https://www.tightvnc.com/download.php" : "x-apple.systempreferences:com.apple.Sharing-Settings.extension";
    try {
      await internals.invoke("open_external_url", { url });
    } catch {
      // Nothing to fall back to: the description already names where the switch is.
    }
  }

  void load();
  const timer = setInterval(() => void load(), props.pollMs ?? 5000);
  cleanup(() => clearInterval(timer));

  return (
    <View testID="remote-screen" class="flex-col gap-2 mt-3 pt-1 border-t border-line-subtle">
      <View class="flex-row items-center justify-between gap-4 px-[2px] py-3">
        <View class="flex-col gap-[2px] min-w-0 shrink grow">
          <Text testID="remote-screen-label" class="text-[13px] font-medium text-ink leading-[1.3]">{t().screen.macToggle}</Text>
          <Text class="text-[12px] text-ink-muted leading-[1.35]">{t().screen.macToggleDesc}</Text>
        </View>
        <Switch
          testID="remote-screen-toggle"
          label={t().screen.macToggle}
          checked={status()?.enabled ?? false}
          disabled={busy() || !status()}
          onChange={(enabled) => void update({ enabled })}
        />
      </View>
      <If when={failed()}>
        <Text class="text-[12px] text-danger-text">{t().screen.macFailed}</Text>
      </If>
      <If when={status()?.enabled}>
        <View class="flex-row items-center justify-between gap-2">
          <Text testID="remote-screen-sharing" class={`text-[13px] ${status()?.sharing ? "text-ink-muted" : "text-danger-text"}`}>
            {status()?.sharing ? t().screen.macSharingOn : t().screen.macSharingOff}
          </Text>
          <If when={!status()?.sharing}>
            <Button size="sm" testID="remote-screen-sharing-open" onPress={() => void openSharing()}>{t().screen.macSharingSettings}</Button>
          </If>
        </View>
        <If when={windows() && !status()?.sharing}>
          <Text testID="remote-screen-vnc" class="text-[12px] text-ink-muted leading-[1.35]">{t().screen.macVncSteps}</Text>
        </If>
        <Each of={status()?.sessions ?? []} key={(session) => session.deviceId}>
          {(session) => (
            <View role="text" class="flex-row items-center justify-between gap-2 px-[10px] py-2 border border-accent-border rounded-(--radius-sm) bg-accent-tint">
              <View class="flex-col min-w-0 shrink">
                <Text class="text-[13px] text-ink">
                  {t().screen.macActive(
                    session().deviceName,
                    session().mode === "relay" ? t().screen.relay : session().mode === "direct" ? t().screen.direct : t().screen.connecting,
                  )}
                </Text>
                <Text testID="remote-screen-traffic" class="text-[12px] text-ink-muted">
                  {t().screen.macTraffic(
                    (session().toPhone / (1024 * 1024)).toFixed(1),
                    session().framebuffer ? `${session().framebuffer!.width}×${session().framebuffer!.height}` : null,
                  )}
                </Text>
              </View>
              <Button size="sm" variant="danger-soft" testID="remote-screen-disconnect" disabled={busy()} onPress={() => void disconnect()}>
                {t().screen.macDisconnect}
              </Button>
            </View>
          )}
        </Each>
        <If when={status()?.lowered}>
          <Text testID="remote-screen-lowered" class="text-[12px] text-ink-muted leading-[1.4]">
            {(() => {
              const lowered = status()?.lowered;
              return lowered ? t().screen.macLowered(`${lowered.width}×${lowered.height}`, `${lowered.fromWidth}×${lowered.fromHeight}`) : "";
            })()}
          </Text>
        </If>
        <If when={status()?.direct}>
          <View class="flex-col gap-1 px-[2px] pt-1">
            <Text class="text-[13px] font-medium text-ink leading-[1.3]">{t().screen.macIceServers}</Text>
            <Text class="text-[12px] text-ink-muted leading-[1.35]">{t().screen.macIceServersDesc}</Text>
            <Input
              testID="remote-screen-ice"
              accessibilityLabel={t().screen.macIceServers}
              multiline
              autoCorrect={false}
              autoCapitalize="none"
              value={iceText()}
              onChange={(e) => {
                iceText.set(e.value);
                iceDirty.set(true);
                iceInvalid.set(false);
              }}
              class="w-full mt-1 min-h-[64px] px-2 py-[6px] border border-line rounded-(--radius-sm) bg-input-bg text-ink font-mono text-[12px] focus:border-field-focus-border"
            />
            <View class="flex-row items-center justify-end gap-2">
              <If when={iceInvalid()}>
                <Text testID="remote-screen-ice-error" class="mr-auto text-[12px] text-danger-text">{t().screen.macIceInvalid}</Text>
              </If>
              <Button size="sm" testID="remote-screen-ice-save" disabled={busy() || !iceDirty()} onPress={() => void saveIce()}>
                {t().screen.macIceSave}
              </Button>
            </View>
          </View>
        </If>
      </If>
    </View>
  );
}
