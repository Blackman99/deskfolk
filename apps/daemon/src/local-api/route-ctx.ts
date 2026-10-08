import type { ClientEvent } from "@real-bot/protocol";
import type { McpHost } from "../mcp-host";
import { NotificationDeliveryScheduler, PresenceManager } from "../notifications";
import type { Store } from "../store";
import type { RequestScope } from "../store/receipts";
import type { TurnEngine } from "../turn-engine";
import type { ParsedMutation } from "./parse";
import type { LocalApiOptions } from "./types";

/** What every route group of `dispatch` gets: the request, its parsed body and the services it may use. */
export type RouteCtx = {
  request: Request;
  url: URL;
  options: LocalApiOptions;
  publish: (event: ClientEvent) => void;
  engine: TurnEngine;
  mcp: McpHost;
  input: ParsedMutation;
  scope?: RequestScope;
  notificationScheduler?: NotificationDeliveryScheduler;
  presence?: PresenceManager;
  store: Store;
  onQuit?: () => void;
  method: string;
  path: string;
};
