/** Where the native Office module reads a file from: the runtime on this computer, else the bytes. */
import { expect, test } from "nsh/test";
import { officeSourceOf } from "./office-model";

test("a workspace file and an attachment are fetched by the module on a local runtime", () => {
  expect(officeSourceOf({ relpath: "work/a.xlsx", byteSource: "workspace", attachmentId: null, local: true })).toEqual({ path: "work/a.xlsx" });
  expect(officeSourceOf({ relpath: "inbox/a.docx", byteSource: "attachment", attachmentId: "01ATT", local: true })).toEqual({ attachmentId: "01ATT" });
});

test("a remote runtime, or no file, hands the viewer the bytes", () => {
  expect(officeSourceOf({ relpath: "work/a.xlsx", byteSource: "workspace", attachmentId: null, local: false })).toBeNull();
  expect(officeSourceOf({ relpath: "", byteSource: "workspace", attachmentId: null, local: true })).toBeNull();
});
