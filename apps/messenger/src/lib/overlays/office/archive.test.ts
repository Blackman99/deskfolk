import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { checkOfficeArchive, OFFICE_MAX_BYTES, type OfficeKind } from "./archive.ts";

const MAIN: Record<OfficeKind, string> = {
  word: "word/document.xml",
  spreadsheet: "xl/workbook.xml",
  presentation: "ppt/presentation.xml",
};

function officeZip(kind: OfficeKind, extra: Record<string, Uint8Array> = {}): ArrayBuffer {
  const packed = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    [MAIN[kind]]: strToU8("<body/>"),
    ...extra,
  });
  return packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
}

/**
 * Stored (method 0) ZIP whose central directory reports `originalSize`.
 * Local payloads stay empty: the checker returns false from its filter, so it
 * never slices them. Sizes above 4 GiB go in a ZIP64 extra field.
 */
function fakeArchive(entries: Array<{ name: string; originalSize: number }>): ArrayBuffer {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localEnd = 0;
  for (const entry of entries) {
    const name = strToU8(entry.name);
    const zip64 = entry.originalSize > 0xffffffff;
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local);

    const extra = zip64 ? 20 : 0;
    const central = new Uint8Array(46 + name.length + extra);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, zip64 ? 45 : 20, true);
    view.setUint16(6, 20, true);
    view.setUint32(20, zip64 ? 0xffffffff : entry.originalSize, true);
    view.setUint32(24, zip64 ? 0xffffffff : entry.originalSize, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, extra, true);
    view.setUint32(42, localEnd, true);
    central.set(name, 46);
    if (zip64) {
      view.setUint16(46 + name.length, 0x0001, true);
      view.setUint16(48 + name.length, 16, true);
      view.setUint32(50 + name.length, entry.originalSize, true);
      view.setUint32(54 + name.length, Math.floor(entry.originalSize / 0x100000000), true);
    }
    centrals.push(central);
    localEnd += local.length;
  }
  const directory = centrals.reduce((sum, record) => sum + record.length, 0);
  const end = new Uint8Array(22);
  const tail = new DataView(end.buffer);
  tail.setUint32(0, 0x06054b50, true);
  tail.setUint16(8, entries.length, true);
  tail.setUint16(10, entries.length, true);
  tail.setUint32(12, directory, true);
  tail.setUint32(16, localEnd, true);
  const out = new Uint8Array(localEnd + directory + 22);
  let cursor = 0;
  for (const record of [...locals, ...centrals, end]) {
    out.set(record, cursor);
    cursor += record.length;
  }
  return out.buffer;
}

test("a minimal zip with the package parts for its kind is accepted", () => {
  for (const kind of ["word", "spreadsheet", "presentation"] as const) {
    expect(() => checkOfficeArchive(officeZip(kind), kind)).not.toThrow();
  }
});

test("the wrong main part, or a missing content types part, is rejected", () => {
  expect(() => checkOfficeArchive(officeZip("word"), "spreadsheet")).toThrow("office-invalid");
  expect(() => checkOfficeArchive(officeZip("spreadsheet"), "presentation")).toThrow("office-invalid");
  const missing = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });
  expect(() => checkOfficeArchive(missing.buffer as ArrayBuffer, "spreadsheet")).toThrow("office-invalid");
});

test("too many entries, or an uncompressed size past the guard, is a limit", () => {
  const many = Array.from({ length: 4001 }, (_, index) => ({
    name: index === 0 ? "[Content_Types].xml" : index === 1 ? "xl/workbook.xml" : `xl/extra-${index}.xml`,
    originalSize: 1,
  }));
  expect(() => checkOfficeArchive(fakeArchive(many), "spreadsheet")).toThrow("office-limit");

  const huge = [
    { name: "[Content_Types].xml", originalSize: 1 },
    { name: "xl/workbook.xml", originalSize: 32 * 1024 * 1024 + 1 },
  ];
  expect(() => checkOfficeArchive(fakeArchive(huge), "spreadsheet")).toThrow("office-limit");

  const expanded = [
    { name: "[Content_Types].xml", originalSize: 1 },
    { name: "xl/workbook.xml", originalSize: 64 * 1024 * 1024 },
    { name: "xl/sharedStrings.xml", originalSize: 64 * 1024 * 1024 },
  ];
  expect(() => checkOfficeArchive(fakeArchive(expanded), "spreadsheet")).toThrow("office-limit");
});

test("a package already over 50 MiB is a limit before the zip is read", () => {
  const oversized = new ArrayBuffer(OFFICE_MAX_BYTES + 1);
  expect(() => checkOfficeArchive(oversized, "spreadsheet")).toThrow("office-limit");
});

test("bytes that are not a zip are invalid", () => {
  const junk = strToU8("not a zip").buffer as ArrayBuffer;
  expect(() => checkOfficeArchive(junk, "word")).toThrow();
});
