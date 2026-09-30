import { LOCAL_API_BIND, LOCAL_API_NAME } from "@real-bot/protocol";
import {
  defaultDataDir,
  descriptorPath,
  ensureDataDir,
  mintLocalToken,
  removeDescriptor,
  stateDbPath,
  writeDescriptor,
} from "./descriptor";
import type { Ablation } from "./ablation";
import { createLocalApi } from "./local-api";
import { HttpError } from "./errors";
import { bunKeyStore } from "./secrets";
import { Store, type EndpointKeyStore } from "./store";
import type { CompletionsClient } from "./completions";
import { RemoteController } from "./remote/controller";
import { inheritedLocalSetup } from "./remote/local-setup";
import { createDevRemote, devPairingDispatch } from "./remote/dev-setup";
import { shippedRemoteNative } from "./remote/file-native";
import { RuntimeLifecycle } from "./lifecycle";
import { recoverLifecycle } from "./remote/lifecycle";
import { restartAvailable, runtimeVersion, type MaintenanceControl } from "./remote/maint";
import { stopOrphanProcs } from "./live-procs";
import { sharedInstalledVersion } from "./installed-app";
import { isCompiledBinary } from "./platform";
import { logStartup } from "./startup-log";

type SocketData = { authed: boolean };

export type RuntimeOptions = {
  dataDir: string;
  bind?: string;
  token?: string;
  endpointKey?: EndpointKeyStore;
  completions?: CompletionsClient;
  schedule?: boolean;
  onQuit?: () => void;
  exitProcess?: boolean;
  desktopRemoteChannel?: boolean;
  supervisor?: import("./quiesce").SupervisorControl["kind"];
  onHandoff?: () => void;
  onRuntimeStop?: () => void;
  /** Side-calls switched off for a benchmark (see `ablation.ts`). `main.ts` never sets it. */
  ablation?: Ablation;
};

export type RuntimeHandle = {
  origin: string;
  port: number;
  token: string;
  dataDir: string;
  discoveryPath: string;
  store: Store;
  remote: RemoteController;
  lifecycle: RuntimeLifecycle;
  quiesce: import("./quiesce").Quiesce;
  stop: () => Promise<void>;
};

function parseBind(bind: string): { host: string; port: number } {
  if (bind.startsWith("[")) {
    const end = bind.indexOf("]");
    if (end === -1) throw new Error(`invalid bind: ${bind}`);
    const host = bind.slice(1, end);
    const rest = bind.slice(end + 1);
    if (!rest.startsWith(":")) throw new Error(`invalid bind: ${bind}`);
    const port = Number(rest.slice(1));
    if (!host || !Number.isInteger(port) || port < 0) throw new Error(`invalid bind: ${bind}`);
    return { host, port };
  }
  const [host, portText] = bind.split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 0) {
    throw new Error(`invalid bind: ${bind}`);
  }
  return { host, port };
}

function originFor(host: string, port: number): string {
  const shown = host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

function companionLoopback(host: string): string | null {
  if (host === "127.0.0.1") return "::1";
  if (host === "::1") return "127.0.0.1";
  return null;
}

export async function startRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  const bind = options.bind ?? LOCAL_API_BIND;
  const { host, port: requestedPort } = parseBind(bind);

  ensureDataDir(options.dataDir);
  const lifecycle = new RuntimeLifecycle(options.dataDir, options.supervisor ?? "none");
  if (lifecycle.kind === "standalone" && lifecycle.isStopped()) {
    throw new Error("runtime is stopped");
  }
  const token = options.token ?? mintLocalToken();

  let server: Bun.Server<SocketData>;
  let companion: Bun.Server<SocketData> | undefined;
  let stopping: Promise<void> | null = null;
  let api: ReturnType<typeof createLocalApi> | undefined;
  let store: Store | undefined;
  let remote: RemoteController | undefined;
  let closeSetup: (() => void) | undefined;
  let closeDevSetup: (() => void) | undefined;
  let windowAlive = false;
  let busy: MaintenanceControl["busy"] = null;
  const maint: MaintenanceControl = {
    version: runtimeVersion(),
    lifecycle,
    windowAlive: () => windowAlive,
    busy: null,
    requestExit: (reason) => {
      if (busy) return;
      busy = reason;
      maint.busy = reason;
      removeDescriptor(options.dataDir);
      setTimeout(() => { void stop(); }, 0);
    },
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        // Every path that reaches `stop()` — quit, `/v1/runtime/stop`, handoff, a remote
        // restart/stop, SIGINT/SIGTERM — is a deliberate shutdown; a crash never calls this
        // function, which is the whole point of writing the flag (schema-gate.ts). It has to be
        // written here, before the steps below, not after: closing a stdio MCP session can wait up
        // to its configured `shutdownWaitMs`, and the window's own quit handler kills the daemon
        // outright 200ms after asking for this stop, which would otherwise beat a write placed
        // after the slow parts and read back as a crash on the next boot.
        store?.recordCleanShutdown();
      } catch {
        // best effort; the process still exits below either way
      }
      try {
        closeSetup?.();
        closeDevSetup?.();
        remote?.stop();
        api?.quiesce.close();
        api?.scheduler?.stop();
        // Stop the shells before the store closes. Their rows stay, so the next start puts them back.
        api?.terminals.shutdown();
        await api?.engine.close();
        store?.interruptRunningTurns((turnId) => api?.engine.executionOf(turnId) ?? null);
      } catch {
        // boot failed before schema
      }
      removeDescriptor(options.dataDir);
      try {
        store?.close();
      } catch {
        // already closed
      }
      try {
        await companion?.stop(true);
      } catch {
        // companion never assigned
      }
      try {
        await server.stop(true);
      } catch {
        // serve never assigned
      }
      if (options.exitProcess) process.exit(0);
    })();
    return stopping;
  };

  const serveOptions = {
    fetch(request: Request, srv: Bun.Server<SocketData>) {
      if (api) return api.fetch(request, srv);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return Response.json({ ok: true, name: LOCAL_API_NAME });
      }
      return new Response(null, { status: 503 });
    },
    websocket: {
      data: { authed: false },
      open(ws: Bun.ServerWebSocket<SocketData>) {
        api?.websocket.open(ws);
      },
      message(ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) {
        api?.websocket.message(ws, message);
      },
      close(ws: Bun.ServerWebSocket<SocketData>) {
        api?.websocket.close(ws);
      },
    },
    error() {
      return Response.json({ error: { code: "failed", message: "internal error" } }, { status: 500 });
    },
  };

  // Bind first. Opening the store and marking leftover turns interrupted must
  // not run while another listener still owns the port (watch restart, a
  // health-timeout sibling spawn). Health answers as soon as the socket is
  // ours so the window does not treat boot as "down".
  server = Bun.serve<SocketData>({
    hostname: host,
    port: requestedPort,
    ...serveOptions,
  });

  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    throw new Error("server did not bind a port");
  }

  const companionHost = companionLoopback(host);
  if (companionHost) {
    try {
      companion = Bun.serve<SocketData>({
        hostname: companionHost,
        port,
        ...serveOptions,
      });
    } catch {
      companion = undefined;
    }
  }

  try {
    store = new Store({
      filename: stateDbPath(options.dataDir),
      endpointKey: options.endpointKey ?? bunKeyStore,
    });
    const bootLog = (line: string) => {
      console.error(line);
      logStartup(options.dataDir, line);
    };
    // ADR 0040's engine level goes up only once no installed app that shares this data folder
    // would misread what the next level writes; until then the daemon runs the level it is at.
    const engine = store.raiseEngineLevel(
      sharedInstalledVersion({ dataDir: options.dataDir, defaultDataDir: defaultDataDir(), compiled: isCompiledBinary(import.meta.path) }),
    );
    if (engine.refused) bootLog(engine.refused);
    // Plans parked before holds existed become holds, and whatever a hold covers is held again.
    const held = store.reconcileHolds();
    if (held.imported.length > 0) bootLog(`took over ${held.imported.length} parked plan(s) as holds: ${held.imported.join(", ")}`);
    if (held.reparked.length > 0) bootLog(`parked again under their holds: ${held.reparked.join(", ")}`);
    store.recoverInterruptedTurns();
    store.recoverInterruptedCheckRuns();
    // Commands the previous run's turns started may still be running (a render writing into the
    // workspace, say); their turns were just marked interrupted, so nothing is left to want them.
    // Not awaited: a group gets 3 s between SIGTERM and SIGKILL, and boot does not wait on that.
    void stopOrphanProcs(store, { log: bootLog }).catch(() => {});
    recoverLifecycle(store);
    // Remote credentials live in a file (ADR 0033). The compiled daemon always uses it and confirms
    // through its window; source runs only with REAL_BOT_DEV_REMOTE=1, confirming by stand-in.
    const dev = createDevRemote(options.dataDir);
    // A Windows window has no setup channel or confirmation sheet to give remote access yet, so its
    // packaged daemon keeps the sealed provider, whose status tells the settings card as much.
    const shipped = dev || process.platform === "win32" ? undefined : shippedRemoteNative(options.dataDir);
    const devPairing = dev ? devPairingDispatch(dev.native) : undefined;
    api = createLocalApi({
      store,
      token,
      dataDir: options.dataDir,
      policyV1: true,
      pushSettingsV2: true,
      devSetup: devPairing && (async (request) => {
        if (!remote) throw new HttpError(503, "unavailable", "runtime is still starting");
        return devPairing(remote, request);
      }),
      completions: options.completions,
      schedule: options.schedule,
      ablation: options.ablation,
      remoteStatus: () => remote?.status() ?? { state: "off", diagnostic: null, devices: 0 },
      onQuit: () => {
        options.onQuit?.();
        removeDescriptor(options.dataDir);
        setTimeout(() => {
          void stop();
        }, 0);
      },
      runtimeInfo: () => ({
        pid: process.pid,
        bind: LOCAL_API_BIND,
        version: maint.version,
        mode: lifecycle.kind,
        stopped: lifecycle.isStopped(),
        restart: restartAvailable(lifecycle, () => windowAlive) ? "available" : "unavailable",
      }),
      lifecycle,
      onHandoff: () => {
        options.onHandoff?.();
        removeDescriptor(options.dataDir);
        setTimeout(() => {
          void stop();
        }, 0);
      },
      onRuntimeStop: () => {
        options.onRuntimeStop?.();
        removeDescriptor(options.dataDir);
        setTimeout(() => {
          void stop();
        }, 0);
      },
    });
    const metadata = store.db.query<{ host_id: string; relay_origin: string; relay_id: string }, []>("SELECT host_id, relay_origin, relay_id FROM remote_host WHERE singleton = 1").get();
    remote = new RemoteController({ store, api, maint, native: dev?.native ?? shipped,
      config: metadata ? { hostId: metadata.host_id, origin: metadata.relay_origin, relayId: metadata.relay_id } : undefined });
    if (options.desktopRemoteChannel) {
      closeSetup = await inheritedLocalSetup(remote, () => { windowAlive = false; }, shipped);
      windowAlive = Boolean(closeSetup);
    }
    if (dev) closeDevSetup = dev.listen(remote);
    await remote.start();
    // Chains the previous run left open go through review now; their timers died with it.
    api.engine.sweepStaleChains();
    // The spill of jobs that ended a week ago is dead weight; a boot is the natural time to drop it.
    api.engine.sweepToolResults();
    writeDescriptor(options.dataDir, {
      pid: process.pid,
      port,
      token,
      started_at: new Date().toISOString(),
    });
  } catch (error) {
    try {
      store?.close();
    } catch {
      // ignore
    }
    try {
      await companion?.stop(true);
    } catch {
      // ignore
    }
    await server.stop(true);
    throw error;
  }

  return {
    origin: originFor(host, port),
    port,
    token,
    dataDir: options.dataDir,
    discoveryPath: descriptorPath(options.dataDir),
    store,
    remote: remote!,
    lifecycle,
    quiesce: api!.quiesce,
    stop,
  };
}
