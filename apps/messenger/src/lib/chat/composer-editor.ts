export function insertComposerNewline(editor: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement("br");
  range.insertNode(br);
  const after = range.cloneRange();
  after.setStartAfter(br);
  after.setEnd(editor, editor.childNodes.length);
  // A trailing line break needs a second <br> to hold the caret on the empty line.
  if (!after.toString() && !after.cloneContents().querySelector("br")) {
    br.after(document.createElement("br"));
  }
  range.setStartAfter(br);
  range.setEndAfter(br);
  selection.removeAllRanges();
  selection.addRange(range);
}
