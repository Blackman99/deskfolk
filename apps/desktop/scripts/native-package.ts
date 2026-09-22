import { join } from "node:path";
import config from "../src-tauri/tauri.conf.json";

export const minimumMacOS = config.bundle.macOS.minimumSystemVersion;
const nativeFiles = ["real-bot-daemon", "real-bot-runtime-helper", "real-bot-pty", "libRemoteCredentials.dylib"];

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

if (import.meta.main) {
  const bundle = process.argv[2];
  if (!bundle?.endsWith(".app")) throw new Error("Pass the built .app path");
  const minimum = await readCommand(["/usr/libexec/PlistBuddy", "-c", "Print :LSMinimumSystemVersion", join(bundle, "Contents/Info.plist")]);
  if (minimum !== minimumMacOS) throw new Error("Bundle minimum differs from published configuration");
  await verifyNativeMinimum(join(bundle, "Contents/Resources/native"), minimum);
  const desktop = await readCommand(["/usr/bin/otool", "-l", join(bundle, "Contents/MacOS/real-bot-desktop")]);
  for (const version of machOMinimums(desktop)) assertMinimum(minimum, version);
  console.log(`Bundle and mandatory native resources support advertised macOS ${minimum}+.`);
}
