import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// These are negative qualification probes, not permission to entitle the stock runtime.
test.skipIf(process.platform !== "darwin")("stock compiled Bun remains unqualified despite disabled autoload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rc05-runtime-fixture-"));
  const binary = join(directory, "rc05-print-fixture");
  const entry = join(directory, "entry.ts");
  const preload = join(directory, "preload.ts");
  const config = join(directory, "explicit.toml");
  const env = { HOME: directory, PATH: "/usr/bin:/bin", TMPDIR: directory };
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn(args, { cwd: directory, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (status !== 0) throw new Error(`Fixture command failed: ${stderr}`);
    return stdout;
  };
  try {
    await writeFile(entry, 'console.log("FIXTURE_ENTRY", process.env.RC05_AUTOLOAD ?? "absent")');
    await writeFile(preload, 'console.log("EXTERNAL_PRELOAD")');
    await writeFile(join(directory, ".env"), "RC05_AUTOLOAD=loaded\n");
    await writeFile(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(config, 'preload = ["./preload.ts"]\n');
    await run([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json", entry, "--outfile", binary]);
    await run(["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--entitlements",
      resolve(import.meta.dir, "../src-tauri/daemon-entitlements.plist"), binary]);
    expect(await run([binary])).toBe("FIXTURE_ENTRY absent\n");
    for (const options of [`--preload ${preload}`, `--config ${config}`]) {
      expect(await run([binary], { BUN_OPTIONS: options })).toContain("EXTERNAL_PRELOAD");
    }
    expect(await run([binary, "-e", 'console.log("INTERPRETER_ESCAPE")'], { BUN_BE_BUN: "1" })).toContain("INTERPRETER_ESCAPE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
