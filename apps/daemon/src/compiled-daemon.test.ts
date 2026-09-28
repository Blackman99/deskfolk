import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The shipped daemon is `bun build --compile` output (see apps/desktop/scripts/build-native.ts):
// its modules live under `/$bunfs/root`, so anything read from a path beside the source is missing.
// rc.6–rc.9 shipped a daemon that threw on `/package.json` before listening; a dev daemon already
// holding the port hid it, since a window that finds a runtime never starts its own.
test.skipIf(process.platform !== "darwin")("the compiled daemon starts outside the source tree", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compiled-daemon-"));
  // The local API port is fixed, and a dev instance may be on it; this copy listens elsewhere.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = String(probe.port);
  await probe.stop(true);
  const binary = join(directory, "real-bot-daemon");
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "main.ts")],
      compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false, autoloadTsconfig: false, autoloadPackageJson: false },
      plugins: [{
        name: "test-port",
        setup(build) {
          build.onLoad({ filter: /packages\/protocol\/src\/index\.ts$/ }, async (args) => ({
            contents: (await Bun.file(args.path).text()).replaceAll("17890", port),
            loader: "ts",
          }));
        },
      }],
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn([binary], {
      cwd: "/",
      env: { HOME: directory, PATH: "/usr/bin:/bin", TMPDIR: directory, REAL_BOT_DATA_DIR: join(directory, "data") },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      const exited = child.exited.then(async (status) => `exited ${status}: ${await new Response(child.stderr).text()}`);
      const healthy = (async () => {
        for (let i = 0; i < 100; i++) {
          const health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json(), () => null);
          if (health) return health;
          await Bun.sleep(100);
        }
        return "never listened";
      })();
      expect(await Promise.race([exited, healthy])).toEqual({ ok: true, name: "real-bot" });
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
