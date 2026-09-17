import { LOCAL_API_BIND } from "@real-bot/protocol";
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
  const store = new Store({
    filename: stateDbPath(options.dataDir),
    endpointKey: options.endpointKey ?? bunKeyStore,
  });

  let server: Bun.Server<{ authed: boolean }>;
  let stopping: Promise<void> | null = null;
  let api: ReturnType<typeof createLocalApi>;

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        api?.scheduler?.stop();
        await api?.engine.close();
        store.interruptRunningTurns();
      } catch {
        // boot failed before schema
      }
      removeDescriptor(options.dataDir);
      store.close();
      await server.stop(true);
      if (options.exitProcess) process.exit(0);
    })();
    return stopping;
  };

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

  server = Bun.serve({
    hostname: host,
    port: requestedPort,
    fetch: api.fetch,
    websocket: api.websocket,
    error() {
      return Response.json({ error: { code: "failed", message: "internal error" } }, { status: 500 });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("server did not bind a port");

  writeDescriptor(options.dataDir, {
    pid: process.pid,
    port,
    token,
    started_at: new Date().toISOString(),
  });

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
