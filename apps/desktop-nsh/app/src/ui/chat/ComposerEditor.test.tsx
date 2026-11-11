/** The message box lets go of what the engine holds for it. */
import { mount } from "nsh";
import { RichEditorPlugin } from "nsh/base";
import { expect, test } from "nsh/test";
import { ComposerEditor } from "./ComposerEditor";

test("unmounting the box frees the plugins whose captured keys the engine keeps", () => {
  const proto = RichEditorPlugin.prototype as unknown as { dispose(this: RichEditorPlugin): void };
  const original = proto.dispose;
  let freed = 0;
  proto.dispose = function (this: RichEditorPlugin) {
    freed += 1;
    original.call(this);
  };
  try {
    const unmount = mount(() => <ComposerEditor value="" onChange={() => {}} placeholder="" editable onSend={() => {}} />);
    expect(freed).toBe(0);
    unmount();
    expect(freed).toBe(6);
  } finally {
    proto.dispose = original;
  }
});
