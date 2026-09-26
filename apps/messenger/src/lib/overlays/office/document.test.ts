import { afterAll, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * happy-dom 20's getElementsByTagNameNS('*', name) is empty. A browser returns
 * every Relationship. Scoped to this file and restored after it.
 */
class RelationshipParser extends DOMParser {
  override parseFromString(source: string, type: DOMParserSupportedType): Document {
    const xml = super.parseFromString(source, type);
    if (!source.includes("<Relationships")) return xml;
    const native = xml.getElementsByTagNameNS.bind(xml);
    xml.getElementsByTagNameNS = (namespace: string, name: string) => {
      const found = native(namespace, name);
      if (found.length > 0 || namespace !== "*" || name !== "Relationship") return found;
      return xml.getElementsByTagName(name);
    };
    return xml;
  }
}
const previousParser = globalThis.DOMParser;
globalThis.DOMParser = RelationshipParser;
afterAll(() => {
  globalThis.DOMParser = previousParser;
});

const { localOfficeData, paintOfficeFill } = await import("./document.ts");

const EVIL = "https://evil.example/collect";

function packageBytes(rels: string, extra: Record<string, Uint8Array> = {}): ArrayBuffer {
  const packed = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/_rels/document.xml.rels": strToU8(rels),
    "word/media/picture.bin": strToU8("embedded-bytes"),
    ...extra,
  });
  return packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
}

function relationships(source: ArrayBuffer): string {
  const files = unzipSync(new Uint8Array(source));
  const rels = files["word/_rels/document.xml.rels"];
  if (!rels) throw new Error("missing relationships");
  return strFromU8(rels);
}

test("external relationships and URI targets are stripped; embedded parts stay", () => {
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/picture.bin"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${EVIL}" TargetMode="External"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="//evil.example/path"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="file:///tmp/secret" TargetMode="external"/>
</Relationships>`;

  const local = localOfficeData(packageBytes(rels));
  const xml = relationships(local);
  expect(xml).toContain('Target="media/picture.bin"');
  expect(xml).toContain('Id="rId1"');
  expect(xml).not.toContain(EVIL);
  expect(xml).not.toContain("evil.example");
  expect(xml).not.toContain("file:");
  expect(xml).not.toContain('Id="rId2"');
  expect(xml).not.toContain('Id="rId3"');
  expect(xml).not.toContain('Id="rId4"');

  const files = unzipSync(new Uint8Array(local));
  expect(strFromU8(files["word/media/picture.bin"]!)).toBe("embedded-bytes");
  expect(strFromU8(files["[Content_Types].xml"]!)).toBe("<Types/>");
});

test("a malformed relationship part is rejected and the original is left untouched", () => {
  const original = packageBytes("<Relationships><Relationship TargetMode='External'");
  const before = new Uint8Array(original);
  expect(() => localOfficeData(original)).toThrow("office-invalid");
  expect(new Uint8Array(original)).toEqual(before);
});

test("a part that is not relationships is left byte for byte", () => {
  const note = strToU8("leave me");
  const original = packageBytes(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
    { "word/document.xml": note },
  );
  const files = unzipSync(new Uint8Array(localOfficeData(original)));
  expect(files["word/document.xml"]).toEqual(note);
});

test("the fill around the pages is the messenger's page colour, in its colour scheme", () => {
  const from = document.createElement("div");
  from.style.setProperty("--bg", "#0d1219");
  from.style.colorScheme = "dark";
  document.body.appendChild(from);
  const frame = document.implementation.createHTMLDocument("office");
  try {
    paintOfficeFill(frame, from);
    expect(frame.documentElement.style.getPropertyValue("--office-fill")).toBe("#0d1219");
    expect(frame.documentElement.style.colorScheme).toBe("dark");

    from.style.setProperty("--bg", "#eef2f6");
    from.style.colorScheme = "light";
    paintOfficeFill(frame, from);
    expect(frame.documentElement.style.getPropertyValue("--office-fill")).toBe("#eef2f6");
    expect(frame.documentElement.style.colorScheme).toBe("light");
  } finally {
    from.remove();
  }
});
