import { expect, test } from "bun:test";
import { baseName, fileUriOfHostPath, hostSeparator, isAbsoluteHostPath, isWindowsHostPath, joinHostPath } from "./paths.ts";

test("isWindowsHostPath knows a drive letter and a UNC share from a POSIX path", () => {
  expect(isWindowsHostPath("C:\\Users\\me\\ws")).toBe(true);
  expect(isWindowsHostPath("C:/Users/me/ws")).toBe(true);
  expect(isWindowsHostPath("d:\\ws")).toBe(true);
  expect(isWindowsHostPath("\\\\server\\share\\ws")).toBe(true);
  expect(isWindowsHostPath("/Users/me/ws")).toBe(false);
  expect(isWindowsHostPath("~/ws")).toBe(false);
});

test("hostSeparator matches the root's own spelling", () => {
  expect(hostSeparator("/Users/me/ws")).toBe("/");
  expect(hostSeparator("C:\\ws")).toBe("\\");
  expect(hostSeparator("\\\\server\\share")).toBe("\\");
});

test("isAbsoluteHostPath accepts POSIX, a drive letter, and a UNC share", () => {
  expect(isAbsoluteHostPath("/tmp/ws")).toBe(true);
  expect(isAbsoluteHostPath("C:\\ws")).toBe(true);
  expect(isAbsoluteHostPath("C:/ws")).toBe(true);
  expect(isAbsoluteHostPath("\\\\server\\share")).toBe(true);
  expect(isAbsoluteHostPath("relative/ws")).toBe(false);
  expect(isAbsoluteHostPath("~/ws")).toBe(false);
});

test("joinHostPath joins inside a POSIX root and rejects escapes, as absWorkspacePath did", () => {
  expect(joinHostPath("/Users/me/ws", "out/mock.png")).toBe("/Users/me/ws/out/mock.png");
  expect(joinHostPath("/Users/me/ws", "../secret.txt")).toBeNull();
  expect(joinHostPath("/Users/me/ws", "a/../../secret.txt")).toBeNull();
  expect(joinHostPath("/Users/me/ws", "/etc/passwd")).toBeNull();
  expect(joinHostPath("/Users/me/ws/", "out/assets")).toBe("/Users/me/ws/out/assets");
});

test("joinHostPath joins a Windows root with backslashes", () => {
  expect(joinHostPath("C:\\ws", "src/a.ts")).toBe("C:\\ws\\src\\a.ts");
  expect(joinHostPath("C:\\ws\\", "src/a.ts")).toBe("C:\\ws\\src\\a.ts");
  expect(joinHostPath("C:\\ws", "a/../../secret.txt")).toBeNull();
  expect(joinHostPath("\\\\server\\share", "out/mock.png")).toBe("\\\\server\\share\\out\\mock.png");
  expect(joinHostPath("C:\\ws", "")).toBeNull();
});

test("baseName splits on either separator", () => {
  expect(baseName("/Users/me/ws/a.ts")).toBe("a.ts");
  expect(baseName("C:\\Users\\me\\ws\\a.ts")).toBe("a.ts");
  expect(baseName("C:/Users/me/ws/a.ts")).toBe("a.ts");
  expect(baseName("a.ts")).toBe("a.ts");
  expect(baseName("/Users/me/ws/")).toBe("ws");
  expect(baseName("")).toBe("");
});

test("fileUriOfHostPath formats POSIX, Windows drive and UNC paths without encoding the drive colon", () => {
  expect(fileUriOfHostPath("/Users/me/Desktop/周报 draft.docx")).toBe("file:///Users/me/Desktop/%E5%91%A8%E6%8A%A5%20draft.docx");
  expect(fileUriOfHostPath("C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\deskfolk\\notes.md")).toBe("file:///C:/Users/RUNNER~1/AppData/Local/Temp/deskfolk/notes.md");
  expect(fileUriOfHostPath("C:\\Users\\me\\Desktop\\周报 draft.docx")).toBe("file:///C:/Users/me/Desktop/%E5%91%A8%E6%8A%A5%20draft.docx");
  expect(fileUriOfHostPath("D:\\")).toBe("file:///D:/");
  expect(fileUriOfHostPath("\\\\server\\share\\a b.txt")).toBe("file://server/share/a%20b.txt");
});
