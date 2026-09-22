import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { minimumMacOS, verifyNativeMinimum } from "./native-package";

const root = resolve(import.meta.dir, "../../..");
const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
if (!["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) {
  throw new Error("Native credentials packaging supports macOS arm64/x86_64 only");
}
const arch = target.startsWith("aarch64") ? "arm64" : "x86_64";
const triple = `${arch}-apple-macosx${minimumMacOS}`;
const output = resolve(root, "apps/desktop/src-tauri/native");
await mkdir(output, { recursive: true });

async function run(args: string[], capture = false): Promise<string> {
  const child = Bun.spawn(args, { cwd: root, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  const text = capture ? await new Response(child.stdout).text() : "";
  if (await child.exited !== 0) throw new Error(`Native build failed: ${args[0]}`);
  return text.trim();
}

for (const product of ["real-bot-runtime-helper", "real-bot-pty", "RemoteCredentials"]) {
  await run(["swift", "build", "--package-path", "apps/runtime-helper", "-c", "release", "--triple", triple, "--product", product]);
}
const bin = await run(["swift", "build", "--package-path", "apps/runtime-helper", "-c", "release", "--triple", triple, "--show-bin-path"], true);
for (const name of ["real-bot-runtime-helper", "real-bot-pty", "libRemoteCredentials.dylib"]) {
  await copyFile(resolve(bin, name), resolve(output, name));
}
await run(["bun", "build", "--compile", `--target=bun-darwin-${arch === "arm64" ? "arm64" : "x64"}`,
  "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json", "apps/daemon/src/main.ts", "--outfile", resolve(output, "real-bot-daemon")]);

await verifyNativeMinimum(output);

// Stock Bun is not a sealed credential principal. Never grant it the remote access group here.
const identity = process.env.APPLE_SIGNING_IDENTITY ?? "-";
for (const [file, id] of [
  ["real-bot-runtime-helper", "com.real-bot.runtime-helper"],
  // Signed like the rest, but it carries no access group: a pty is not a credential principal.
  ["real-bot-pty", "com.real-bot.pty"],
  ["libRemoteCredentials.dylib", "com.real-bot.remote-credentials"],
  ["real-bot-daemon", "com.real-bot.daemon"],
]) {
  const args = ["codesign", "--force", "--sign", identity, "--identifier", id!, "--options", "runtime"];
  if (file === "real-bot-daemon") args.push("--entitlements", resolve(import.meta.dir, "../src-tauri/daemon-entitlements.plist"));
  args.push(resolve(output, file!));
  await run(args);
}
console.log(`Native resources built in ${dirname(output)}/native; remote credentials remain disabled (G-pack not verified).`);
