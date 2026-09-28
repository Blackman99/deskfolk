import { describe, expect, test } from "bun:test";
import { attachmentFileName } from "./messages";

describe("attachmentFileName", () => {
  test("keeps the base name and replaces anything unusual, as before", () => {
    expect(attachmentFileName("report.pdf", "darwin")).toBe("report.pdf");
    expect(attachmentFileName("../../etc/passwd", "darwin")).toBe("passwd");
    expect(attachmentFileName("a:b?c.txt", "darwin")).toBe("a_b_c.txt");
    expect(attachmentFileName("周报 v2.md", "darwin")).toBe("周报 v2.md");
    expect(attachmentFileName("", "darwin")).toBe("attachment");
    // A Mac keeps names Windows would refuse.
    expect(attachmentFileName("CON.txt", "darwin")).toBe("CON.txt");
    expect(attachmentFileName("notes.", "darwin")).toBe("notes.");
  });

  test("on Windows either separator ends the folder part", () => {
    expect(attachmentFileName("C:\\Users\\me\\report.pdf", "win32")).toBe("report.pdf");
    expect(attachmentFileName("..\\..\\evil.txt", "win32")).toBe("evil.txt");
    expect(attachmentFileName("a/b.txt", "win32")).toBe("b.txt");
  });

  test("on Windows no trailing dot or space, and no device name", () => {
    expect(attachmentFileName("notes.", "win32")).toBe("notes");
    expect(attachmentFileName("notes. . ", "win32")).toBe("notes");
    expect(attachmentFileName("..", "win32")).toBe("attachment");
    expect(attachmentFileName("CON", "win32")).toBe("_CON");
    expect(attachmentFileName("con.txt", "win32")).toBe("_con.txt");
    expect(attachmentFileName("nul", "win32")).toBe("_nul");
    expect(attachmentFileName("COM1.log", "win32")).toBe("_COM1.log");
    expect(attachmentFileName("lpt9", "win32")).toBe("_lpt9");
    expect(attachmentFileName("console.log", "win32")).toBe("console.log");
    expect(attachmentFileName("com10.txt", "win32")).toBe("com10.txt");
  });
});
