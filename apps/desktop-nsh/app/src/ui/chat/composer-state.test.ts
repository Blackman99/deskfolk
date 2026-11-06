import { expect, test } from "nsh/test";
import { mimeOfName, nameOfUri, pathOfFileUri } from "./composer-state";

test("a dropped file's URL gives its path, name and type", () => {
  const uri = "file:///Users/me/Desktop/%E5%91%A8%E6%8A%A5%20draft.docx";
  expect(pathOfFileUri(uri)).toBe("/Users/me/Desktop/周报 draft.docx");
  expect(nameOfUri(uri)).toBe("周报 draft.docx");
  expect(mimeOfName("周报 draft.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  expect(mimeOfName("photo.JPG")).toBe("image/jpeg");
  expect(mimeOfName("unknown.xyz")).toBe("");
  expect(pathOfFileUri("https://example.com/a.png")).toBe(null);
});
