import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { addPhoneStatic as addWith, CODE_COLOURS_DATA, PAGE_STYLE, PHONE_ASSETS, PHONE_STATIC, siteVersion, VERSION_FILE } from "./phone-package";

const CONFIG = { id: "com.real-bot.desktop", code: "app.0123456789.js", chunks: { "Main.js": "Main.0123456789.js", "local-api.js": "local-api.1111111111.js", "local-discovery.js": "local-discovery.2222222222.js" } };

/** A package as `nsh package --target web` writes the files this changes, compressed copies included. */
function site(): string {
  const dir = mkdtempSync(join(tmpdir(), "phone-package-"));
  const write = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    writeFileSync(join(dir, `${name}.br`), brotliCompressSync(Buffer.from(text)));
    writeFileSync(join(dir, `${name}.gz`), gzipSync(Buffer.from(text)));
  };
  write("manifest.webmanifest", JSON.stringify({ id: "com.real-bot.desktop", name: "Deskfolk", display: "standalone", background_color: "#ffffff", icons: [] }));
  write(
    "index.html",
    `<head>\n<link rel="manifest" href="manifest.webmanifest">\n<style></style>\n</head>\n<body>\n<script type="application/json" id="nsh-app">${JSON.stringify(CONFIG)}</script>\n<script type="module" src="nsh-start.0123456789.js"></script>\n</body>`,
  );
  write("app.0123456789.js", 'import("./Main.0123456789.js")');
  write("Main.0123456789.js", 'export const hosted = () => import("./local-discovery.2222222222.js")');
  write("local-api.1111111111.js", "export class LocalApi {}");
  write("local-discovery.2222222222.js", 'export const discover = () => fetch("/__local-api")');
  return dir;
}

/** A stand-in for giallo's dump: the real one comes from `cargo metadata`, which the build runs. */
const DUMP = join(mkdtempSync(join(tmpdir(), "phone-package-dump-")), "builtin.zst");
writeFileSync(DUMP, "a zstd dump of grammars and themes");
const addPhoneStatic = (dir: string) => addWith(dir, PHONE_ASSETS, DUMP);

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const appConfig = (index: string) => JSON.parse(/<script type="application\/json" id="nsh-app">([^<]*)<\/script>/.exec(index)![1]!) as { data?: Record<string, string>; chunks?: Record<string, string> };
const params = (index: string) => JSON.parse(/<script type="application\/json" id="nsh-params">([^<]*)<\/script>/.exec(index)![1]!) as { build: string };

describe("the phone's package", () => {
  test("gets the service worker, its files and the icons, with the compressed copies made again", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      for (const name of PHONE_STATIC) expect(readFileSync(join(dir, name))).toEqual(readFileSync(join(PHONE_ASSETS, name)));
      expect(read(dir, "sw.js")).toContain('importScripts("/media-stream.js")');

      const index = read(dir, "index.html");
      expect(index).toContain('<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">');
      for (const name of ["manifest.webmanifest", "index.html"]) {
        const plain = read(dir, name);
        expect(brotliDecompressSync(readFileSync(join(dir, `${name}.br`))).toString()).toBe(plain);
        expect(gunzipSync(readFileSync(join(dir, `${name}.gz`))).toString()).toBe(plain);
      }

      // Run again, it adds nothing more.
      addPhoneStatic(dir);
      expect(read(dir, "index.html").match(/rel="apple-touch-icon"/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installs as the app the Svelte page was: its manifest id, name and icons", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      const installed = JSON.parse(readFileSync(join(PHONE_ASSETS, "manifest.webmanifest"), "utf8"));
      const manifest = JSON.parse(read(dir, "manifest.webmanifest"));
      expect(manifest.id).toBe(installed.id);
      expect(manifest.id).toBe("./");
      expect(manifest.name).toBe(installed.name);
      expect(manifest.short_name).toBe(installed.short_name);
      expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(["icon-192.png", "icon-512.png"]);
      // What NSH wrote and the Svelte page had no say in stays.
      expect(manifest.display).toBe("standalone");
      expect(manifest.background_color).toBe("#ffffff");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves out the chunks only a local window runs, and fails a page that still asks for the local API", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      for (const file of ["local-api.1111111111.js", "local-discovery.2222222222.js"]) {
        for (const suffix of ["", ".br", ".gz"]) expect(existsSync(join(dir, `${file}${suffix}`))).toBe(false);
      }
      const config = appConfig(read(dir, "index.html"));
      expect(config.chunks).toEqual({ "Main.js": "Main.0123456789.js" });

      writeFileSync(join(dir, "Main.0123456789.js"), 'fetch("/__local-api")');
      expect(() => addPhoneStatic(dir)).toThrow(/Main\.0123456789\.js still asks for the local API/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says which build it is, in the page's params and in the file open pages poll, the same on a second run", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      const first = params(read(dir, "index.html")).build;
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.parse(read(dir, VERSION_FILE))).toEqual({ version: first });
      expect(siteVersion(dir)).toBe(first);
      // The params sit after the app's config and before the start script.
      const index = read(dir, "index.html");
      expect(index.indexOf('id="nsh-app"')).toBeLessThan(index.indexOf('id="nsh-params"'));
      expect(index.indexOf('id="nsh-params"')).toBeLessThan(index.indexOf("nsh-start"));

      addPhoneStatic(dir);
      expect(params(read(dir, "index.html")).build).toBe(first);
      expect(read(dir, "index.html").match(/id="nsh-params"/g)).toHaveLength(1);

      // Another build is another version.
      writeFileSync(join(dir, "Main.0123456789.js"), "export const hosted = 2");
      addPhoneStatic(dir);
      const second = params(read(dir, "index.html")).build;
      expect(second).not.toBe(first);
      expect(JSON.parse(read(dir, VERSION_FILE))).toEqual({ version: second });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scroll view inside another hands on a swipe it cannot take: the page's own rule, last in the head, once", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      const index = read(dir, "index.html");
      expect(PAGE_STYLE).toContain(".nsh-scroll .nsh-scroll { overscroll-behavior: auto; }");
      expect(index).toContain(`${PAGE_STYLE}\n</head>`);
      // After what NSH put in the head.
      expect(index.indexOf("<style></style>")).toBeLessThan(index.indexOf(PAGE_STYLE));
      expect(gunzipSync(readFileSync(join(dir, "index.html.gz"))).toString()).toBe(index);

      addPhoneStatic(dir);
      expect(read(dir, "index.html").match(/id="deskfolk-page"/g)).toHaveLength(1);
      expect(read(dir, "index.html")).toContain(`${PAGE_STYLE}\n</head>`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("carries the code colours' grammars and themes, named by their content, as the page's data", () => {
    const dir = site();
    try {
      addPhoneStatic(dir);
      const name = appConfig(read(dir, "index.html")).data?.[CODE_COLOURS_DATA];
      expect(name).toMatch(/^nsh-giallo\.[0-9a-f]{10}\.bin$/);
      expect(readFileSync(join(dir, name!))).toEqual(readFileSync(DUMP));
      // zstd already: no compressed copies beside it.
      expect(existsSync(join(dir, `${name}.br`)) || existsSync(join(dir, `${name}.gz`))).toBe(false);
      expect(gunzipSync(readFileSync(join(dir, "index.html.gz"))).toString()).toBe(read(dir, "index.html"));

      // Another dump replaces it: one file, the page names the new one, and the build is another.
      const first = params(read(dir, "index.html")).build;
      writeFileSync(DUMP, "another dump");
      try {
        addPhoneStatic(dir);
      } finally {
        writeFileSync(DUMP, "a zstd dump of grammars and themes");
      }
      const files = readdirSync(dir).filter((f) => f.startsWith("nsh-giallo."));
      expect(files).toHaveLength(1);
      expect(appConfig(read(dir, "index.html")).data?.[CODE_COLOURS_DATA]).toBe(files[0]);
      expect(files[0]).not.toBe(name);
      expect(params(read(dir, "index.html")).build).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a page without the manifest link instead of guessing where the icon goes", () => {
    const dir = site();
    try {
      writeFileSync(join(dir, "index.html"), `<head></head><script type="application/json" id="nsh-app">${JSON.stringify(CONFIG)}</script>`);
      expect(() => addPhoneStatic(dir)).toThrow(/no manifest link/);
      expect(existsSync(join(dir, "index.html.br"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
