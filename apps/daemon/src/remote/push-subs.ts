/** Stored push subscriptions. */
import type { Store } from "../store";
import { endpointHash, type PushSubscribeMaterials } from "./push-endpoint";

export type PushSub = {
  device_id: string;
  endpoint: string;
  endpoint_hash: string;
  p256dh: string;
  auth: string;
  expires_at: number | null;
  generation: number;
  vapid_fingerprint: string | null;
  last_diagnostics: string | null;
  created_at: number;
};

export function upsertPushSub(
  store: Store,
  deviceId: string,
  input: PushSubscribeMaterials,
  now: number,
  generation: number = 1,
  vapidFingerprint: string | null = null,
): void {
  const expires = input.expires_at === undefined ? null : input.expires_at;
  store.db.run(
    `INSERT INTO remote_push_subs(device_id, endpoint, endpoint_hash, p256dh, auth, expires_at, generation, vapid_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       endpoint = excluded.endpoint, endpoint_hash = excluded.endpoint_hash,
       p256dh = excluded.p256dh, auth = excluded.auth, expires_at = excluded.expires_at,
       generation = excluded.generation, vapid_fingerprint = excluded.vapid_fingerprint`,
    [
      deviceId,
      input.endpoint,
      endpointHash(input.endpoint),
      input.p256dh,
      input.auth,
      expires,
      generation,
      vapidFingerprint,
      now,
    ],
  );
}

export function deletePushSubs(store: Store, deviceId: string | null): void {
  store.transaction(() => {
    store.db.run("DELETE FROM remote_push_subs WHERE ? IS NULL OR device_id = ?", [deviceId, deviceId]);
    if (deviceId === null) {
      store.db.run(
        `UPDATE notification_devices
         SET enabled = 0, push_generation = push_generation + 1, revision = revision + 1
         WHERE receiver_id != 'desktop'`,
      );
      store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE channel = 'remote_push' AND state IN ('pending', 'claimed', 'retry_wait')`,
      );
    } else {
      store.db.run(
        `UPDATE notification_devices
         SET enabled = 0, push_generation = push_generation + 1, revision = revision + 1
         WHERE receiver_id = ?`,
        [deviceId],
      );
      store.db.run(
        `UPDATE notification_deliveries
         SET state = 'suppressed'
         WHERE receiver_id = ? AND channel = 'remote_push' AND state IN ('pending', 'claimed', 'retry_wait')`,
        [deviceId],
      );
    }
  });
}

export function pushSub(store: Store, deviceId: string): PushSub | null {
  return store.db.query<PushSub, [string]>("SELECT * FROM remote_push_subs WHERE device_id = ?").get(deviceId);
}

export function livePushSubs(store: Store, now: number): PushSub[] {
  return store.db
    .query<PushSub, [number]>(
      "SELECT * FROM remote_push_subs WHERE expires_at IS NULL OR expires_at > ?",
    )
    .all(now);
}
