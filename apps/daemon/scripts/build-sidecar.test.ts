import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_TARGETS,
  SIDECAR_NAME,
  bunTargetFor,
  fallbackHostTriple,
  sidecarFileName,
  tripleFrom,
} from "./build-sidecar.ts";

test("both shipped macOS triples map to a Bun target", () => {
  expect(bunTargetFor("aarch64-apple-darwin")).toBe("bun-darwin-arm64");
  expect(bunTargetFor("x86_64-apple-darwin")).toBe("bun-darwin-x64");
  expect(bunTargetFor("armv7-linux-androideabi")).toBeNull();
});

test("both Windows triples map to a Bun target too, so tauri dev's beforeDevCommand succeeds there", () => {
  expect(bunTargetFor("x86_64-pc-windows-msvc")).toBe("bun-windows-x64");
  expect(bunTargetFor("aarch64-pc-windows-msvc")).toBe("bun-windows-arm64");
});

test("the file name is the one Tauri looks for: base name plus target triple", () => {
  expect(sidecarFileName("aarch64-apple-darwin")).toBe("real-bot-daemon-aarch64-apple-darwin");
});

test("a Windows sidecar file name carries the .exe suffix the OS requires to run it", () => {
  expect(sidecarFileName("x86_64-pc-windows-msvc")).toBe("real-bot-daemon-x86_64-pc-windows-msvc.exe");
  expect(sidecarFileName("aarch64-pc-windows-msvc")).toBe("real-bot-daemon-aarch64-pc-windows-msvc.exe");
});

test("an explicit triple wins over Tauri's, which wins over this machine's", () => {
  const env = { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" };
  expect(tripleFrom(["aarch64-apple-darwin"], env, () => "host")).toBe("aarch64-apple-darwin");
  expect(tripleFrom([], env, () => "host")).toBe("x86_64-apple-darwin");
  expect(tripleFrom([], {}, () => "host")).toBe("host");
});

test("without rustc on PATH, the host triple guess follows this process's platform and arch, Windows included", () => {
  expect(fallbackHostTriple("darwin", "arm64")).toBe("aarch64-apple-darwin");
  expect(fallbackHostTriple("darwin", "x64")).toBe("x86_64-apple-darwin");
  expect(fallbackHostTriple("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  expect(fallbackHostTriple("win32", "arm64")).toBe("aarch64-pc-windows-msvc");
});

/**
 * Packaging goes through `build:native`, which compiles this same binary and then signs it with
 * the daemon entitlements the credential runtime needs. Nothing rides along as `externalBin`, so
 * the bundle carries one daemon, in the native resource directory. The Rust side still looks for
 * this base name — in `native/`, and beside the window binary for a build that only ran this
 * script — so the name must not drift. On Windows the Rust side appends `.exe` itself
 * (`std::env::consts::EXE_SUFFIX`) to this same stem, same as `sidecarFileName` here.
 */
test("the bundle ships the daemon through the native resources, not as a sidecar", () => {
  const conf = JSON.parse(
    readFileSync(join(import.meta.dir, "../../desktop/src-tauri/tauri.conf.json"), "utf8"),
  ) as { build: { beforeBuildCommand: string }; bundle: { externalBin: string[]; resources: Record<string, string> } };
  expect(conf.bundle.externalBin).toEqual([]);
  expect(conf.bundle.resources["native/"]).toBe("native/");
  expect(conf.build.beforeBuildCommand).toContain("@real-bot/desktop build:native");
  const rust = readFileSync(join(import.meta.dir, "../../desktop/src-tauri/src/daemon.rs"), "utf8");
  expect(rust).toContain(`const SIDECAR_NAME_STEM: &str = "${SIDECAR_NAME}"`);
});

test("the release matrix packages every macOS triple the build script knows", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../.github/workflows/release.yml"), "utf8");
  // This matrix packages the macOS .app (signed/notarized when the secrets are set). The Windows
  // installer comes from release.yml's own `publish-windows` job, which, like `windows.yml`, builds
  // it through `build:native` (apps/desktop/scripts/build-native.ts), not this matrix.
  const macTriples = Object.keys(BUN_TARGETS).filter((triple) => triple.endsWith("-apple-darwin"));
  expect(macTriples).toEqual(["aarch64-apple-darwin", "x86_64-apple-darwin"]);
  for (const triple of macTriples) {
    expect(workflow).toContain(`- triple: ${triple}`);
  }
  // The build hook compiles for the target being packaged, not for whatever the runner happens
  // to be: `build:native` reads the triple Tauri hands it.
  expect(workflow).toContain("args: --target ${{ matrix.triple }}");
  const native = readFileSync(join(import.meta.dir, "../../desktop/scripts/build-native.ts"), "utf8");
  expect(native).toContain("TAURI_ENV_TARGET_TRIPLE");
});
