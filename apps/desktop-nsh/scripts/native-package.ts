import { join } from "node:path";

/**
 * The macOS the app and everything in `native/` is built for: NSH's own floor (an `NSView` API new
 * in macOS 14). `package.ts` writes it into the bundle's Info.plist and `build-native.ts` hands it
 * to Swift and Cargo, so there is one place to raise it.
 */
export const minimumMacOS = "14.0";

/**
 * What `build-native.ts` ships into `native/`, per OS. macOS carries the Swift
 * runtime helper, pty helper and credentials library alongside the daemon, and the remote screen's
 * WebRTC helper; Windows has no equivalent of the Swift pieces, so it ships the daemon, the ConPTY
 * helper and the WebRTC helper. Linux ships the daemon, the forkpty build of that pty helper and
 * the WebRTC helper. `package.ts` checks the same lists when it packages.
 */
export function nativeFilesFor(platform: string): string[] {
  if (platform === "win32") return ["real-bot-daemon.exe", "real-bot-pty.exe", "real-bot-rtc.exe"];
  if (platform === "linux") return ["real-bot-daemon", "real-bot-pty", "real-bot-rtc"];
  return ["real-bot-daemon", "real-bot-runtime-helper", "real-bot-pty", "libRemoteCredentials.dylib", "real-bot-rtc"];
}

const nativeFiles = nativeFilesFor("darwin");

export function assertMinimum(advertised: string, required: string): void {
  const parse = (value: string) => {
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid macOS minimum");
    return value.split(".").map(Number);
  };
  const actual = parse(advertised);
  const needed = parse(required);
  for (let i = 0; i < 3; i++) {
    if ((actual[i] ?? 0) > (needed[i] ?? 0)) return;
    if ((actual[i] ?? 0) < (needed[i] ?? 0)) throw new Error(`macOS ${advertised} is below required ${required}`);
  }
}

export function machOMinimums(output: string): string[] {
  const values = [...output.matchAll(/\bcmd (LC_BUILD_VERSION|LC_VERSION_MIN_MACOSX)\b([\s\S]*?)(?=Load command|$)/g)]
    .map((match) => match[2]!.match(/^\s*(?:minos|version) (\d+\.\d+(?:\.\d+)?)\s*$/m)?.[1])
    .filter((value): value is string => value !== undefined);
  if (!values.length) throw new Error("Missing Mach-O deployment version");
  return values;
}

async function readCommand(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (status !== 0) throw new Error(`Package inspection failed: ${error.trim()}`);
  return output.trim();
}

export async function verifyNativeMinimum(directory: string, advertised = minimumMacOS): Promise<void> {
  for (const file of nativeFiles) {
    const output = await readCommand(["/usr/bin/otool", "-l", join(directory, file)]);
    for (const version of machOMinimums(output)) assertMinimum(advertised, version);
  }
}
