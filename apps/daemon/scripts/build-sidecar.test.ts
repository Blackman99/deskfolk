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

/** The Rust side looks for this base name next to the window binary; the two must not drift. */
test("tauri.conf.json declares the sidecar this script writes", () => {
  const conf = JSON.parse(
    readFileSync(join(import.meta.dir, "../../desktop/src-tauri/tauri.conf.json"), "utf8"),
  ) as { bundle: { externalBin: string[] } };
  expect(conf.bundle.externalBin).toEqual([`binaries/${SIDECAR_NAME}`]);
});

test("the release matrix packages every triple the build script knows", () => {
  const workflow = readFileSync(join(import.meta.dir, "../../../.github/workflows/release.yml"), "utf8");
  for (const triple of Object.keys(BUN_TARGETS)) {
    expect(workflow).toContain(`- triple: ${triple}`);
  }
  // The sidecar is built for the target being packaged, not for whatever the runner happens to be.
  expect(workflow).toContain("build:sidecar ${{ matrix.triple }}");
});
