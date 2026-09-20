import type { Store } from "../store";
import type { LocalApi } from "../local-api";

/** A crash does not replay an authorized force or claim that a volatile drain survived. */
export function recoverLifecycle(store: Store): void {
  store.transaction(() => {
    store.db.run(`UPDATE request_receipts SET status = 409, body = ? WHERE EXISTS
      (SELECT 1 FROM remote_lifecycle i WHERE i.device_id = request_receipts.device_id AND i.request_id = request_receipts.request_id)`,
    [JSON.stringify({ error: { code: "lifecycle_unknown", message: "lifecycle result unknown after restart" } })]);
    store.db.run("DELETE FROM remote_lifecycle");
  });
}
export async function finishLifecycle(store: Store, api: LocalApi, scope: { deviceId: string; requestId: string }, action: string): Promise<Response> {
  let status = 204, body: string | null = null;
  try {
    if (action === "quiesce.begin") api.quiesce.begin();
    else if (action === "quiesce.cancel") api.quiesce.cancel();
    else if (action === "quiesce.force") {
      api.quiesce.force();
      const state = await api.quiesce.wait();
      if (state.phase !== "drained" || !state.forced) throw new Error("force cancelled");
    }
    else throw new Error("lifecycle action");
  } catch {
    status = 503;
    body = JSON.stringify({ error: { code: "lifecycle_failed", message: "lifecycle effect failed" } });
  }
  store.transaction(() => {
    store.db.run("UPDATE request_receipts SET status = ?, body = ? WHERE device_id = ? AND request_id = ?", [status, body, scope.deviceId, scope.requestId]);
    store.db.run("DELETE FROM remote_lifecycle WHERE device_id = ? AND request_id = ?", [scope.deviceId, scope.requestId]);
  });
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}
