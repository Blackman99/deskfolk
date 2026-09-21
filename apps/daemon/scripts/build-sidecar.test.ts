import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_TARGETS, SIDECAR_NAME, bunTargetFor, sidecarFileName, tripleFrom } from "./build-sidecar.ts";

test("both shipped macOS triples map to a Bun target", () => {
  expect(bunTargetFor("aarch64-apple-darwin")).toBe("bun-darwin-arm64");
  expect(bunTargetFor("x86_64-apple-darwin")).toBe("bun-darwin-x64");
  expect(bunTargetFor("armv7-linux-androideabi")).toBeNull();
});

test("the file name is the one Tauri looks for: base name plus target triple", () => {
  expect(sidecarFileName("aarch64-apple-darwin")).toBe("real-bot-daemon-aarch64-apple-darwin");
});

test("an explicit triple wins over Tauri's, which wins over this machine's", () => {
  const env = { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" };
  expect(tripleFrom(["aarch64-apple-darwin"], env, () => "host")).toBe("aarch64-apple-darwin");
  expect(tripleFrom([], env, () => "host")).toBe("x86_64-apple-darwin");
  expect(tripleFrom([], {}, () => "host")).toBe("host");
});

/**
 * Packaging goes through `build:native`, which compiles this same binary and then signs it with
 * the daemon entitlements the credential runtime needs. Nothing rides along as `externalBin`, so
 * the bundle carries one daemon, in the native resource directory. The Rust side still looks for
 * this base name — in `native/`, and beside the window binary for a build that only ran this
 * script — so the name must not drift.
 */
test("the bundle ships the daemon through the native resources, not as a sidecar", () => {
  const conf = JSON.parse(
    readFileSync(join(import.meta.dir, "../../desktop/src-tauri/tauri.conf.json"), "utf8"),
  ) as { build: { beforeBuildCommand: string }; bundle: { externalBin: string[]; resources: Record<string, string> } };
  expect(conf.bundle.externalBin).toEqual([]);
  expect(conf.bundle.resources["native/"]).toBe("native/");
  expect(conf.build.beforeBuildCommand).toContain("@real-bot/desktop build:native");
  const rust = readFileSync(join(import.meta.dir, "../../desktop/src-tauri/src/daemon.rs"), "utf8");
  expect(rust).toContain(`const SIDECAR_NAME: &str = "${SIDECAR_NAME}"`);
});

test("the release matrix packages every triple the build script knows", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../.github/workflows/release.yml"), "utf8");
  for (const triple of Object.keys(BUN_TARGETS)) {
    expect(workflow).toContain(`- triple: ${triple}`);
  }
  // The build hook compiles for the target being packaged, not for whatever the runner happens
  // to be: `build:native` reads the triple Tauri hands it.
  expect(workflow).toContain("args: --target ${{ matrix.triple }}");
  const native = readFileSync(join(import.meta.dir, "../../desktop/scripts/build-native.ts"), "utf8");
  expect(native).toContain("TAURI_ENV_TARGET_TRIPLE");
});
