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

type SocketData = { authed: boolean };

export type RuntimeOptions = {
  dataDir: string;
  bind?: string;
  token?: string;
  endpointKey?: EndpointKeyStore;
  onQuit?: () => void;
  exitProcess?: boolean;
};

export type RuntimeHandle = {
  origin: string;
  port: number;
  token: string;
  dataDir: string;
  discoveryPath: string;
  store: Store;
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
  const token = options.token ?? mintLocalToken();

  let server: Bun.Server<SocketData>;
  let companion: Bun.Server<SocketData> | undefined;
  let stopping: Promise<void> | null = null;
  let api: ReturnType<typeof createLocalApi> | undefined;
  let store: Store | undefined;

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
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
    api = createLocalApi({
      store,
      token,
      onQuit: () => {
        options.onQuit?.();
        removeDescriptor(options.dataDir);
        setTimeout(() => {
          void stop();
        }, 0);
      },
    });
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
    stop,
  };
}
