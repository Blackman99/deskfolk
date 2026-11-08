/** The code editor's word on unsaved edits follows the disk, whichever of text and disk text comes first. */
import { mount, signal } from "nsh";
import { expect, test } from "nsh/test";
import { ArtifactCodeEditor, type ArtifactEditorHandle } from "./ArtifactCodeEditor";

function setup() {
  const code = signal("a = 1\n");
  const disk = signal<string | null>("a = 1\n");
  const path = signal("a.py");
  const reports: boolean[] = [];
  let handle: ArtifactEditorHandle | null = null;
  const unmount = mount(() => (
    <ArtifactCodeEditor code={code()} baseline={disk()} path={path()} wrap={false} onDirty={(dirty) => reports.push(dirty)} handle={(h) => (handle = h)} />
  ));
  return { code, disk, path, reports, editor: () => handle!, unmount };
}

test("another file whose text lands before its disk text is not unsaved", () => {
  const { code, disk, path, reports, editor, unmount } = setup();
  // The loader's order: the text, then the disk text.
  path.set("b.py");
  code.set("b = 2\n");
  disk.set("b = 2\n");
  expect(editor().getValue()).toBe("b = 2\n");
  expect(editor().isDirty()).toBe(false);
  expect(reports.at(-1)).toBe(false);
  // The other order.
  path.set("c.py");
  disk.set("c = 3\n");
  code.set("c = 3\n");
  expect(editor().getValue()).toBe("c = 3\n");
  expect(editor().isDirty()).toBe(false);
  expect(reports.at(-1)).toBe(false);
  unmount();
});

test("the disk changing under an unchanged buffer leaves it unsaved, and a discard puts the disk's text in", () => {
  const { disk, reports, editor, unmount } = setup();
  disk.set("a = 9\n");
  expect(editor().isDirty()).toBe(true);
  expect(reports.at(-1)).toBe(true);
  editor().revert("a = 9\n");
  expect(editor().getValue()).toBe("a = 9\n");
  expect(editor().isDirty()).toBe(false);
  expect(reports.at(-1)).toBe(false);
  unmount();
});
