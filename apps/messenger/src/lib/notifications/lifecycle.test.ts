import { expect, test, describe } from "bun:test";
import { MessengerRuntime } from "../runtime.svelte.ts";
import { emptySnapshot } from "../snapshot.ts";
import { EventSync, MAX_NOTIFICATION_TAIL } from "../event-sync.ts";
import { ApiError } from "../api.ts";
import { RemoteApi } from "../remote/api.ts";
import type { StoredEnrollment } from "../remote/idb.ts";
import { base64url, fromBase64url, generateIdentity, identityPublic, type RemoteRequest, type RemoteResponse } from "@real-bot/remote";
import type {
  NotificationCapabilities,
  NotificationPolicy,
  NotificationSummary,
  RuntimeSnapshot,
} from "@real-bot/protocol";

describe("Notifications Production Lifecycle", () => {
  test("installSnapshot ingests notification capabilities, summary, and policy into runtime", async () => {
    const runtime = new MessengerRuntime();
    const sync = new EventSync();

    const capabilities: NotificationCapabilities = {
      inbox_v1: true,
      bounded_read_v1: true,
      pending_ask_v1: true,
      policy_v1: true,
      push_settings_v2: true,
    };

    const summary: NotificationSummary = {
      unread_count: 5,
      open_count: 2,
      attention_count: 6,
    };

    const policy: NotificationPolicy = {
      revision: 3,
      categories: {
        approval: true,
        ask: true,
        failure: true,
        interrupted: true,
        reply: false,
        routine_result: true,
      },
      quiet_hours: {
        enabled: true,
        start: "23:00",
        end: "07:00",
        time_zone: "Asia/Shanghai",
      },
    };

    const rawSnapshot: RuntimeSnapshot = {
      ...emptySnapshot(),
      event_instance_id: "11111111111111111111111111111111",
      watermark_seq: 1,
      settings: {
        theme: "system",
        locale: "zh",
        workspace_path: "/tmp/test",
        wizard_complete: true,
        endpoint_base_url: "",
        endpoint_models: [],
        endpoint_default_model: "",
        default_provider_id: null,
        launch_at_login: false,
        endpoint_key_set: false,
        endpoint_model_catalog: [],
      },
      sessions: [
        {
          id: "s1",
          kind: "direct",
          name: null,
          created_at: "2026-09-22T00:00:00Z",
          updated_at: "2026-09-22T00:00:00Z",
          origin_session_id: null,
          origin_message_id: null,
          participants: [],
          unread_count: 4,
          notification_preference: { muted: true, revision: 1 },
        } as any,
      ],
      notificationCapabilities: capabilities,
      notificationSummary: summary,
      notificationPolicy: policy,
    };

    const fakeApi = {
      kind: "local" as const,
      observeSnapshot: () => {},
      hasPendingRequest: () => false,
    };

    (runtime as any).api = fakeApi;
    (runtime as any).sync = sync;

    // Exercise real installSnapshot method
    await (runtime as any).installSnapshot(fakeApi, sync, rawSnapshot);

    expect(runtime.connection).toBe("connected");
    expect(runtime.notificationCapabilities).toEqual(capabilities);
    expect(runtime.notificationSummary).toEqual(summary);
    expect(runtime.notificationPolicy).toEqual(policy);

    // Session unread count and notification preference preserved
    const sess = runtime.snapshot.sessions.find((s) => s.id === "s1");
    expect(sess?.unread_count).toBe(4);
    expect(runtime.isSessionMuted("s1")).toBe(true);
  });

  test("session mute uses PUT and updates local snapshot on success", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.snapshot = {
      ...runtime.snapshot,
      sessions: [
        {
          id: "s1",
          kind: "direct",
          name: null,
          created_at: "2026-09-22T00:00:00Z",
          updated_at: "2026-09-22T00:00:00Z",
          origin_session_id: null,
          origin_message_id: null,
          participants: [],
          unread_count: 2,
          notification_preference: { muted: false, revision: 1 },
        } as any,
      ],
    };

    let putBody: any = null;
    let putSessionId: string | null = null;
    (runtime as any).api = {
      putSessionNotificationPreference: async (sessionId: string, body: any) => {
        putSessionId = sessionId;
        putBody = body;
        return { muted: body.muted, revision: body.if_revision + 1 };
      },
    };

    expect(runtime.isSessionMuted("s1")).toBe(false);
    await runtime.setSessionMuted("s1", true);

    expect(putSessionId).toBe("s1");
    expect(putBody).toEqual({ muted: true, if_revision: 1 });
    expect(runtime.isSessionMuted("s1")).toBe(true);
  });

  test("unknown ask retry retains original requestId and draft version, pendingId has no fallback", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.selectedId = "s1";
    runtime.notificationCapabilities = {
      inbox_v1: true,
      bounded_read_v1: true,
      pending_ask_v1: true,
      policy_v1: true,
      push_settings_v2: true,
    };

    // Case 1: Ask is NOT in turns -> pendingId must be null (no fallback to askId), so askSubmitAllowed rejects it
    runtime.snapshot.turns = [];
    const denied = await runtime.sendAsk("ask-outdated", { custom: "answer" });
    expect(denied.status).toBe("not_submitted");
    expect((denied as any).reason).toBe("stale_ask");

    // Case 2: Ask is active -> submit succeeds
    runtime.snapshot.turns = [
      {
        id: "turn-1",
        session_id: "s1",
        status: "waiting_ask",
        pending_ask_id: "ask-active",
      } as any,
    ];

    let postCalls: any[] = [];
    (runtime as any).api = {
      hasPendingRequest: () => false,
      answerAsk: async (id: string, answer: any, opts: any) => {
        postCalls.push({ id, answer, opts });
        throw new ApiError(503, "request_unknown", "network dropped", "req-orig-123");
      },
    };

    // First attempt gets unknown
    const res1 = await runtime.sendAsk("ask-active", { selected: ["Yes"], custom: "answer 1" });
    expect(res1.status).toBe("unknown");
    expect(res1.request_id).toBe("req-orig-123");

    // Draft record retains requestId
    const draft = runtime.getAskDraft("ask-active");
    expect(draft?.requestId).toBe("req-orig-123");

    // Second attempt (retry) passes the same requestId
    (runtime as any).api.answerAsk = async (id: string, answer: any, opts: any) => {
      postCalls.push({ id, answer, opts });
      return { id: "ask-active", request_id: opts.requestId };
    };

    const res2 = await runtime.sendAsk("ask-active", { selected: ["Yes"], custom: "answer 1" });
    expect(res2.status).toBe("accepted");
    expect(res2.request_id).toBe("req-orig-123");
    expect(postCalls[1]).toMatchObject({ id: "ask-active", answer: { selected: ["Yes"], custom: "answer 1" }, opts: { requestId: "req-orig-123" } });

    runtime.setAskDraft("ask-active", "answer 2");
    expect(runtime.getAskDraft("ask-active")?.requestId).toBeUndefined();
  });

  test("SW message verifies source without disconnecting and returns to the chat list", () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.selectedId = "sess-open";

    const origNavigator = globalThis.navigator;
    const fakeController = {};
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          controller: fakeController,
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      },
    });

    try {
      // Message from unknown source should be ignored
      (runtime as any).onPushMessage({ data: { type: "inbox" }, source: {} });
      expect(runtime.selectedId).toBe("sess-open");
      expect(runtime.connection).toBe("connected");

      // Without a Shell handler the runtime still leaves the open conversation and stays connected.
      (runtime as any).onPushMessage({ data: { type: "inbox" }, source: fakeController });
      expect(runtime.selectedId).toBeNull();
      expect(runtime.connection).toBe("connected");
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: origNavigator });
    }
  });

  test("batch read marking marks multiple items and does not prematurely clear open attention count", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.notificationSummary = {
      unread_count: 2,
      open_count: 1,
      attention_count: 2,
    };
    runtime.notificationInboxState = {
      filter: "all",
      generation: 1,
      instanceId: "inst",
      watermark: 1,
      upperOrdinal: 10,
      items: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          ordinal: 1,
          semantic_key: "approval:1",
          kind: "approval",
          created_at: "2026-09-22T00:00:00Z",
          read_at: null,
          action_state: "open",
          revision: 1,
          display: { title: "Approval", summary: "" },
          target: {},
        } as any,
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
          ordinal: 2,
          semantic_key: "reply:2",
          kind: "reply",
          created_at: "2026-09-22T00:00:00Z",
          read_at: null,
          action_state: "none",
          revision: 1,
          display: { title: "Reply", summary: "" },
          target: {},
        } as any,
      ],
      next: null,
      summary: runtime.notificationSummary,
      loading: false,
      loadingMore: false,
      error: null,
      retentionNotice: false,
    };

    let markedIds: string[] = [];
    (runtime as any).api = {
      markNotificationsRead: async (body: { ids: string[] }) => {
        markedIds = body.ids;
      },
    };

    // Mark the open approval read -> attention count should NOT decrement because it is still open!
    await runtime.markNotificationsRead(["01ARZ3NDEKTSV4RRFFQ69G5FAA"]);
    expect(markedIds).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAA"]);
    expect(runtime.notificationSummary.unread_count).toBe(1);
    expect(runtime.notificationSummary.attention_count).toBe(2);

    // Mark the regular reply read -> attention count CAN decrement because it is none (not open)
    await runtime.markNotificationsRead(["01ARZ3NDEKTSV4RRFFQ69G5FAB"]);
    expect(markedIds).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAB"]);
    expect(runtime.notificationSummary.unread_count).toBe(0);
    expect(runtime.notificationSummary.attention_count).toBe(1);
  });

  test("desktop native bridge polls permission state, reports view and handles intent", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";

    const invoked: { cmd: string; args?: any }[] = [];
    (globalThis as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: any) => {
        invoked.push({ cmd, args });
        if (cmd === "notification_permission_state") {
          return {
            permission: "granted",
            nativeReadingV1: true,
            nativeDeliveryV1: true,
            operational: true,
            gatedReason: null,
            attentionCount: 3,
          };
        }
        if (cmd === "take_notification_intent") {
          return { clickRef: "ref-click-99" };
        }
        if (cmd === "report_notification_view") {
          return {
            visible: true,
            focused: true,
            minimized: false,
            effectiveFocused: true,
          };
        }
        if (cmd === "request_notification_permission") {
          return {
            permission: "granted",
            nativeReadingV1: true,
            nativeDeliveryV1: true,
            operational: true,
            gatedReason: null,
            attentionCount: 3,
          };
        }
        return null;
      },
    };

    let selectedSess: string | null = null;
    (runtime as any).selectSession = async (sId: string) => {
      selectedSess = sId;
    };
    (runtime as any).api = {
      kind: "local",
      getDesktopClickTarget: async (ref: string) => {
        expect(ref).toBe("ref-click-99");
        return { target: { session_id: "sess-target-42", message_id: "msg-1" }, open_inbox: false };
      },
      testDesktopNotification: async () => {
        invoked.push({ cmd: "desktop_test_api" });
        return { ok: true, status: "queued" };
      },
      patchNotificationDevice: async () => {},
    };

    try {
      await runtime.pollDesktopNativeState();
      expect(runtime.nativeCapabilities.native_reading_v1).toBe(true);
      expect(runtime.nativeCapabilities.native_delivery_v1).toBe(true);
      expect(runtime.pushPermission).toBe("granted");
      expect(selectedSess).toBe("sess-target-42");

      const facts = await runtime.reportDesktopNotificationView(true);
      expect(facts?.effectiveFocused).toBe(true);
      expect(runtime.nativeFocusFacts.effectiveFocused).toBe(true);

      invoked.length = 0;
      await runtime.sendPresenceHeartbeat(true);
      expect(invoked.some((i) => i.cmd === "report_notification_view")).toBe(true);
      expect(runtime.nativeFocusFacts.focused).toBe(true);

      runtime.notificationDevice = { revision: 1, enabled: true, badge: true, sound: "default", preview: "generic" };
      const sent = await runtime.sendTestNotification();
      expect(sent).toEqual({ ok: true, status: "queued" });
      expect(invoked.some((i) => i.cmd === "desktop_test_api")).toBe(true);
    } finally {
      delete (globalThis as any).__TAURI_INTERNALS__;
    }
  });

  test("loadMoreNotifications paginates with cursor and appends new items", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.notificationInboxState = {
      filter: "all",
      generation: 1,
      instanceId: "inst",
      watermark: 1,
      upperOrdinal: 10,
      items: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
          ordinal: 10,
          semantic_key: "approval:1",
          kind: "approval",
          created_at: "2026-09-22T00:00:00Z",
          read_at: null,
          action_state: "open",
          revision: 1,
          display: { title: "Approval", summary: "" },
          target: {},
        } as any,
      ],
      next: "cursor-p2",
      summary: { unread_count: 2, open_count: 1, attention_count: 2 },
      loading: false,
      loadingMore: false,
      error: null,
      retentionNotice: false,
    };

    let requestedCursor: string | null = null;
    (runtime as any).api = {
      listNotifications: async (opts: any) => {
        requestedCursor = opts.cursor;
        return {
          items: [
            {
              id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
              ordinal: 5,
              semantic_key: "reply:5",
              kind: "reply",
              created_at: "2026-09-22T00:00:00Z",
              read_at: null,
              action_state: "none",
              revision: 1,
              display: { title: "Older Reply", summary: "" },
              target: {},
            },
          ],
          next: null,
          summary: { unread_count: 2, open_count: 1, attention_count: 2 },
          upper_ordinal: 10,
          event_instance_id: "inst",
          watermark_seq: 2,
        };
      },
    };

    await runtime.loadMoreNotifications();
    expect(requestedCursor).toBe("cursor-p2");
    expect(runtime.notificationInboxState.items).toHaveLength(2);
    expect(runtime.notificationInboxState.items[1].id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAB");
    expect(runtime.notificationInboxState.next).toBeNull();
  });

  test("empty first inbox load applies an older HTTP page then replays live upsert/delete", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.notificationSummary = { unread_count: 9, open_count: 2, attention_count: 9 };
    const instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const older = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      ordinal: 4,
      semantic_key: "ask:old",
      kind: "ask" as const,
      created_at: "2026-09-22T00:00:00Z",
      read_at: null,
      action_state: "open" as const,
      revision: 1,
      display: { title: "Older ask", summary: "" },
      target: {},
    };
    const removed = { ...older, id: "01ARZ3NDEKTSV4RRFFQ69G5FAC", ordinal: 3, semantic_key: "ask:gone" };
    const liveItem = { ...older, id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", ordinal: 12, semantic_key: "ask:live", display: { title: "Live ask", summary: "" } };
    const liveSummary = { unread_count: 9, open_count: 2, attention_count: 9 };
    const sync = new EventSync();
    expect(sync.install({ event_instance_id: instance, watermark_seq: 4 })).toEqual([]);
    expect(sync.receive({
      type: "event", event_instance_id: instance, seq: 5,
      payload: { event: "routine.removed", occurred_at: "now", id: "unrelated" },
    })).toHaveLength(1);
    expect(sync.receive({
      type: "event", event_instance_id: instance, seq: 6,
      payload: { event: "notification.upsert", occurred_at: "now", ...liveItem },
    })).toHaveLength(1);
    expect(sync.receive({
      type: "event", event_instance_id: instance, seq: 7,
      payload: { event: "notification.removed", occurred_at: "now", id: removed.id },
    })).toHaveLength(1);
    expect(sync.receive({
      type: "event", event_instance_id: instance, seq: 8,
      payload: { event: "notification.summary", occurred_at: "now", summary: liveSummary },
    })).toHaveLength(1);
    (runtime as any).sync = sync;
    (runtime as any).api = {
      listNotifications: async () => ({
        items: [older, removed],
        next: "cursor-p2",
        summary: { unread_count: 1, open_count: 0, attention_count: 1 },
        upper_ordinal: 4,
        event_instance_id: instance,
        watermark_seq: 4,
      }),
    };

    await runtime.loadNotificationInbox("all");
    expect(runtime.notificationInboxState.items.map((row) => row.id)).toEqual([liveItem.id, older.id]);
    expect(runtime.notificationInboxState.summary).toEqual(liveSummary);
    expect(runtime.notificationSummary).toEqual(liveSummary);
    expect(runtime.notificationInboxState.next).toBe("cursor-p2");
  });

  test("HTTP notification page summary applies when it is at or ahead of the live watermark", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.notificationSummary = { unread_count: 9, open_count: 2, attention_count: 9 };
    const sync = new EventSync();
    expect(sync.install({ event_instance_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", watermark_seq: 4 })).toEqual([]);
    (runtime as any).sync = sync;
    (runtime as any).api = {
      listNotifications: async () => ({
        items: [],
        next: null,
        summary: { unread_count: 2, open_count: 1, attention_count: 3 },
        upper_ordinal: 1,
        event_instance_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        watermark_seq: 4,
      }),
    };

    await runtime.loadNotificationInbox("all");
    expect(runtime.notificationSummary).toEqual({ unread_count: 2, open_count: 1, attention_count: 3 });
  });

  test("disconnected sendTestNotification throws instead of reporting success", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "disconnected";
    await expect(runtime.sendTestNotification()).rejects.toMatchObject({ code: "disconnected" });
  });

  test("desktop sendTestNotification stays gated when native delivery is unqualified even if the device is enabled", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    Object.defineProperty(runtime, "isDesktopShell", { get: () => true });
    runtime.pushPermission = "granted";
    runtime.nativeCapabilities = { native_reading_v1: false, native_delivery_v1: false };
    runtime.notificationDevice = { revision: 1, enabled: true, badge: true, sound: "default", preview: "generic" };
    (runtime as any).api = {
      kind: "local",
      testDesktopNotification: async () => ({ ok: true, status: "queued" }),
    };
    await expect(runtime.sendTestNotification()).rejects.toMatchObject({ code: "delivery_gated" });
  });

  test("local browser sendTestNotification stays gated when native delivery is unqualified even if the device is enabled", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    Object.defineProperty(runtime, "isDesktopShell", { get: () => false });
    runtime.pushPermission = "granted";
    runtime.nativeCapabilities = { native_reading_v1: false, native_delivery_v1: false };
    runtime.notificationDevice = { revision: 1, enabled: true, badge: true, sound: "default", preview: "generic" };
    (runtime as any).api = {
      kind: "local",
      testDesktopNotification: async () => ({ ok: true, status: "queued" }),
    };
    await expect(runtime.sendTestNotification()).rejects.toMatchObject({ code: "delivery_gated" });
  });

  test("remote sendTestNotification throws when the remote gate is closed", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    Object.defineProperty(runtime, "isDesktopShell", { get: () => false });
    runtime.remoteGated = true;
    runtime.notificationDevice = { revision: 1, enabled: true, badge: true, sound: "default", preview: "generic" };
    (runtime as any).api = {
      kind: "remote",
      testRemotePush: async () => ({ ok: true, status: "accepted" }),
    };
    await expect(runtime.sendTestNotification()).rejects.toMatchObject({ code: "gateway_unavailable" });
  });

  test("loadPushState refreshes a healthy opted-in subscription with mode refresh and vapid fingerprint", async () => {
    const keys = generateIdentity();
    const pub = identityPublic(keys);
    const enrollment: StoredEnrollment = {
      v: 1,
      deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      relayOrigin: "https://relay.example.test",
      relayId: "fixture",
      trustEpoch: 1,
      hostDhPublic: base64url(pub.dh),
      hostSigningPublic: base64url(pub.signing),
      dh: base64url(keys.dh),
      signing: base64url(keys.signing),
      enrollment: base64url(keys.enrollment),
      name: "Fixture",
    };
    const applicationServerKey = base64url(new Uint8Array(65).fill(4));
    const vapidFp = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const publicState = {
      applicationServerKey,
      subscribed: true,
      enabled: true,
      device_revision: 7,
      push_generation: 3,
      vapid_key_fingerprint: vapidFp,
      recovery: "none",
      current_endpoint_hash: "h",
      last_gone_endpoint_hash: null,
      last_error_code: null,
      contact_configured: true,
      push_transport: "policy_v2",
    };
    const calls: RemoteRequest[] = [];
    const api = new RemoteApi(enrollment, {
      rpc: async (request) => {
        calls.push(request);
        if (request.path === "/remote/push") {
          return { v: 1, id: request.id, status: 200, body: publicState } satisfies RemoteResponse;
        }
        if (request.path === "/remote/push/subscribe") {
          return { v: 1, id: request.id, status: 204, body: null } satisfies RemoteResponse;
        }
        return { v: 1, id: request.id, status: 204, body: null } satisfies RemoteResponse;
      },
    });

    const originalNotification = (globalThis as { Notification?: typeof Notification }).Notification;
    const originalNavigator = (globalThis as { navigator?: Navigator }).navigator;
    const originalWindow = (globalThis as { window?: Window }).window;
    const originalPushManager = (globalThis as { PushManager?: unknown }).PushManager;
    let permissionCalls = 0;
    let unsubscribeCalls = 0;
    let subscribeCalls = 0;
    const applicationServerKeyBytes = fromBase64url(applicationServerKey, 65);
    const subscription = {
      expirationTime: null,
      options: { applicationServerKey: applicationServerKeyBytes },
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/v1/push/isolated",
        keys: { p256dh: "B".repeat(87), auth: "C".repeat(22) },
      }),
      unsubscribe: async () => {
        unsubscribeCalls += 1;
        return true;
      },
    };
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: class {
        static permission = "granted";
        static async requestPermission() {
          permissionCalls += 1;
          return "granted" as NotificationPermission;
        }
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => subscription,
              subscribe: async () => {
                subscribeCalls += 1;
                return subscription;
              },
            },
          }),
        },
      },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: function PushManager() {} });

    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    (runtime as any).api = api;
    try {
      await runtime.loadPushState();
      const subscribe = calls.find((row) => row.path === "/remote/push/subscribe");
      expect(subscribe?.body).toMatchObject({
        mode: "refresh",
        if_device_revision: 7,
        application_server_key_fingerprint: vapidFp,
      });
      expect(runtime.pushTransport).toBe("policy_v2");
      expect(runtime.pushEnabled).toBe(true);
      expect(runtime.pushSubscribed).toBe(true);
      expect(permissionCalls).toBe(0);
      expect(unsubscribeCalls).toBe(0);
      expect(subscribeCalls).toBe(0);
    } finally {
      Object.defineProperty(globalThis, "Notification", { configurable: true, value: originalNotification });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "PushManager", { configurable: true, value: originalPushManager });
    }
  });

  test("desktop click opens the session it names, and a click with none returns to the list", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.selectedId = "sess-open";
    let selectedSess: string | null = "sess-open";
    (runtime as any).selectSession = async (sId: string) => {
      selectedSess = sId;
      runtime.selectedId = sId;
    };
    (runtime as any).api = {
      getDesktopClickTarget: async () => ({
        target: { session_id: "sess-hidden", message_id: "msg-1" },
        open_inbox: true,
      }),
    };
    await runtime.handleDesktopNotificationIntent("ref-session");
    expect(selectedSess).toBe("sess-hidden");

    (runtime as any).api = {
      getDesktopClickTarget: async () => ({ open_inbox: false }),
    };
    await runtime.handleDesktopNotificationIntent("ref-list");
    expect(runtime.selectedId).toBeNull();
  });

  test("desktop click with a session target dispatches the Shell navigation queue instead of selecting immediately", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    let selectedSess: string | null = null;
    const intents: Array<{ sessionId?: string | null; messageId?: string | null; openInbox: boolean }> = [];
    (runtime as any).selectSession = async (sId: string) => {
      selectedSess = sId;
    };
    runtime.setNotificationIntentHandler((intent) => {
      intents.push(intent);
    });
    (runtime as any).api = {
      getDesktopClickTarget: async () => ({
        target: { session_id: "sess-target-42", message_id: "msg-1" },
        open_inbox: false,
      }),
    };
    await runtime.handleDesktopNotificationIntent("ref-click");
    expect(selectedSess).toBeNull();
    expect(intents).toEqual([{ sessionId: "sess-target-42", messageId: "msg-1", openInbox: false }]);
    runtime.applyNotificationIntent(intents[0]!);
    expect(selectedSess).toBe("sess-target-42");
  });

  test("SW inbox click dispatches the Shell queue and leaves the chat list to that handler", () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    runtime.selectedId = "sess-open";
    const intents: Array<{ openInbox: boolean }> = [];
    runtime.setNotificationIntentHandler((intent) => {
      intents.push({ openInbox: intent.openInbox });
    });
    const origNavigator = globalThis.navigator;
    const fakeController = {};
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          controller: fakeController,
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      },
       });
    try {
      (runtime as any).onPushMessage({ data: { type: "inbox" }, source: fakeController });
      expect(runtime.selectedId).toBe("sess-open");
      expect(intents).toEqual([{ openInbox: true }]);
      expect(runtime.connection).toBe("connected");
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: origNavigator });
    }
  });

  test("stale HTTP more-page appends older rows and preserves recent unread after replay", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    const instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const live = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      ordinal: 12,
      semantic_key: "ask:live",
      kind: "ask" as const,
      created_at: "2026-09-22T00:00:00Z",
      read_at: null,
      action_state: "open" as const,
      revision: 1,
      display: { title: "Live ask", summary: "" },
      target: {},
    };
    const older = { ...live, id: "01ARZ3NDEKTSV4RRFFQ69G5FAB", ordinal: 1, semantic_key: "ask:old", display: { title: "Older", summary: "" } };
    runtime.notificationInboxState = {
      filter: "all",
      generation: 1,
      instanceId: instance,
      watermark: 10,
      upperOrdinal: 12,
      items: [live as any],
      next: "cursor-p2",
      summary: { unread_count: 9, open_count: 2, attention_count: 9 },
      loading: false,
      loadingMore: false,
      error: null,
      retentionNotice: false,
    };
    const liveSummary = { unread_count: 8, open_count: 1, attention_count: 8 };
    const sync = new EventSync();
    expect(sync.install({ event_instance_id: instance, watermark_seq: 10 })).toEqual([]);
    expect(sync.receive({
      type: "event", event_instance_id: instance, seq: 11,
      payload: { event: "notification.summary", occurred_at: "now", summary: liveSummary },
    })).toHaveLength(1);
    (runtime as any).sync = sync;
    (runtime as any).api = {
      listNotifications: async () => ({
        items: [older, { ...live, read_at: "2026-09-22T01:00:00Z" }],
        next: null,
        summary: { unread_count: 1, open_count: 0, attention_count: 1 },
        upper_ordinal: 12,
        event_instance_id: instance,
        watermark_seq: 4,
      }),
    };
    await runtime.loadMoreNotifications();
    expect(runtime.notificationInboxState.items.map((row) => row.id)).toEqual([live.id, older.id]);
    expect(runtime.notificationInboxState.items[0]!.read_at).toBeNull();
    expect(runtime.notificationInboxState.summary).toEqual(liveSummary);
    expect(runtime.notificationInboxState.next).toBeNull();
  });

  test("truncated tail refuses the stale HTTP page, keeps prior rows, and requires an explicit retry", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    const instance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prior = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      ordinal: 12,
      semantic_key: "ask:live",
      kind: "ask" as const,
      created_at: "2026-09-22T00:00:00Z",
      read_at: null,
      action_state: "open" as const,
      revision: 1,
      display: { title: "Live ask", summary: "" },
      target: {},
    };
    runtime.notificationSummary = { unread_count: 9, open_count: 2, attention_count: 9 };
    runtime.notificationInboxState = {
      filter: "all",
      generation: 1,
      instanceId: instance,
      watermark: 10,
      upperOrdinal: 12,
      items: [prior as any],
      next: "cursor-live",
      summary: { unread_count: 9, open_count: 2, attention_count: 9 },
      loading: false,
      loadingMore: false,
      error: null,
      retentionNotice: false,
    };
    const sync = new EventSync();
    expect(sync.install({ event_instance_id: instance, watermark_seq: 0 })).toEqual([]);
    for (let seq = 1; seq <= MAX_NOTIFICATION_TAIL + 1; seq++) {
      expect(sync.receive({
        type: "event", event_instance_id: instance, seq,
        payload: { event: "notification.removed", occurred_at: "now", id: String(seq).padStart(26, "0") },
      })).toHaveLength(1);
    }
    const stale = { ...prior, id: "01ARZ3NDEKTSV4RRFFQ69G5FAB", ordinal: 1, display: { title: "Stale", summary: "" } };
    let pages = 0;
    (runtime as any).sync = sync;
    (runtime as any).api = {
      listNotifications: async () => {
        pages += 1;
        return {
          items: [stale],
          next: null,
          summary: { unread_count: 1, open_count: 0, attention_count: 1 },
          upper_ordinal: 1,
          event_instance_id: instance,
          watermark_seq: 0,
        };
      },
    };
    await runtime.loadNotificationInbox("all");
    expect(pages).toBe(1);
    expect(runtime.notificationInboxState.error).toBe("stale");
    expect(runtime.notificationInboxState.items.map((row) => row.id)).toEqual([prior.id]);
    expect(runtime.notificationSummary.attention_count).toBe(9);
    await runtime.loadNotificationInbox("all");
    expect(pages).toBe(2);
    expect(runtime.notificationInboxState.error).toBe("stale");
  });

  test("instance change during an in-flight GET does not stamp the stale page; a later complete page applies", async () => {
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    const oldInstance = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const newInstance = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const older = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      ordinal: 4,
      semantic_key: "ask:old",
      kind: "ask" as const,
      created_at: "2026-09-22T00:00:00Z",
      read_at: null,
      action_state: "open" as const,
      revision: 1,
      display: { title: "Older ask", summary: "" },
      target: {},
    };
    const fresh = { ...older, id: "01ARZ3NDEKTSV4RRFFQ69G5FAA", ordinal: 8, display: { title: "Fresh", summary: "" } };
    const sync = new EventSync();
    expect(sync.install({ event_instance_id: oldInstance, watermark_seq: 10 })).toEqual([]);
    (runtime as any).sync = sync;
    let resolvePage!: (page: unknown) => void;
    const first = new Promise((ok) => { resolvePage = ok; });
    let calls = 0;
    (runtime as any).api = {
      listNotifications: async () => {
        calls += 1;
        if (calls === 1) return first;
        return {
          items: [fresh],
          next: null,
          summary: { unread_count: 2, open_count: 1, attention_count: 2 },
          upper_ordinal: 8,
          event_instance_id: newInstance,
          watermark_seq: 2,
        };
      },
    };
    const pending = runtime.loadNotificationInbox("all");
    expect(sync.receive({ type: "event", event_instance_id: newInstance, seq: 1, payload: { event: "routine.removed", occurred_at: "now", id: "x" } })).toBeNull();
    resolvePage({
      items: [older],
      next: null,
      summary: { unread_count: 1, open_count: 0, attention_count: 1 },
      upper_ordinal: 4,
      event_instance_id: oldInstance,
      watermark_seq: 4,
    });
    await pending;
    expect(runtime.notificationInboxState.items).toEqual([]);
    expect(runtime.notificationInboxState.loading).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    const ready = new EventSync();
    expect(ready.install({ event_instance_id: newInstance, watermark_seq: 2 })).toEqual([]);
    (runtime as any).sync = ready;
    await runtime.loadNotificationInbox("all");
    expect(runtime.notificationInboxState.items.map((row) => row.id)).toEqual([fresh.id]);
    expect(runtime.notificationSummary.attention_count).toBe(2);
    expect(runtime.notificationInboxState.error).toBeNull();
  });

  test("background refresh without granted permission or subscription reports needs_repair with no side effects", async () => {
    const keys = generateIdentity();
    const pub = identityPublic(keys);
    const enrollment: StoredEnrollment = {
      v: 1,
      deviceId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      hostId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      relayOrigin: "https://relay.example.test",
      relayId: "fixture",
      trustEpoch: 1,
      hostDhPublic: base64url(pub.dh),
      hostSigningPublic: base64url(pub.signing),
      dh: base64url(keys.dh),
      signing: base64url(keys.signing),
      enrollment: base64url(keys.enrollment),
      name: "Fixture",
    };
    const publicState = {
      applicationServerKey: base64url(new Uint8Array(65).fill(4)),
      subscribed: true,
      enabled: true,
      device_revision: 7,
      push_generation: 3,
      vapid_key_fingerprint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      recovery: "none",
      current_endpoint_hash: "h",
      last_gone_endpoint_hash: null,
      last_error_code: null,
      contact_configured: true,
      push_transport: "policy_v2",
    };
    const calls: RemoteRequest[] = [];
    const api = new RemoteApi(enrollment, {
      rpc: async (request) => {
        calls.push(request);
        if (request.path === "/remote/push") {
          return { v: 1, id: request.id, status: 200, body: publicState } satisfies RemoteResponse;
        }
        return { v: 1, id: request.id, status: 204, body: null } satisfies RemoteResponse;
      },
    });
    let permissionCalls = 0;
    const originalNotification = (globalThis as { Notification?: typeof Notification }).Notification;
    const originalNavigator = (globalThis as { navigator?: Navigator }).navigator;
    const originalWindow = (globalThis as { window?: Window }).window;
    const originalPushManager = (globalThis as { PushManager?: unknown }).PushManager;
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: class {
        static permission = "default";
        static async requestPermission() {
          permissionCalls += 1;
          return "granted" as NotificationPermission;
        }
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              getSubscription: async () => null,
              subscribe: async () => { throw new Error("must not subscribe"); },
            },
          }),
        },
      },
    });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "PushManager", { configurable: true, value: function PushManager() {} });
    const runtime = new MessengerRuntime();
    runtime.connection = "connected";
    (runtime as any).api = api;
    try {
      await runtime.loadPushState();
      expect(permissionCalls).toBe(0);
      expect(calls.some((row) => row.path === "/remote/push/subscribe")).toBe(false);
      expect(runtime.pushRecovery).toBe("registration_missing");
      expect(runtime.pushEnabled).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "Notification", { configurable: true, value: originalNotification });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "PushManager", { configurable: true, value: originalPushManager });
    }
  });
});
