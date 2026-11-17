import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { addPhoneStatic, MESSENGER_STATIC, PHONE_STATIC } from "./phone-package";

/** A package as `nsh package --target web` writes the two files this changes, compressed copies included. */
function site(): string {
  const dir = mkdtempSync(join(tmpdir(), "phone-package-"));
  const write = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    writeFileSync(join(dir, `${name}.br`), brotliCompressSync(Buffer.from(text)));
    writeFileSync(join(dir, `${name}.gz`), gzipSync(Buffer.from(text)));
  };
  write("manifest.webmanifest", JSON.stringify({ name: "Deskfolk", display: "standalone", icons: [] }));
  write("index.html", '<head>\n<link rel="manifest" href="manifest.webmanifest">\n<style></style>\n</head>');
  return dir;
}

describe("the phone's package", () => {
  test("gets the messenger's service worker, its files and the icons, with the compressed copies made again", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      for (const name of PHONE_STATIC) expect(readFileSync(join(dir, name))).toEqual(readFileSync(join(MESSENGER_STATIC, name)));
      expect(readFileSync(join(dir, "sw.js"), "utf8")).toContain('importScripts("/media-stream.js")');

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.webmanifest"), "utf8"));
      expect(manifest.name).toBe("Deskfolk");
      expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(["icon-192.png", "icon-512.png"]);
      const index = readFileSync(join(dir, "index.html"), "utf8");
      expect(index).toContain('<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">');
      for (const name of ["manifest.webmanifest", "index.html"]) {
        const plain = readFileSync(join(dir, name), "utf8");
        expect(brotliDecompressSync(readFileSync(join(dir, `${name}.br`))).toString()).toBe(plain);
        expect(gunzipSync(readFileSync(join(dir, `${name}.gz`))).toString()).toBe(plain);
      }

      // Run again, it adds nothing more.
      addPhoneStatic(dir);
      expect(readFileSync(join(dir, "index.html"), "utf8").match(/rel="apple-touch-icon"/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a page without the manifest link instead of guessing where the icon goes", () => {
    const dir = site();
    try {
      writeFileSync(join(dir, "index.html"), "<head></head>");
      expect(() => addPhoneStatic(dir)).toThrow(/no manifest link/);
      expect(existsSync(join(dir, "index.html.br"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
