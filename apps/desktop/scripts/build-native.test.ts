import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  conptyBuildPlan,
  daemonBuildPlan,
  familyFor,
  resolveTriple,
  windowsSignArgv,
} from "./build-native.ts";

test("a Windows sign command is read the way Tauri's signCommand string is: spaces, and %1 for the file", () => {
  const file = "C:\\repo\\apps\\desktop\\src-tauri\\native\\real-bot-daemon.exe";
  expect(windowsSignArgv("trusted-signing-cli -e https://eus.codesigning.azure.net -a acct -c profile -d Deskfolk %1", file)).toEqual([
    "trusted-signing-cli", "-e", "https://eus.codesigning.azure.net", "-a", "acct", "-c", "profile", "-d", "Deskfolk", file,
  ]);
  expect(windowsSignArgv("signtool sign /fd sha256  /f:%1", file)).toEqual(["signtool", "sign", "/fd", "sha256", `/f:${file}`]);
  expect(() => windowsSignArgv("signtool sign", file)).toThrow();
  expect(() => windowsSignArgv("   ", file)).toThrow();
});

const nativeDir = "/repo/apps/desktop/src-tauri/native";

test("familyFor recognizes the macOS and Windows triples this project ships, and nothing else", () => {
  expect(familyFor("aarch64-apple-darwin")).toBe("darwin");
  expect(familyFor("x86_64-apple-darwin")).toBe("darwin");
  expect(familyFor("x86_64-pc-windows-msvc")).toBe("windows");
  expect(familyFor("aarch64-pc-windows-msvc")).toBe("windows");
  expect(() => familyFor("x86_64-unknown-linux-gnu")).toThrow();
});

test("resolveTriple: an explicit TAURI_ENV_TARGET_TRIPLE always wins", () => {
  expect(resolveTriple({ TAURI_ENV_TARGET_TRIPLE: "aarch64-pc-windows-msvc" }, "darwin", "arm64")).toBe(
    "aarch64-pc-windows-msvc",
  );
});

test("resolveTriple falls back to this host's own OS and architecture, Windows included", () => {
  expect(resolveTriple({}, "win32", "x64")).toBe("x86_64-pc-windows-msvc");
  expect(resolveTriple({}, "win32", "arm64")).toBe("aarch64-pc-windows-msvc");
  expect(resolveTriple({}, "darwin", "x64")).toBe("x86_64-apple-darwin");
  expect(resolveTriple({}, "darwin", "arm64")).toBe("aarch64-apple-darwin");
});

test("the macOS daemon compile is unchanged: no Windows metadata flags, no .exe suffix", () => {
  const { args, outfile } = daemonBuildPlan("x86_64-apple-darwin", nativeDir);
  expect(args).toEqual([
    "bun",
    "build",
    "--compile",
    "--target=bun-darwin-x64",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "apps/daemon/src/main.ts",
    "--outfile",
    resolve(nativeDir, "real-bot-daemon"),
  ]);
  expect(outfile).toBe(resolve(nativeDir, "real-bot-daemon"));
});

test("the arm64 macOS daemon compile targets bun-darwin-arm64", () => {
  const { args } = daemonBuildPlan("aarch64-apple-darwin", nativeDir);
  expect(args).toContain("--target=bun-darwin-arm64");
});

test("the Windows daemon compile targets bun-windows-*, stamps executable metadata, and outputs .exe", () => {
  const { args, outfile } = daemonBuildPlan("x86_64-pc-windows-msvc", nativeDir);
  expect(args).toContain("--target=bun-windows-x64");
  expect(args).toContain("--windows-title=Deskfolk Daemon");
  expect(args).toContain("--windows-description=Deskfolk background daemon");
  expect(args).toContain("--windows-icon=apps/desktop/src-tauri/icons/icon.ico");
  expect(args).not.toContain("--windows-hide-console");
  expect(outfile).toBe(resolve(nativeDir, "real-bot-daemon.exe"));

  const arm = daemonBuildPlan("aarch64-pc-windows-msvc", nativeDir);
  expect(arm.args).toContain("--target=bun-windows-arm64");
});

test("the ConPTY helper is built for the requested triple and copied beside the daemon", () => {
  const plan = conptyBuildPlan("x86_64-pc-windows-msvc", nativeDir);
  expect(plan.manifestPath).toBe("apps/conpty-helper/Cargo.toml");
  expect(plan.args).toEqual([
    "cargo",
    "build",
    "--release",
    "--manifest-path",
    "apps/conpty-helper/Cargo.toml",
    "--target",
    "x86_64-pc-windows-msvc",
  ]);
  // Repo-relative, not resolved against whatever cwd the script happens to run in.
  expect(plan.builtPath).toBe("apps/conpty-helper/target/x86_64-pc-windows-msvc/release/real-bot-pty.exe");
  expect(plan.destPath).toBe(resolve(nativeDir, "real-bot-pty.exe"));
});
