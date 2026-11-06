/**
 * The confirmation before the independent runtime is switched on or off
 * (`settings/IndependentConfirm.svelte`), built on `Modal`. It shows while the settings are open
 * and a change is awaiting confirmation. While the runtime drains the live turns it says so and
 * offers to keep waiting, to force the handover or to cancel; a press on the scrim or ✕ cancels
 * unless it is draining (then the dialog is held open).
 *
 * Props (the Svelte ones less `runtime` and `t`): `independent` (the status); `independentConfirm`
 * ("enable" | "disable" | null: null hides it); `independentReason(status)` (the error's words);
 * `confirmIndependent`, `waitIndependent`, `forceIndependent`, `cancelIndependent` (async actions).
 * Test ids: `independent-confirm`, `independent-waiting`, `independent-error`,
 * `independent-confirm-go`, `independent-wait`, `independent-force`, `independent-cancel`.
 */
import { Text } from "nsh";
import { copy, runtime } from "../../runtime";
import type { IndependentStatus } from "../../m/settings/independent-runtime.ts";
import { Modal, ModalAction } from "../Modal";

export function IndependentConfirm(props: {
  independent: IndependentStatus;
  independentConfirm: "enable" | "disable" | null;
  independentReason: (status: IndependentStatus) => string;
  confirmIndependent: () => Promise<void>;
  waitIndependent: () => Promise<void>;
  forceIndependent: () => Promise<void>;
  cancelIndependent: () => Promise<void>;
}) {
  const draining = () => props.independent.drain.phase === "draining";
  const s = () => copy().settings;
  return (
    <If when={runtime.settingsOpen && props.independentConfirm}>
      <Modal
        alert
        testID="independent-confirm"
        title={props.independentConfirm === "enable" ? s().independentRuntimeConfirmEnable : s().independentRuntimeConfirmDisable}
        closeLabel={copy().common.close}
        onClose={() => void props.cancelIndependent()}
        busy={draining()}
        width={380}
        foot={
          <If
            when={draining()}
            else={
              <>
                <ModalAction testID="independent-cancel" onPress={() => void props.cancelIndependent()}>
                  {s().independentRuntimeCancel}
                </ModalAction>
                <ModalAction kind="deny" testID="independent-confirm-go" onPress={() => void props.confirmIndependent()}>
                  {s().independentRuntimeConfirm}
                </ModalAction>
              </>
            }
          >
            <ModalAction testID="independent-wait" onPress={() => void props.waitIndependent()}>
              {s().independentRuntimeWaiting}
            </ModalAction>
            <ModalAction kind="deny" testID="independent-force" onPress={() => void props.forceIndependent()}>
              {s().independentRuntimeForce}
            </ModalAction>
            <ModalAction testID="independent-cancel" onPress={() => void props.cancelIndependent()}>
              {s().independentRuntimeCancel}
            </ModalAction>
          </If>
        }
      >
        <Text class="text-[14px] leading-[1.55] text-ink-secondary">
          {props.independentConfirm === "enable" ? s().independentRuntimeConfirmEnableBody : s().independentRuntimeConfirmDisableBody}
        </Text>
        <If when={draining()}>
          <Text testID="independent-waiting" class="text-[14px] leading-[1.55] text-ink-secondary">
            {s().independentRuntimeWaiting}
          </Text>
        </If>
        <If when={props.independent.error}>
          <Text testID="independent-error" class="text-[14px] leading-[1.55] text-ink-secondary">
            {props.independentReason(props.independent)}
          </Text>
        </If>
      </Modal>
    </If>
  );
}
