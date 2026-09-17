import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APP_SUPPORT_DIRNAME,
  LOCAL_API_DESCRIPTOR_NAME,
  LOCAL_API_DISCOVERY_PATH,
  LOCAL_API_NAME,
} from "@real-bot/protocol";
import type { Plugin } from "vite";

/** Dev-only: read the daemon's local-api.json and return `{ name, port, token }`. Not bundled. */
export function localApiDiscovery(): Plugin {
  return {
    name: "real-bot-local-api-discovery",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path !== LOCAL_API_DISCOVERY_PATH) {
          next();
          return;
        }
        const dataDir =
          process.env.REAL_BOT_DATA_DIR ??
          join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME);
        const file = join(dataDir, LOCAL_API_DESCRIPTOR_NAME);
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8")) as { port?: unknown; token?: unknown };
          if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
            throw new Error("bad descriptor");
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ name: LOCAL_API_NAME, port: parsed.port, token: parsed.token }));
        } catch {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              name: LOCAL_API_NAME,
              error: { code: "not_found", message: "runtime not running" },
            }),
          );
        }
      });
    },
  };
}
