import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { RemoteApi } from "./api.ts";
import type { StoredEnrollment } from "./idb.ts";
import { base64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";
import SettingsModal from "../settings/SettingsModal.svelte";
import { copyFor } from "../copy.ts";
import { fakeRuntime } from "../test-fixtures.ts";
import { click, render } from "../test-render.ts";
import { reactive } from "../test-reactive.svelte.ts";

const keys = generateIdentity();
const pub = identityPublic(keys);
const challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const enrollment: StoredEnrollment = {
  v: 1,
  deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  relayOrigin: "https://relay.example.test",
  relayId: "fixture",
  trustEpoch: 1,
  hostDhPublic: base64url(pub.dh),
  hostSigningPublic: base64url(pub.signing),
  dh: base64url(keys.dh),
  signing: base64url(keys.signing),
  enrollment: base64url(keys.enrollment),
  name: "Fixture",
};

test("restart and stop use UV and never mint a second id on reconnect", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      if (request.path === "/remote/uv/challenge") return { v: 1, id: request.id, status: 200, body: { challenge } };
      if (request.path.startsWith("/v1/requests/")) return { v: 1, id: request.id, status: 200, body: { ok: true } };
      throw new Error("disconnected");
    },
    webauthn: {
      create: async () => { throw new Error("unused"); },
      get: async () => { throw new Error("uv denied"); },
    },
  });
  await expect(api.privilegedAction({ action: "runtime.restart", targetId: "runtime" })).rejects.toThrow();
  expect(calls.some((row) => row.path === "/remote/runtime/restart")).toBe(false);
  const denied = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      if (request.path === "/remote/uv/challenge") return { v: 1, id: request.id, status: 200, body: { challenge } };
      throw new Error("disconnected");
    },
    webauthn: {
      create: async () => { throw new Error("unused"); },
      get: async () => assertionCred(),
    },
  });
  await expect(denied.privilegedAction({ action: "runtime.stop", targetId: "runtime" })).rejects.toMatchObject({ code: "request_unknown" });
  const original = denied.pendingRequests()[0]!;
  expect(original.path).toBe("/remote/runtime/stop");
  const recovered = new RemoteApi(enrollment, {
    rpc: async (request) => {
      if (request.path === `/v1/requests/${original.id}`) return { v: 1, id: request.id, status: 200, body: { ok: true, latch: true } } satisfies RemoteResponse;
      throw new Error("no second mutation");
    },
  }, denied.durablePending());
  expect(await recovered.retryPending(original.id)).toEqual({ ok: true, latch: true });
});

test("force restart sends force true on a distinct UV challenge", async () => {
  const calls: RemoteRequest[] = [];
  const api = new RemoteApi(enrollment, {
    rpc: async (request) => {
      calls.push(request);
      if (request.path === "/remote/uv/challenge") {
        expect((request.body as { force?: boolean }).force).toBe(true);
        return { v: 1, id: request.id, status: 200, body: { challenge } };
      }
      if (request.path === "/remote/runtime/restart") {
        expect((request.body as { force?: boolean }).force).toBe(true);
        return { v: 1, id: request.id, status: 200, body: { ok: true, forced: true, latch: false } };
      }
      throw new Error(request.path);
    },
    webauthn: {
      create: async () => { throw new Error("unused"); },
      get: async () => assertionCred(),
    },
  });
  await api.privilegedAction({ action: "runtime.restart", targetId: "runtime", force: true });
  expect(calls.map((row) => row.path)).toEqual(["/remote/uv/challenge", "/remote/runtime/restart"]);
});

function assertionCred(): Credential {
  return {
    type: "public-key",
    id: "cred",
    rawId: new Uint8Array(8),
    response: {
      clientDataJSON: new Uint8Array(8),
      authenticatorData: new Uint8Array(8),
      signature: new Uint8Array(8),
    },
  } as unknown as Credential;
}

test("maintenance settings show status, diagnostics, drain, force confirm, revoke and reconnect error", () => {
  const runtime = reactive(fakeRuntime({}, {
    settingsOpen: true,
    remote: true,
    uvReady: true,
    maintenance: {
      version: "0.1.0-rc.2",
      mode: "window",
      reachability: "online",
      restart: "available",
      stopped: false,
      drain: { phase: "draining", remaining: 2, forced: false },
      devices: [
        { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "This", revoked: false, hasUv: true, lastActiveAt: 1_700_000_000 },
        { id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", name: "Travel phone", revoked: false, hasUv: true, lastActiveAt: 1_700_000_000 },
      ],
    },
    otherRemoteDevices: () => [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", name: "Travel phone", revoked: false, hasUv: true, lastActiveAt: 1_700_000_000 }],
  }));
  const { host, close } = render(SettingsModal, {
    runtime,
    t: copyFor("en"),
    saveFailed: false,
    providerEditor: null,
    confirmingProvider: false,
    patchImmediate: async () => true,
    openDeleteProviderConfirm: () => {},
    closeSettings: () => {},
  });
  expect(host.querySelector("[data-testid=remote-maintenance]")?.textContent).toContain("Maintenance");
  expect(host.querySelector("[data-testid=remote-version]")?.textContent).toContain("0.1.0-rc.2");
  expect(host.querySelector("[data-testid=remote-drain]")?.textContent).toContain("2 live turns");
  expect((host.querySelector("[data-testid=remote-diagnostics]") as HTMLButtonElement).disabled).toBe(false);
  expect((host.querySelector("[data-testid=remote-drain-restart]") as HTMLButtonElement).disabled).toBe(false);
  click(host.querySelector("[data-testid=remote-force-restart]"));
  expect(host.querySelector("[data-testid=remote-force-confirm]")?.textContent).toContain("Confirm force restart");
  click(host.querySelector("[data-testid=remote-stop]"));
  expect(host.querySelector("[data-testid=remote-stop-confirm]")?.textContent).toContain("Confirm stop");
  click(host.querySelector("[data-testid=remote-revoke-01ARZ3NDEKTSV4RRFFQ69G5FAW]"));
  expect(host.querySelector("[data-testid=remote-revoke-confirm-01ARZ3NDEKTSV4RRFFQ69G5FAW]")?.textContent).toContain("Travel phone");
  runtime.maintenanceError = "request_unknown";
  flushSync();
  expect(host.querySelector("[data-testid=remote-maintenance-error]")?.textContent).toContain("same receipt");
  close();
});

test("unavailable supervisor copy and draining error are explicit", () => {
  const runtime = reactive(fakeRuntime({}, {
    settingsOpen: true,
    maintenance: {
      version: "0.1.0-rc.2",
      mode: "none",
      reachability: "online",
      restart: "unavailable",
      stopped: false,
      drain: { phase: "running", remaining: 0, forced: false },
      devices: [],
    },
    maintenanceError: "restart_unavailable",
    otherRemoteDevices: () => [],
  }));
  runtime.remote = true;
  runtime.uvReady = true;
  const { host, close } = render(SettingsModal, {
    runtime,
    t: copyFor("en"),
    saveFailed: false,
    providerEditor: null,
    confirmingProvider: false,
    patchImmediate: async () => true,
    openDeleteProviderConfirm: () => {},
    closeSettings: () => {},
  });
  expect(host.querySelector("[data-testid=remote-restart]")?.textContent).toContain("window is gone");
  expect(host.querySelector("[data-testid=remote-drain-restart]")?.hasAttribute("disabled")).toBe(true);
  expect(host.querySelector("[data-testid=remote-maintenance-error]")?.textContent).toContain("No supervisor");
  close();
});
