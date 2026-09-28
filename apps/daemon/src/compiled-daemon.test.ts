import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The shipped daemon is `bun build --compile` output (see apps/desktop/scripts/build-native.ts):
// its modules live under `/$bunfs/root`, so anything read from a path beside the source is missing.
// rc.6–rc.9 shipped a daemon that threw on `/package.json` before listening; a dev daemon already
// holding the port hid it, since a window that finds a runtime never starts its own.
test.skipIf(process.platform !== "darwin")("the compiled daemon starts outside the source tree and answers its window", async () => {
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
    // Started the way the window starts it: `--desktop-remote-channel` with a socketpair on FD 3.
    const child = spawn(binary, ["--desktop-remote-channel"], {
      cwd: "/",
      env: { HOME: directory, PATH: "/usr/bin:/bin", TMPDIR: directory, REAL_BOT_DATA_DIR: join(directory, "data") },
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (bytes) => { stderr += bytes; });
    const exitedAt = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      const exited = exitedAt.then((status) => `exited ${status}: ${stderr}`);
      const healthy = (async () => {
        for (let i = 0; i < 100; i++) {
          const health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json(), () => null);
          if (health) return health;
          await Bun.sleep(100);
        }
        return "never listened";
      })();
      expect(await Promise.race([exited, healthy])).toEqual({ ok: true, name: "real-bot" });
      // Remote ships on the file credential store (ADR 0033): the settings panel's connect form
      // shows, where a sealed-provider daemon would say it cannot be set up from this build.
      const { token } = JSON.parse(readFileSync(join(directory, "data", "local-api.json"), "utf8")) as { token: string };
      const snapshot = await fetch(`http://127.0.0.1:${port}/v1/snapshot`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
      expect(snapshot.remoteStatus).toEqual({ state: "off", diagnostic: null, devices: 0 });
      // The window's setup channel answers. It never had: Bun's `net.Socket({ fd: 3 })` ended the
      // socketpair at once, hidden while the sealed provider refused the channel before attaching.
      const channel = child.stdio[3] as Socket;
      let ended = false;
      channel.once("end", () => { ended = true; });
      const call = (request: unknown) => new Promise<unknown>((resolve, reject) => {
        const payload = Buffer.from(JSON.stringify(request)), prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(payload.length);
        let buffer = Buffer.alloc(0);
        const onEnd = () => { clearTimeout(timer); reject(new Error("the daemon closed the window channel")); };
        const timer = setTimeout(() => reject(new Error("no reply on the window channel")), 5000);
        const onData = (bytes: Buffer) => {
          buffer = Buffer.concat([buffer, bytes]);
          if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0) + 4) return;
          clearTimeout(timer); channel.off("data", onData); channel.off("end", onEnd);
          resolve(JSON.parse(buffer.subarray(4).toString("utf8")));
        };
        if (ended) { onEnd(); return; }
        channel.on("data", onData); channel.once("end", onEnd);
        channel.write(Buffer.concat([prefix, payload]));
      });
      expect(await call({ operation: "status" })).toEqual({ ok: true, value: { state: "off", diagnostic: null, devices: 0 } });
      // The confirmation steps are the window's; the source-only stand-in is not there at all.
      const challenge = `${"A".repeat(43)}=`;
      expect(await call({ operation: "challenge_display", challenge })).toEqual({ ok: false, error: "remote_setup_denied" });
      expect(await call({ operation: "dev_authenticate", challenge })).toEqual({ ok: false, error: "remote_setup_denied" });
      const runtime = await fetch(`http://127.0.0.1:${port}/v1/runtime`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
      expect(runtime.restart).toBe("available");
    } finally {
      child.kill();
      await exitedAt;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
