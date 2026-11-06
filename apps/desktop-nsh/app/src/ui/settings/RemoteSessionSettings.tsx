/**
 * The remote session's part of the remote card (`settings/RemoteSessionSettings.svelte`), shown
 * when this window is a paired device: its unlock key, the runtime's maintenance (version, mode,
 * restart, diagnostics, stop, drain), the other paired devices and the push switch. Everything is
 * the runtime's: `uvReady`, `maintenance`, `maintenanceError`, `pushEnabled`, `pushPermission` and
 * the actions that change them.
 *
 * The phone-only parts (`uvRegister` is WebAuthn, push is a service worker) show what the runtime
 * reports; a native window never has `runtime.remote` true, so this is reached from the web build.
 */
import { Text, View } from "nsh";
import { copy, runtime } from "../../runtime";
import { Button } from "../Button";
import { Switch } from "../Switch";
import { SettingsRow } from "./SettingsRow";

const Muted = (props: { testID?: string; children: string }) => (
  <Text testID={props.testID} class="text-[12px] leading-[1.45] text-ink-muted">{props.children}</Text>
);

export function RemoteSessionSettings() {
  const t = () => copy();
  const maintenanceError = () => {
    const code = runtime.maintenanceError;
    if (code === "draining") return t().remote.errorDraining;
    if (code === "restart_unavailable") return t().remote.errorUnavailable;
    if (code === "cancelled") return t().remote.errorCancelled;
    if (code === "request_unknown") return t().remote.errorUnknown;
    return t().remote.errorUv;
  };
  const restartOff = () => runtime.maintenanceBusy || !runtime.uvReady || runtime.maintenance?.restart !== "available";
  return (
    <View class="flex-col gap-2">
      <Muted>{t().remote.uvNeeded}</Muted>
      <If when={runtime.uvError}>
        <Text class="text-[12px] text-danger-text">{t().remote.uvFailed}</Text>
      </If>
      <If when={!runtime.uvReady}>
        <View class="flex-row">
          <Button size="sm" testID="remote-uv-register" onPress={() => void runtime.registerUv()}>{t().remote.uvRegister}</Button>
        </View>
      </If>
      <View testID="remote-maintenance" class="flex-col gap-2">
        <Text role="header" class="text-[14px] font-semibold text-ink">{t().remote.maintenance}</Text>
        <Muted>{t().remote.maintenanceLead}</Muted>
        <If when={runtime.maintenance}>
          {(maintenance) => (
            <View class="flex-col gap-1">
              <Text testID="remote-version" class="text-[13px] text-ink">{t().remote.version(maintenance().version)}</Text>
              <Text testID="remote-mode" class="text-[13px] text-ink">
                {maintenance().mode === "window" ? t().remote.modeWindow : maintenance().mode === "standalone" ? t().remote.modeStandalone : t().remote.modeNone}
              </Text>
              <Text testID="remote-restart" class="text-[13px] text-ink">
                {maintenance().restart === "available" ? t().remote.restartAvailable : t().remote.restartUnavailable}
              </Text>
              <Text testID="remote-drain" class="text-[13px] text-ink">
                {maintenance().drain.phase === "draining"
                  ? t().remote.drainWaiting(maintenance().drain.remaining)
                  : maintenance().drain.phase === "drained"
                    ? maintenance().drain.forced
                      ? t().remote.drainForced
                      : t().remote.drainDrained
                    : t().remote.drainRunning}
              </Text>
            </View>
          )}
        </If>
        <Muted>{t().remote.reconnectHint}</Muted>
        <If when={runtime.maintenanceError}>
          <Text testID="remote-maintenance-error" class="text-[12px] text-danger-text">{maintenanceError()}</Text>
        </If>
        <View class="flex-row flex-wrap gap-2">
          <Button size="sm" testID="remote-refresh" onPress={() => void runtime.refreshMaintenance()}>{t().remote.refreshStatus}</Button>
          <Button size="sm" testID="remote-diagnostics" disabled={runtime.maintenanceBusy || !runtime.uvReady} onPress={() => void runtime.downloadDiagnostics()}>
            {t().remote.downloadDiagnostics}
          </Button>
          <Button size="sm" testID="remote-drain-restart" disabled={restartOff()} onPress={() => void runtime.restartRuntime(false)}>
            {t().remote.drainRestart}
          </Button>
          <Button size="sm" testID="remote-force-restart" disabled={restartOff()} onPress={() => { runtime.maintenanceForceConfirm = true; }}>
            {t().remote.forceRestart}
          </Button>
          <Button size="sm" testID="remote-stop" disabled={runtime.maintenanceBusy || !runtime.uvReady} onPress={() => { runtime.maintenanceStopConfirm = true; }}>
            {t().remote.stopRuntime}
          </Button>
        </View>
        <If when={runtime.maintenanceForceConfirm}>
          <View class="flex-col items-start gap-2">
            <Text class="text-[12px] text-danger-text">{t().remote.forceWarn}</Text>
            <View class="flex-row gap-2">
              <Button size="sm" variant="danger" testID="remote-force-confirm" onPress={() => void runtime.restartRuntime(true)}>{t().remote.forceConfirm}</Button>
              <Button size="sm" variant="ghost" testID="remote-force-cancel" onPress={() => { runtime.maintenanceForceConfirm = false; }}>{t().common.close}</Button>
            </View>
          </View>
        </If>
        <If when={runtime.maintenanceStopConfirm}>
          <View class="flex-col items-start gap-2">
            <Text class="text-[12px] text-danger-text">{t().remote.stopWarn}</Text>
            <View class="flex-row gap-2">
              <Button size="sm" variant="danger" testID="remote-stop-confirm" onPress={() => void runtime.stopRuntime()}>{t().remote.stopConfirm}</Button>
              <Button size="sm" variant="ghost" testID="remote-stop-cancel" onPress={() => { runtime.maintenanceStopConfirm = false; }}>{t().common.close}</Button>
            </View>
          </View>
        </If>
        <Muted>{t().remote.revokeOther}</Muted>
        <If when={runtime.otherRemoteDevices().length > 0} else={<Muted>{t().remote.noOtherDevices}</Muted>}>
          <View class="flex-col gap-2">
            <Each of={runtime.otherRemoteDevices().slice()} key={(device) => device.id}>
              {(device) => (
                <View class="flex-row flex-wrap items-center justify-between gap-3 px-3 py-[11px] border border-line rounded-(--radius-md) bg-sidebar-bg">
                  <Text class="text-[13px] text-ink">{device().name}</Text>
                  <View class="flex-row flex-wrap items-center gap-[6px]">
                    <Button
                      size="sm"
                      testID={`remote-revoke-${device().id}`}
                      disabled={runtime.maintenanceBusy || !runtime.uvReady}
                      onPress={() => { runtime.maintenanceRevokeId = device().id; }}
                    >
                      {t().remote.revokeOther}
                    </Button>
                    <If when={runtime.maintenanceRevokeId === device().id}>
                      <Button size="sm" variant="danger" testID={`remote-revoke-confirm-${device().id}`} onPress={() => void runtime.revokeRemoteDevice(device().id)}>
                        {t().remote.revokeConfirm(device().name)}
                      </Button>
                    </If>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </If>
      </View>
      <SettingsRow title={t().remote.push} titleId="push-setting-label" desc={t().remote.pushDesc} last>
        <Switch
          testID="remote-push-toggle"
          label={t().remote.push}
          checked={runtime.pushEnabled}
          disabled={runtime.pushBusy || runtime.pushPermission === "unsupported"}
          onChange={(enabled) => void runtime.setPushEnabled(enabled)}
        />
      </SettingsRow>
      <If when={runtime.pushPermission === "denied"}>
        <Muted>{t().remote.pushDenied}</Muted>
      </If>
      <If when={runtime.pushPermission === "unsupported"}>
        <Muted>{t().remote.pushUnsupported}</Muted>
      </If>
      <If when={runtime.pushError === "failed"}>
        <Text class="text-[12px] text-danger-text">
          {runtime.pushErrorCode ? `${t().remote.pushFailed} ${runtime.pushErrorCode}` : t().remote.pushFailed}
        </Text>
      </If>
    </View>
  );
}
