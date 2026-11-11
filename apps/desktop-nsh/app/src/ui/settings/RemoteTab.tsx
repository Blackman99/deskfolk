/**
 * Settings › Remote access (`settings/RemoteTab.svelte`): this Mac's state with the relay, the
 * relay connect form (before it is registered), pairing a phone (the pasted code and both
 * fingerprints, then the approval), the paired devices, and the Mac's remote screen. In a paired
 * device's own window it shows the remote session settings instead.
 *
 * There is no QR code on this page: the Mac shows a pairing code to paste (the phone scans or
 * pastes it on its side), exactly as the Svelte card does.
 *
 * Props: `locale`; `relativeTimeNow` (the clock the "last active" words are measured against);
 * `pairingCopied` / `onPairingCopiedChange` (the copied mark belongs to the modal, so it outlives a
 * tab switch); `relayForm` / `onRelayFormChange` (the same, for the connect form); `relayInvalid`
 * (the field the last submit refused); `connectRelay` (submits the form).
 */
import { Clipboard, Text, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { copy, runtime } from "../../runtime";
import { formatFingerprint } from "../../m/remote/fingerprint.ts";
import type { HostRelayField } from "../../m/remote/pairing-host.ts";
import { Button } from "../Button";
import { SettingsCard } from "./SettingsCard";
import { SettingsCardHeader } from "./SettingsCardHeader";
import { formatDeviceLastActive } from "../../m/settings/device-last-active.ts";
import { RelayGuide } from "./RelayGuide";
import { RemoteScreenSettings } from "./RemoteScreenSettings";
import { RemoteSessionSettings } from "./RemoteSessionSettings";

type RelayForm = { origin: string; relayId: string; bootstrap: string };

const BADGE = {
  ok: "bg-ok-bg border-ok-line",
  neutral: "bg-chip border-line",
  warn: "bg-warn-bg border-warn-line",
} as const;
const BADGE_INK = { ok: "text-ok-text", neutral: "text-ink-secondary", warn: "text-warn-text" } as const;

const FIELD = "w-full px-[10px] py-[7px] border border-line rounded-(--radius-md) bg-input-bg text-ink font-mono text-[13px] focus:border-field-focus-border";
const PANEL = "flex-col gap-3 px-[14px] py-3 border border-dashed border-line rounded-(--radius-md) bg-sidebar-bg";

function FieldError(props: { testID?: string; children: string }) {
  return <Text testID={props.testID} role="alert" class="text-[12px] text-danger-text">{props.children}</Text>;
}

/** One numbered step of the pairing sequence. */
function Step(props: { n: number; children?: JSX.Element }) {
  return (
    <View class="flex-col gap-[6px] pl-[26px] relative">
      <View class="absolute left-0 top-px w-[18px] h-[18px] rounded-full border border-line bg-pane items-center justify-center">
        <Text class="text-[11px] font-semibold text-ink-secondary">{String(props.n)}</Text>
      </View>
      {props.children}
    </View>
  );
}

export function RemoteTab(props: {
  locale: "zh" | "en";
  relativeTimeNow: number;
  pairingCopied: boolean;
  onPairingCopiedChange: (copied: boolean) => void;
  relayForm: RelayForm;
  onRelayFormChange: (form: RelayForm) => void;
  relayInvalid: HostRelayField | null;
  connectRelay: () => Promise<void>;
}) {
  const t = () => copy();
  const status = () => runtime.remoteStatus;
  /** Before this Mac is registered with a relay there is nothing to pair; the card asks for one. */
  const relayConnectable = () => !runtime.remote && status()?.state === "off" && !status()?.diagnostic;

  function relaySetupMessage(code: string): string {
    if (code === "relay_bootstrap") return t().remote.hostConnectRefused;
    if (code === "relay_unreachable") return t().remote.hostConnectUnreachable;
    if (code === "desktop_channel_unavailable") return t().remote.setupChannelLost;
    return t().remote.hostConnectFailed;
  }

  /** The badge carries the state; the sentence under it only appears when the state needs explaining. */
  const remoteState = () => status()?.state ?? "off";
  const remoteLabel = () => {
    const state = remoteState();
    if (state === "online") return t().remote.statusOnline;
    if (state === "connecting") return t().remote.statusConnecting;
    if (state === "native_unavailable") return t().remote.statusUnavailable;
    if (state === "activation_gated") return t().remote.statusGated;
    if (state === "trust_mismatch") return t().remote.statusMismatch;
    if (state === "disconnected") return t().remote.statusDisconnected;
    return t().remote.statusOff;
  };
  const remoteTone = (): keyof typeof BADGE => {
    const state = remoteState();
    return state === "online" ? "ok" : state === "connecting" || state === "off" ? "neutral" : "warn";
  };
  const remoteExplains = () => (remoteState() === "online" || remoteState() === "off" ? "" : t().remote.experimental);
  /** Why the card offers no connect form when the runtime, not the relay, is what stands in the way. */
  const remoteSetupNote = () => {
    if (runtime.remote) return "";
    const diagnostic = status()?.diagnostic;
    if (diagnostic === "sealed_runtime_required") return t().remote.setupNeedsDevSwitch;
    if (diagnostic === "platform_unsupported") return t().remote.setupNotOnLinux;
    return "";
  };

  const setForm = (patch: Partial<RelayForm>) => props.onRelayFormChange({ ...props.relayForm, ...patch });
  const canConnect = () =>
    !runtime.hostSetupBusy && !!props.relayForm.origin.trim() && !!props.relayForm.relayId.trim() && !!props.relayForm.bootstrap.trim();
  const submit = () => {
    if (canConnect()) void props.connectRelay();
  };

  const pairing = () => runtime.hostPairing;
  const offered = () => {
    const p = pairing();
    return p && (p.phase === "offer" || p.phase === "confirm") ? p : null;
  };
  const pairingCode = () => {
    const p = pairing();
    return p && "code" in p ? p.code : "";
  };

  return (
    <View class="flex-col gap-[14px]">
      <SettingsCard testID="settings-card-remote">
        <SettingsCardHeader
          title={t().settings.remoteSection}
          subtitle={runtime.remote ? t().settings.remoteSubtitle : t().settings.remoteSubtitleHost}
          after={
            <View class={`px-2 py-[2px] rounded-full border shrink-0 ${BADGE[remoteTone()]}`}>
              <Text testID="remote-state" class={`text-[11px] font-semibold ${BADGE_INK[remoteTone()]}`}>{remoteLabel()}</Text>
            </View>
          }
        />
        <If when={remoteExplains()}>
          <Text class="text-[12px] leading-[1.45] text-ink-muted">{remoteExplains()}</Text>
        </If>
        <If when={remoteSetupNote()}>
          <Text testID="remote-setup-note" class="text-[12px] leading-[1.45] text-ink-muted">{remoteSetupNote()}</Text>
        </If>

        <If when={relayConnectable()}>
          <View testID="remote-connect" class={PANEL}>
            <Text class="text-[13px] text-ink-secondary">{t().remote.hostConnectIntro}</Text>
            <RelayGuide locale={props.locale} />
            <View class="flex-col gap-[10px]">
              <View class="flex-col gap-[6px]">
                <Text class="text-[13px] font-semibold text-ink-secondary">{t().remote.hostConnectOrigin}</Text>
                <Input
                  testID="relay-connect-origin"
                  accessibilityLabel={t().remote.hostConnectOrigin}
                  value={props.relayForm.origin}
                  placeholder="https://relay.example.com"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  readonly={runtime.hostSetupBusy}
                  onChange={(e) => setForm({ origin: e.value })}
                  onSubmit={submit}
                  class={`${FIELD} ${props.relayInvalid === "origin" ? "border-danger-line" : ""}`}
                />
                <If when={props.relayInvalid === "origin"}>
                  <FieldError testID="relay-connect-origin-error">{t().remote.hostConnectInvalidOrigin}</FieldError>
                </If>
              </View>
              <View class="flex-col gap-[6px]">
                <Text class="text-[13px] font-semibold text-ink-secondary">{t().remote.hostConnectRelayId}</Text>
                <Input
                  testID="relay-connect-id"
                  accessibilityLabel={t().remote.hostConnectRelayId}
                  value={props.relayForm.relayId}
                  autoCapitalize="none"
                  autoCorrect={false}
                  readonly={runtime.hostSetupBusy}
                  onChange={(e) => setForm({ relayId: e.value })}
                  onSubmit={submit}
                  class={`${FIELD} ${props.relayInvalid === "relayId" ? "border-danger-line" : ""}`}
                />
                <If when={props.relayInvalid === "relayId"}>
                  <FieldError testID="relay-connect-id-error">{t().remote.hostConnectInvalidRelayId}</FieldError>
                </If>
              </View>
              <View class="flex-col gap-[6px]">
                <Text class="text-[13px] font-semibold text-ink-secondary">{t().remote.hostConnectToken}</Text>
                <Input
                  testID="relay-connect-token"
                  accessibilityLabel={t().remote.hostConnectToken}
                  value={props.relayForm.bootstrap}
                  masked
                  autoCapitalize="none"
                  autoCorrect={false}
                  readonly={runtime.hostSetupBusy}
                  onChange={(e) => setForm({ bootstrap: e.value })}
                  onSubmit={submit}
                  class={`${FIELD} ${props.relayInvalid === "bootstrap" ? "border-danger-line" : ""}`}
                />
                <If
                  when={props.relayInvalid === "bootstrap"}
                  else={<Text class="text-[12px] text-ink-muted">{t().remote.hostConnectTokenHint}</Text>}
                >
                  <FieldError testID="relay-connect-token-error">{t().remote.hostConnectInvalidToken}</FieldError>
                </If>
              </View>
            </View>
            <If when={runtime.hostSetupError}>
              <FieldError testID="remote-connect-error">{relaySetupMessage(runtime.hostSetupError ?? "")}</FieldError>
            </If>
            <View class="flex-row">
              <Button variant="primary" testID="remote-connect-submit" disabled={!canConnect()} onPress={submit}>{t().remote.hostConnect}</Button>
            </View>
          </View>
        </If>

        <If
          when={!runtime.remote && status()?.state === "online"}
          else={
            <If when={status() && !runtime.remote && !relayConnectable() && !remoteSetupNote()}>
              <Text class="text-[12px] leading-[1.45] text-ink-muted">{t().remote.devices(status()?.devices ?? 0)}</Text>
            </If>
          }
        >
          <View testID="remote-pairing" class="flex-col gap-[10px]">
            <If
              when={pairing()}
              else={
                <View class="flex-row flex-wrap items-center justify-between gap-3 px-[14px] py-3 border border-dashed border-line rounded-(--radius-md) bg-sidebar-bg">
                  <Text class="shrink text-[13px] text-ink-secondary">
                    {status()?.devices === 0 ? t().remote.hostPairEmpty : t().remote.devices(status()?.devices ?? 0)}
                  </Text>
                  <Button
                    variant={(status()?.devices ?? 0) > 0 ? "secondary" : "primary"}
                    testID="pairing-start"
                    disabled={runtime.hostPairingBusy}
                    onPress={() => void runtime.startHostPairing()}
                  >
                    {t().remote.hostPair}
                  </Button>
                </View>
              }
            >
              <If when={pairing()?.phase === "offer" || pairing()?.phase === "confirm"}>
                <View class="flex-col gap-[10px]">
                  <View testID="pairing-steps" class="flex-col gap-[14px] px-4 py-[14px] border border-line rounded-(--radius-md) bg-sidebar-bg">
                    <Step n={1}>
                      <Text class="text-[13px] leading-[1.5] text-ink">{t().remote.hostPairPaste}</Text>
                      <View class="flex-row flex-wrap items-start gap-2">
                        <View class="grow shrink min-w-[200px] px-[10px] py-2 border border-line rounded-(--radius-sm) bg-input-bg">
                          <Text testID="pairing-code" class="font-mono text-[11px] leading-[1.5] text-ink-secondary">{pairingCode()}</Text>
                        </View>
                        <Button
                          size="sm"
                          testID="pairing-copy"
                          onPress={() => {
                            void Clipboard.writeText(pairingCode()).catch(() => {});
                            props.onPairingCopiedChange(true);
                          }}
                        >
                          {props.pairingCopied ? t().chat.copied : t().chat.copyMessage}
                        </Button>
                      </View>
                    </Step>
                    <Step n={2}>
                      <Text class="text-[13px] leading-[1.5] text-ink">{t().remote.hostPairFingerprint}</Text>
                      <Text testID="pairing-fingerprint" class="font-mono text-[12px] leading-[1.6] text-ink">
                        {formatFingerprint(offered()?.fingerprint ?? "")}
                      </Text>
                    </Step>
                    <Step n={3}>
                      <If
                        when={pairing()?.phase === "confirm"}
                        else={<Text testID="pairing-waiting" class="text-[13px] leading-[1.5] text-ink-secondary">{t().remote.hostPairWaiting}</Text>}
                      >
                        {(() => {
                          const arrived = () => {
                            const p = pairing();
                            return p?.phase === "confirm" ? p : null;
                          };
                          return (
                            <View class="flex-col gap-[6px]">
                              <Text testID="pairing-arrived" class="text-[13px] leading-[1.5] text-ink">{t().remote.hostPairArrived(arrived()?.name ?? "")}</Text>
                              <Text testID="pairing-device-fingerprint" class="font-mono text-[12px] leading-[1.6] text-ink">
                                {formatFingerprint(arrived()?.deviceFingerprint ?? "")}
                              </Text>
                              <Text class="text-[12px] text-ink-secondary">{t().remote.hostPairCompare}</Text>
                              <If when={arrived()?.note === "hello_not_configured"}>
                                <FieldError testID="pairing-needs-hello">{t().remote.confirmNeedsHello}</FieldError>
                              </If>
                              <View class="flex-row flex-wrap items-center gap-2 mt-[2px]">
                                <Button variant="primary" testID="pairing-confirm" disabled={runtime.hostPairingBusy} onPress={() => void runtime.confirmHostPairing()}>
                                  {t().remote.hostPairApprove}
                                </Button>
                                <Button size="sm" testID="pairing-cancel-confirm" disabled={runtime.hostPairingBusy} onPress={() => runtime.closeHostPairing()}>
                                  {t().sidebar.cancel}
                                </Button>
                              </View>
                            </View>
                          );
                        })()}
                      </If>
                    </Step>
                  </View>
                  <If when={pairing()?.phase === "offer"}>
                    <View class="flex-row">
                      <Button size="sm" testID="pairing-dismiss" disabled={runtime.hostPairingBusy} onPress={() => runtime.closeHostPairing()}>
                        {t().sidebar.cancel}
                      </Button>
                    </View>
                  </If>
                </View>
              </If>
              <If when={pairing()?.phase === "paired"}>
                <View class="flex-col items-start gap-[10px]">
                  <Text testID="pairing-done" class="text-[13px] text-ok-text">{t().remote.hostPairDone}</Text>
                  <Button size="sm" testID="pairing-close" onPress={() => runtime.closeHostPairing()}>{t().common.close}</Button>
                </View>
              </If>
              <If when={pairing()?.phase === "failed"}>
                <View role="alert" testID="pairing-failed" class="flex-col gap-[10px] px-[14px] py-3 border border-warn-line rounded-(--radius-md) bg-warn-bg">
                  <Text class="text-[13px] text-warn-text">
                    {(() => {
                      const p = pairing();
                      const error = p?.phase === "failed" ? p.error : "";
                      return error === "expired" ? t().remote.hostPairExpired : error === "desktop_channel_unavailable" ? t().remote.setupChannelLost : t().remote.hostPairFailed;
                    })()}
                  </Text>
                  <View class="flex-row items-center gap-2">
                    <Button variant="primary" testID="pairing-retry" disabled={runtime.hostPairingBusy} onPress={() => void runtime.startHostPairing()}>
                      {t().remote.hostPairRetry}
                    </Button>
                    <Button size="sm" testID="pairing-failed-close" onPress={() => runtime.closeHostPairing()}>{t().common.close}</Button>
                  </View>
                </View>
              </If>
            </If>
          </View>

          <View testID="host-devices" class="flex-col gap-[9px]">
            <View class="flex-row items-center justify-between gap-3">
              <Text role="header" class="text-[14px] font-semibold text-ink">{t().remote.connectedDevices}</Text>
              <Button size="sm" testID="host-devices-refresh" disabled={runtime.hostDevicesBusy} onPress={() => void runtime.refreshHostDevices()}>
                {t().remote.refreshStatus}
              </Button>
            </View>
            <If when={runtime.hostDevicesError}>
              <FieldError testID="host-devices-error">
                {runtime.hostDevicesError === "hello_not_configured" ? t().remote.confirmNeedsHello : t().remote.deviceActionFailed}
              </FieldError>
            </If>
            <If
              when={runtime.hostDevices.length > 0}
              else={<Text class="text-[12px] leading-[1.45] text-ink-muted">{t().remote.connectedDevicesEmpty}</Text>}
            >
              <View class="flex-col gap-2">
                {/* `.slice()`: Each does not render a `state()` array proxy as it is. */}
                {/* `.slice()`: Each does not render a `state()` array proxy as it is. */}
                <Each of={runtime.hostDevices.slice()} key={(device) => device.id}>
                  {(device) => (
                    <View testID={`host-device-${device().id}`} class="flex-row flex-wrap items-center justify-between gap-3 px-3 py-[11px] border border-line rounded-(--radius-md) bg-sidebar-bg">
                      <View class="flex-col gap-[2px] min-w-0 shrink">
                        <Text class="text-[13px] font-bold text-ink">{device().name}</Text>
                        <Text class="text-[12px] text-ink-muted">
                          {device().lastActiveAt
                            ? t().remote.lastActive(formatDeviceLastActive(device().lastActiveAt!, props.relativeTimeNow, props.locale))
                            : t().remote.lastActiveUnknown}
                        </Text>
                      </View>
                      <View class="flex-row flex-wrap items-center justify-end gap-[6px]">
                        <Button
                          size="sm"
                          testID={`host-remove-${device().id}`}
                          disabled={runtime.hostDevicesBusy}
                          onPress={() => { runtime.hostRemoveDeviceId = device().id; }}
                        >
                          {t().remote.removeDevice}
                        </Button>
                        <If when={runtime.hostRemoveDeviceId === device().id}>
                          <Button
                            size="sm"
                            variant="danger"
                            testID={`host-remove-confirm-${device().id}`}
                            disabled={runtime.hostDevicesBusy}
                            onPress={() => void runtime.removeHostDevice(device().id)}
                          >
                            {t().remote.removeDeviceConfirm(device().name)}
                          </Button>
                        </If>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </View>
          <If when={runtime.client?.kind === "local"}>
            <RemoteScreenSettings api={runtime.client as never} />
          </If>
        </If>

        <Text testID="remote-footnote" class="text-[12px] text-ink-secondary opacity-[0.85]">{t().remote.noOfflineQueue}</Text>
        <If when={runtime.remote}>
          <RemoteSessionSettings />
        </If>
      </SettingsCard>
    </View>
  );
}
