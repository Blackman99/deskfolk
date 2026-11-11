/**
 * What to do with unsaved edits when the file is left (`ArtifactDirtyDialog.svelte`): cancel (stay),
 * discard, or save. A confirmation on the shared `Modal` frame; while `saving` nothing in it presses.
 */
import { Text } from "nsh";
import { copy } from "../../runtime";
import { Modal, ModalAction } from "../Modal";

export function ArtifactDirtyDialog(props: {
  saving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void | Promise<void>;
}) {
  return (
    <Modal
      testID="artifact-dirty-dialog"
      alert
      title={copy().stream.artifactDirtyTitle}
      closeLabel={copy().common.close}
      width={420}
      busy={props.saving}
      onClose={props.onCancel}
      foot={
        <>
          <ModalAction testID="artifact-dirty-cancel" kind="secondary" disabled={props.saving} onPress={props.onCancel}>
            {copy().sidebar.cancel}
          </ModalAction>
          <ModalAction testID="artifact-dirty-discard" kind="secondary" disabled={props.saving} onPress={props.onDiscard}>
            {copy().stream.artifactDiscard}
          </ModalAction>
          <ModalAction testID="artifact-dirty-save" kind="primary" disabled={props.saving} onPress={() => void props.onSave()}>
            {copy().stream.artifactSave}
          </ModalAction>
        </>
      }
    >
      <Text class="text-[14px] text-ink-muted leading-[1.5]">{copy().stream.artifactDirtyBody}</Text>
    </Modal>
  );
}
