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

export async function startRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  const bind = options.bind ?? LOCAL_API_BIND;
  const [host, portText] = bind.split(":");
  const requestedPort = Number(portText);
  if (!host || !Number.isInteger(requestedPort) || requestedPort < 0) {
    throw new Error(`invalid bind: ${bind}`);
  }

  ensureDataDir(options.dataDir);
  const token = options.token ?? mintLocalToken();

  let server: Bun.Server<SocketData>;
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
        await server.stop(true);
      } catch {
        // serve never assigned
      }
      if (options.exitProcess) process.exit(0);
    })();
    return stopping;
  };

  // Bind first. Opening the store and marking leftover turns interrupted must
  // not run while another listener still owns the port (watch restart, a
  // health-timeout sibling spawn). Health answers as soon as the socket is
  // ours so the window does not treat boot as "down".
  server = Bun.serve<SocketData>({
    hostname: host,
    port: requestedPort,
    fetch(request, srv) {
      if (api) return api.fetch(request, srv);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        return Response.json({ ok: true, name: LOCAL_API_NAME });
      }
      return new Response(null, { status: 503 });
    },
    websocket: {
      data: { authed: false },
      open(ws) {
        api?.websocket.open(ws);
      },
      message(ws, message) {
        api?.websocket.message(ws, message);
      },
      close(ws) {
        api?.websocket.close(ws);
      },
    },
    error() {
      return Response.json({ error: { code: "failed", message: "internal error" } }, { status: 500 });
    },
  });

  const port = server.port;
  if (port === undefined) {
    await server.stop(true);
    throw new Error("server did not bind a port");
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
    await server.stop(true);
    throw error;
  }

  return {
    origin: `http://${server.hostname}:${port}`,
    port,
    token,
    dataDir: options.dataDir,
    discoveryPath: descriptorPath(options.dataDir),
    store,
    stop,
  };
}
