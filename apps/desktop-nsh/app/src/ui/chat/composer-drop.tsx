/**
 * Files from outside the app staged on a composer, a Bot's (`Composer`) or a project session's
 * (`ProjectComposer`), the same way for both: dropped from Finder on the conversation, copied in
 * Finder and pasted, or picked with the attach button. Any type goes out. What cannot (a folder, a
 * file over 512 MB, one the app cannot read) is said in a toast rather than left out without a word.
 * `DropVeil` is what the composer's card shows while files are dragged over the conversation.
 */
import { Picker, platform, Text, View } from "nsh";
import type { ComposerAttachments } from "../../m/chat/composer-attachments.svelte";
import { showToast } from "../../m/toast.svelte";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { DROPPED_FILE_MAX, filesFromUris, type UriFiles } from "./composer-state";

/** Reads what a drop or a Finder copy names (`file:` URLs) into files; a test or a story brings its own. */
export type ReadUris = (uris: readonly string[], mimeTypes?: readonly string[]) => Promise<UriFiles>;

/** A drop or a Finder copy: its files staged, what was left out said. */
export async function stageUris(files: ComposerAttachments, uris: readonly string[], mimeTypes?: readonly string[], read: ReadUris = filesFromUris): Promise<void> {
  if (uris.length === 0) return;
  const got = await read(uris, mimeTypes);
  if (got.files.length > 0) files.addFiles(got.files);
  sayLeftOut(got);
}

/** One toast for whatever was not staged; nothing when everything was. */
export function sayLeftOut(left: { folders?: string[]; tooLarge?: string[]; unreadable?: string[] }): void {
  const text = copy().composer.notAttached({ folders: left.folders ?? [], tooLarge: left.tooLarge ?? [], unreadable: left.unreadable ?? [] });
  if (text) showToast(text, { tone: "error" });
}

/**
 * The attach button. On a desktop the system's open dialog, which takes a file of any type; on a
 * phone the photo picker as before, which opens the gallery and the camera.
 */
export async function pickInto(files: ComposerAttachments): Promise<void> {
  try {
    if (platform.desktop) {
      const picked = await Picker.pickFiles({ multiple: true, maxSize: DROPPED_FILE_MAX });
      const read = picked.flatMap((row) => (row.file ? [row.file] : []));
      if (read.length > 0) files.addFiles(read);
      sayLeftOut({ tooLarge: picked.filter((row) => !row.file).map((row) => row.name) });
      return;
    }
    const picked = await Picker.pickImages({ multiple: true });
    if (picked.length > 0) files.addFiles(picked.map((row) => row.file));
  } catch {
    // The picker was refused or is not here: nothing to stage.
  }
}

/** Over the composer's card while files are dragged over the conversation: where they go. */
export function DropVeil(props: { shown: boolean; testID: string }) {
  return (
    <If when={props.shown}>
      <View
        testID={props.testID}
        accessible={false}
        class="absolute left-0 top-0 right-0 bottom-0 flex-row items-center justify-center gap-2 rounded-(--radius-xl) border-2 border-dashed border-brand bg-input-bg"
        style={{ pointerEvents: "none" }}
      >
        <Icon name="paperclip" size={16} class="tint-brand" />
        <Text class="text-[14px] font-medium text-brand">{copy().composer.dropFiles}</Text>
      </View>
    </If>
  );
}
