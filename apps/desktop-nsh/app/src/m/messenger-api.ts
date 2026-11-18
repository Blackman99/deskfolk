import type { LocalApi } from "./local-api.ts";
import type { RemoteApi } from "./remote/api.ts";

/** Shell CRUD/retry surface. Local HTTP/WS helpers stay on LocalApi only. */
export type MessengerApi = LocalApi | RemoteApi;
