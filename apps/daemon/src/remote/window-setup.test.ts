import { afterEach, expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64url, canonicalize, fromBase64url, generateIdentity, identityPublic, openPairingGrant, randomBytes, sealPairing,
  type PairingQr } from "@real-bot/remote";
import { startRelay } from "../../../relay/src/server";
import { Store } from "../store";
import { memoryKeyStore } from "../secrets";
import { createLocalApi } from "../local-api";
import { ulid } from "../ids";
import { RemoteController } from "./controller";
import { FileRemoteNative } from "./file-native";
import { attachLocalSetup, windowDispatch } from "./local-setup";

// The packaged app's whole setup path: the file credential store, the window's channel (a unix
// socket here instead of the inherited FD 3), a real relay, and a device pairing through it.
const ORIGIN = "https://relay.example.test", HOST = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

type Reply = { ok: boolean; value?: unknown; error?: string };

async function packagedHost() {
  const root = mkdtempSync(join(tmpdir(), "rb-window-setup-"));
  const store = new Store({ filename: join(root, "host.sqlite"), endpointKey: memoryKeyStore() });
  await store.patchSettings({ workspace_path: root });
  const api = createLocalApi({ store, token: "fixture", schedule: false });
  const bootstrap = base64url(randomBytes(32));
  const relay = startRelay({ hostname: "127.0.0.1", port: 0, database: join(root, "relay.sqlite"), bootstrap,
    origin: ORIGIN, relayId: "fixture", enabled: true, pairingEnabled: true });
  const localOrigin = `http://127.0.0.1:${relay.port}`;
  const credentials = join(root, "data", "dev-remote");
  const native = new FileRemoteNative(credentials);
  const controller = new RemoteController({ store, api, native,
    socketFactory: url => new WebSocket(`${localOrigin.replace("http:", "ws:")}${new URL(url).pathname}`),
    fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace(ORIGIN, localOrigin), init)) as typeof fetch,
    pushFetch: async () => { throw new Error("isolated tests must not send web push"); },
  });
  const path = join(root, "window.sock");
  const server = createServer(socket => { attachLocalSetup(socket, controller, undefined, windowDispatch(native)); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const socket: Socket = createConnection(path);
  await new Promise(resolve => socket.once("connect", resolve));
  cleanup.push(async () => {
    socket.destroy(); server.close();
    api.terminals.shutdown(); controller.stop(); api.quiesce.close(); await api.engine.close(); await relay.stop(); store.close();
    rmSync(root, { recursive: true, force: true });
  });
  /** One framed request at a time, the way Tauri's `remote_local_setup` sends them. */
  const call = (request: unknown) => new Promise<Reply>(resolve => {
    const payload = Buffer.from(JSON.stringify(request)), prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(payload.length);
    let buffer = Buffer.alloc(0);
    const onData = (bytes: Buffer) => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0) + 4) return;
      socket.off("data", onData);
      resolve(JSON.parse(buffer.subarray(4).toString("utf8")) as Reply);
    };
    socket.on("data", onData);
    socket.write(Buffer.concat([prefix, payload]));
  });
  const post = (value: unknown) => fetch(`${localOrigin}/v1/pair/mailbox`, { method: "POST", headers: { "Content-Type": "application/json" }, body: canonicalize(value) });
  return { call, post, controller, store, credentials, bootstrap };
}

test("the packaged window registers with a relay, then pairs a device on a proof it asked for itself", async () => {
  const host = await packagedHost();
  const config = { origin: ORIGIN, relayId: "fixture", hostId: HOST };

  // A spent or mistyped token is told apart, and leaves nothing behind to trip the retry.
  expect(await host.call({ operation: "initialize", config, bootstrap: base64url(randomBytes(32)) })).toEqual({ ok: false, error: "relay_bootstrap" });
  expect(host.store.db.query("SELECT host_id FROM remote_host").get()).toBeNull();
  expect(await host.call({ operation: "initialize", config: { ...config, hostId: ulid() }, bootstrap: host.bootstrap }))
    .toMatchObject({ ok: true, value: { state: "online" } });
  expect(existsSync(join(host.credentials, "credentials.json"))).toBe(true);

  const opened = await host.call({ operation: "open_pair" });
  const qr = opened.value as PairingQr;
  const keys = generateIdentity(), pub = identityPublic(keys), deviceId = ulid();
  const context = { pairingId: qr.pairingId, hostId: qr.hostId, expiresUnix: qr.expiresUnix };
  const request = { device_id: deviceId, name: "Pixel", ua_hint: "Android", device_e_pk: base64url(pub.dh), device_s_pk: base64url(pub.signing), enrollment_pk: base64url(pub.enrollment) };
  expect((await host.post({ op: "submit", pairing_id: qr.pairingId, ciphertext: base64url(sealPairing(request, fromBase64url(qr.secret), context, Math.floor(Date.now() / 1000))) })).status).toBe(202);
  const prepared = (await host.call({ operation: "prepare_pair", pairingId: qr.pairingId })).value as { challenge: string; fingerprint: string };

  // What the LocalAuthentication sheet shows comes from the daemon, with the device's fingerprint.
  const shown = await host.call({ operation: "challenge_display", challenge: prepared.challenge });
  expect(shown.value).toEqual({ kind: "pair_device", display: expect.stringContaining(prepared.fingerprint) });
  expect(await host.call({ operation: "challenge_display", challenge: base64url(randomBytes(32)) })).toEqual({ ok: false, error: "remote_setup_denied" });
  expect(await host.call({ operation: "challenge_proof", challenge: prepared.challenge, extra: 1 })).toEqual({ ok: false, error: "remote_setup_denied" });
  const { proof } = (await host.call({ operation: "challenge_proof", challenge: prepared.challenge })).value as { proof: string };
  expect(await host.call({ operation: "confirm_pair", pairingId: qr.pairingId, proof })).toMatchObject({ ok: true, value: { deviceId } });

  // The grant is signed with the identity from the file, the one the pairing code pinned.
  const reply = await (await host.post({ op: "poll", pairing_id: qr.pairingId })).json() as { ciphertext: string };
  const grant = openPairingGrant(fromBase64url(reply.ciphertext), fromBase64url(qr.secret), context, Math.floor(Date.now() / 1000),
    fromBase64url(qr.hostSigningPublic), { hostId: qr.hostId, deviceId, deviceDhPublic: pub.dh, deviceSigningPublic: pub.signing,
      enrollmentPublic: pub.enrollment, trustEpoch: qr.trustEpoch, protocolVersion: 1, relayOrigin: ORIGIN, issuedAt: qr.issuedAt }).grant;
  expect(grant).toBeDefined();
  expect(await host.call({ operation: "list_devices" })).toMatchObject({ ok: true, value: { items: [{ id: deviceId, name: "Pixel" }] } });
});

test("an unreachable relay is told apart from a refused token", async () => {
  const host = await packagedHost();
  const controller = host.controller as unknown as { options: { fetch: typeof fetch } };
  controller.options.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  expect(await host.call({ operation: "initialize", config: { origin: ORIGIN, relayId: "fixture", hostId: HOST }, bootstrap: host.bootstrap }))
    .toEqual({ ok: false, error: "relay_unreachable" });
  expect(host.store.db.query("SELECT host_id FROM remote_host").get()).toBeNull();
});
