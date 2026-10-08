import { HttpError } from "../../errors";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { isUlid } from "../../ids";
import type { RouteCtx } from "../route-ctx";

/** Local API routes: notifications, their policy, devices, push config, per-session preference, presence and desktop claims. */
export function notificationRoutes(ctx: RouteCtx): Response | Promise<Response> | null {
  const { options, input, scope, notificationScheduler, presence, store, method, path } = ctx;

  if (method === "POST" && path === "/v1/notifications/read") {
    const body = input.body as Record<string, unknown>;
    if (Array.isArray(body.ids)) {
      if (
        body.ids.length === 0 ||
        body.ids.length > 100 ||
        !body.ids.every((id) => typeof id === "string" && isUlid(id))
      ) {
        throw new HttpError(422, "invalid_args", "ids must be 1-100 valid ULIDs");
      }
      store.markNotificationsReadBatch({ ids: body.ids as string[] });
      return emptyResponse(204, null);
    } else if (body.through_ordinal !== undefined) {
      if (
        body.filter !== "all" ||
        typeof body.through_ordinal !== "number" ||
        !Number.isInteger(body.through_ordinal) ||
        body.through_ordinal < 0
      ) {
        throw new HttpError(
          422,
          "invalid_args",
          "through_ordinal must be a non-negative integer and filter must be 'all'",
        );
      }
      store.markNotificationsReadBatch({ through_ordinal: body.through_ordinal, filter: "all" });
      return emptyResponse(204, null);
    }
    throw new HttpError(422, "invalid_args", "must provide either ids or through_ordinal with filter 'all'");
  }

  if (method === "POST" && path === "/v1/notifications/retention-notice/read") {
    store.markRetentionNoticeRead();
    return emptyResponse(204, null);
  }

  const ackMatch = matchPath(path, "/v1/notifications/:id/acknowledge");
  if (method === "POST" && ackMatch) {
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.if_revision !== "number" ||
      !Number.isInteger(body.if_revision) ||
      body.if_revision < 0
    ) {
      throw new HttpError(422, "invalid_args", "if_revision must be a non-negative integer");
    }
    const item = store.acknowledgeNotification(ackMatch.id!, body.if_revision);
    return jsonResponse(item, 200, null);
  }

  if (method === "PATCH" && path === "/v1/notification-policy") {
    if (!options.policyV1) {
      throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision)) {
      throw new HttpError(422, "invalid_args", "if_revision is required");
    }
    const updated = store.updateNotificationPolicy(body as any);
    return jsonResponse(updated, 200, null);
  }

  if (method === "PATCH" && path === "/v1/notification-device") {
    if (!options.policyV1) {
      throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
    }
    const receiverId = scope?.deviceId && scope.deviceId !== "local" ? scope.deviceId : "desktop";
    const body = input.body as Record<string, unknown>;
    if (typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision)) {
      throw new HttpError(422, "invalid_args", "if_revision is required");
    }
    if (receiverId !== "desktop") {
      if (body.enabled !== undefined) {
        throw new HttpError(422, "invalid_args", "remote device enabled must be changed via push subscribe/unsubscribe");
      }
      if ((body.preview !== undefined && body.preview !== "generic") || (body.sound !== undefined && body.sound !== "system")) {
        throw new HttpError(422, "invalid_args", "remote devices must use generic preview and system sound");
      }
    }
    const updated = store.updateNotificationDevice(receiverId, body as any);
    return jsonResponse(updated, 200, null);
  }

  if (method === "PATCH" && path === "/v1/notifications/push-config") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision) || body.if_revision < 0) {
      throw new HttpError(422, "invalid_args", "if_revision is required");
    }
    if (!Object.hasOwn(body, "contact_uri")) {
      throw new HttpError(422, "invalid_args", "contact_uri is required");
    }
    const contactUri = body.contact_uri === null ? null : (typeof body.contact_uri === "string" ? body.contact_uri : undefined);
    if (contactUri === undefined) {
      throw new HttpError(422, "invalid_args", "contact_uri must be string or null");
    }
    const updated = store.updateNotificationPushConfig(contactUri, body.if_revision);
    return jsonResponse(updated, 200, null);
  }

  const prefMatch = matchPath(path, "/v1/sessions/:id/notification-preference");
  if (method === "PUT" && prefMatch) {
    if (!options.policyV1) {
      throw new HttpError(409, "capability_unavailable", "notification policy is unavailable in this version");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.muted !== "boolean" || typeof body.if_revision !== "number" || !Number.isInteger(body.if_revision)) {
      throw new HttpError(422, "invalid_args", "muted (boolean) and if_revision (integer) are required");
    }
    const updated = store.setSessionNotificationPreference(prefMatch.id!, body.muted, body.if_revision);
    return jsonResponse(updated, 200, null);
  }

  if (method === "POST" && path === "/v1/notification-presence") {
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.instance_id !== "string" ||
      typeof body.visible !== "boolean" ||
      typeof body.focused !== "boolean" ||
      (body.session_id !== null && body.session_id !== undefined && typeof body.session_id !== "string") ||
      typeof body.at_latest !== "boolean"
    ) {
      throw new HttpError(422, "invalid_args", "invalid presence fields");
    }
    const receiverId = scope?.deviceId && scope.deviceId !== "local" ? scope.deviceId : "desktop";
    presence?.update(receiverId, body as any);
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/claim") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.owner_id !== "string" ||
      !body.owner_id ||
      (body.permission !== "granted" && body.permission !== "denied" && body.permission !== "default")
    ) {
      throw new HttpError(422, "invalid_args", "invalid claim request fields");
    }
    const claimed = notificationScheduler?.claimDesktop(body as any);
    if (!claimed) return emptyResponse(204, null);
    return jsonResponse(claimed, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/revalidate") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (typeof body.delivery_id !== "string" || typeof body.claim_token !== "string") {
      throw new HttpError(422, "invalid_args", "delivery_id and claim_token are required");
    }
    const result = notificationScheduler?.revalidateDesktop(body as any);
    return jsonResponse(result ?? { action: "cancel" }, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/report") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (
      typeof body.delivery_id !== "string" ||
      typeof body.claim_token !== "string" ||
      (body.result !== "accepted" && body.result !== "failed" && body.result !== "unknown")
    ) {
      throw new HttpError(422, "invalid_args", "delivery_id, claim_token, and valid result are required");
    }
    notificationScheduler?.reportDesktop(body as any);
    return emptyResponse(204, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/reconcile") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const body = input.body as Record<string, unknown>;
    if (!Array.isArray(body.identifiers)) {
      throw new HttpError(422, "invalid_args", "identifiers array required");
    }
    const result = notificationScheduler?.reconcile(body as any);
    return jsonResponse(result ?? { remove_identifiers: [] }, 200, null);
  }

  if (method === "POST" && path === "/v1/notifications/desktop/test") {
    if (scope?.deviceId && scope.deviceId !== "local") {
      throw new HttpError(404, "not_found", "unknown route");
    }
    const result = notificationScheduler?.testDesktop();
    return jsonResponse(result ?? { ok: true, status: "queued" }, 200, null);
  }

  return null;
}
