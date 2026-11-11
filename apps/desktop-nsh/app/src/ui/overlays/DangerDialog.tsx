/**
 * The confirmation before a loss (`overlays/DangerDialog.svelte`): what will go, a way back and the
 * button that does it. An optional box (`copy.option`, "delete its files too") the caller keeps.
 * While `busy` the button says `copy.busy` and turns, and nothing closes the dialog: deleting a
 * group can take seconds, and the wait must not look like a press that did nothing.
 */
import { Text } from "nsh";
import { Checkbox } from "../Checkbox";
import { copy as appCopy } from "../../runtime";
import { Modal, ModalAction, narrowWindow } from "../Modal";

export type DangerCopy = { title: string; body: string; confirm: string; cancel: string; option?: string; busy?: string };

export function DangerDialog(props: {
  copy: DangerCopy;
  onDismiss: () => void;
  onConfirm: () => void;
  busy?: boolean;
  /** Whether the `option` box is ticked; the caller keeps it, so confirming reads it there. */
  optionChecked?: boolean;
  onOptionChange?: (checked: boolean) => void;
  testID?: string;
}) {
  return (
    <Modal
      alert
      title={props.copy.title}
      closeLabel={appCopy().common.close}
      onClose={props.onDismiss}
      busy={props.busy}
      width={380}
      testID={props.testID ?? "danger-dialog"}
      foot={
        <>
          <ModalAction testID="danger-cancel" disabled={props.busy} onPress={props.onDismiss}>
            {props.copy.cancel}
          </ModalAction>
          <ModalAction kind="deny" testID="danger-confirm" busy={props.busy} onPress={props.onConfirm}>
            {props.busy ? (props.copy.busy ?? props.copy.confirm) : props.copy.confirm}
          </ModalAction>
        </>
      }
    >
      <Text class="text-[14px] leading-[1.55] text-ink-secondary">{props.copy.body}</Text>
      <If when={props.copy.option}>
        {(option: () => string) => (
          <Checkbox
            testID="danger-option"
            label={option()}
            checked={props.optionChecked === true}
            disabled={props.busy}
            onChange={(checked) => props.onOptionChange?.(checked)}
            class={narrowWindow() ? "min-h-[44px] -my-3" : ""}
          />
        )}
      </If>
    </Modal>
  );
}
