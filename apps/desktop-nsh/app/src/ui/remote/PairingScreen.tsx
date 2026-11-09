/**
 * The first screen a new phone sees (`remote/PairingScreen.svelte`): the Mac's pairing content is
 * pasted here, the host's fingerprint shows for the person to compare with the Mac's, and submitting
 * sends the device to the Mac and waits for someone there to confirm it. The shell shows it while
 * the hosted build is not connected and the device is not enrolled.
 *
 * A card in the middle of the page; on a phone (680 wide or less) the card is the page, its head
 * and body clear of the safe area. `origin` is the page's origin, the relay a compact code is read
 * against (`pairing-code.ts`); the page's own unless a story gives one.
 */
import { safeArea, Scroll, signal, Text, View, windowSize } from "nsh";
import { Input } from "nsh/base";
import { formatFingerprint } from "../../m/remote/fingerprint.ts";
import { previewPairing, type PairingProgress } from "../../m/remote/pairing.ts";
import { copy, runtime } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { narrowWindow } from "../Modal";
import { pageOrigin, pairingPayload } from "./pairing-code";

/** `.modal-dialog`'s shadow. */
const CARD_SHADOW = "0 24px 56px -12px rgba(18, 28, 32, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.05)";

export function PairingScreen(props: { origin?: string }) {
  const raw = signal("");
  const origin = () => props.origin ?? pageOrigin();
  const preview = (): PairingProgress => (raw().trim() ? previewPairing(pairingPayload(raw(), origin())) : runtime.pairing);
  const t = () => copy().remote;
  const phone = narrowWindow;
  const rejection = (): string | null => {
    const shown = preview();
    if (shown.phase !== "rejected") return null;
    return shown.reason === "url"
      ? t().pairUrl
      : shown.reason === "expired"
        ? t().pairExpired
        : shown.reason === "rejected"
          ? t().pairRejected
          : t().pairInvalid;
  };
  const confirm = () => {
    const shown = preview();
    return shown.phase === "confirm" ? shown : null;
  };
  const submit = async (): Promise<void> => {
    await runtime.submitPairing(pairingPayload(raw(), origin()));
  };
  const blocked = () => runtime.pairingBusy || !raw().trim();
  return (
    <View testID="pairing-screen" class={`flex-1 bg-bg ${phone() ? "items-stretch" : "items-center justify-center p-6"}`}>
      <View
        class={`flex-col bg-pane overflow-hidden ${phone() ? "flex-1" : "rounded-(--radius-xl) border border-line"}`}
        style={{ width: phone() ? undefined : Math.min(520, windowSize().width - 48), boxShadow: phone() ? undefined : CARD_SHADOW }}
      >
        <View
          class={`flex-row items-center gap-[10px] border-b border-line bg-pane ${phone() ? "px-4" : "px-5 py-[14px]"}`}
          style={phone() ? { height: 52 + safeArea().top, paddingTop: safeArea().top } : undefined}
        >
          <BrandMark size={28} />
          <Text role="header" class={`shrink text-[28px] font-bold leading-[1.5] text-ink ${phone() ? "" : "my-[19px]"}`}>
            {t().pairTitle}
          </Text>
        </View>
        <Scroll class={phone() ? "flex-1" : "shrink min-h-0"}>
          <View
            class={`flex-col gap-[14px] ${phone() ? "px-4 pt-4" : "px-5 py-[18px]"}`}
            style={phone() ? { paddingBottom: 20 + safeArea().bottom } : undefined}
          >
            <Text class="mb-2 text-[13px] leading-[1.5] text-ink-muted">{t().pairLead}</Text>
            <Text class="mb-2 text-[13px] leading-[1.5] text-ink-muted">{t().pairHint}</Text>
            <Text class="mt-3 mb-[6px] text-[14px] font-semibold text-ink">{t().pairPaste}</Text>
            <Input
              testID="pairing-qr"
              accessibilityLabel={t().pairPaste}
              multiline
              value={raw()}
              onChange={(e) => raw.set(e.value)}
              readonly={runtime.pairingBusy}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              class="w-full min-h-[128px] rounded-(--radius-md) border border-line bg-pane p-[10px] font-mono text-[12px] leading-[1.5] text-ink"
            />
            <If when={rejection()}>
              {(message) => (
                <Text testID="pairing-error" role="alert" class="mt-[5px] text-[12px] font-medium leading-[1.4] text-warn-text">
                  {message()}
                </Text>
              )}
            </If>
            <If when={confirm()}>
              {(shown) => (
                <View selectable class="flex-col gap-[14px]">
                  <Text testID="pairing-origin" class="mb-2 text-[13px] leading-[1.5] text-ink-muted">
                    {shown().relayOrigin}
                  </Text>
                  <Text testID="host-fingerprint" class="font-mono text-[12px] leading-[1.6] text-ink">
                    {formatFingerprint(shown().fingerprint)}
                  </Text>
                </View>
              )}
            </If>
            <If when={runtime.pairing.phase === "waiting"}>
              <Text testID="pairing-waiting" role="text" class="text-[14px] leading-[1.5] text-ink">
                {t().pairWaiting}
              </Text>
            </If>
          </View>
        </Scroll>
        <View class="flex-row justify-end px-5 pt-3 pb-[18px]">
          <View
            role="button"
            testID="pairing-submit"
            accessibilityLabel={runtime.pairingBusy ? t().pairWaiting : t().pairSubmit}
            accessibilityState={{ disabled: blocked(), busy: runtime.pairingBusy }}
            disabled={blocked()}
            onPress={() => void submit()}
            class="cursor-pointer select-none disabled:cursor-default min-h-[44px] items-center justify-center rounded-(--radius-md) bg-brand px-[14px] py-2"
          >
            <Text class="text-[14px] font-semibold text-on-accent">{runtime.pairingBusy ? t().pairWaiting : t().pairSubmit}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
