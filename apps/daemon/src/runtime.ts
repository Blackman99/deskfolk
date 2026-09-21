import { LOCAL_API_BIND, LOCAL_API_NAME } from "@real-bot/protocol";
import {
  descriptorPath,
  ensureDataDir,
  mintLocalToken,
  removeDescriptor,
  stateDbPath,
  writeDescriptor,
} from "./descriptor";
import { createLocalApi } from "./local-api";
import { bunKeyStore } from "./secrets";
import { Store, type EndpointKeyStore } from "./store";
import type { CompletionsClient } from "./completions";
import { RemoteController } from "./remote/controller";
import { inheritedLocalSetup } from "./remote/local-setup";
import { createDevRemote } from "./remote/dev-setup";
import { RuntimeLifecycle } from "./lifecycle";
import { recoverLifecycle } from "./remote/lifecycle";
import { restartAvailable, runtimeVersion, type MaintenanceControl } from "./remote/maint";

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
        closeSetup?.();
        closeDevSetup?.();
        remote?.stop();
        api?.quiesce.close();
        api?.scheduler?.stop();
        await api?.engine.close();
        store?.interruptRunningTurns();
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
    store.recoverInterruptedTurns();
    recoverLifecycle(store);
    api = createLocalApi({
      store,
      token,
      completions: options.completions,
      schedule: options.schedule,
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
    // Source runs with REAL_BOT_DEV_REMOTE=1 swap in file-backed credentials so the
    // protocol can be exercised before G-pack; a compiled daemon never gets one.
    const dev = createDevRemote(options.dataDir);
    remote = new RemoteController({ store, api, maint, native: dev?.native,
      config: metadata ? { hostId: metadata.host_id, origin: metadata.relay_origin, relayId: metadata.relay_id } : undefined });
    if (options.desktopRemoteChannel) {
      closeSetup = await inheritedLocalSetup(remote, () => { windowAlive = false; });
      windowAlive = Boolean(closeSetup);
    }
    if (dev) closeDevSetup = dev.listen(remote);
    await remote.start();
    // Chains the previous run left open go through review now; their timers died with it.
    api.engine.sweepStaleChains();
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
