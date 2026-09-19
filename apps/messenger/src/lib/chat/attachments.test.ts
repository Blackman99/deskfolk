import { expect, test } from "bun:test";
import { formatFileSize, isImageFileName } from "./attachments.ts";

test("formatFileSize formats bytes, KB, and MB", () => {
  expect(formatFileSize(500)).toBe("500 B");
  expect(formatFileSize(1024)).toBe("1.0 KB");
  expect(formatFileSize(2048)).toBe("2.0 KB");
  expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  expect(formatFileSize(5.5 * 1024 * 1024)).toBe("5.5 MB");
});

test("isImageFileName identifies image extensions", () => {
  expect(isImageFileName("photo.png")).toBe(true);
  expect(isImageFileName("photo.jpg")).toBe(true);
  expect(isImageFileName("photo.jpeg")).toBe(true);
  expect(isImageFileName("photo.webp")).toBe(true);
  expect(isImageFileName("photo.svg")).toBe(true);
  expect(isImageFileName("photo.gif")).toBe(true);
  expect(isImageFileName("report.pdf")).toBe(false);
  expect(isImageFileName("doc.txt")).toBe(false);
});
