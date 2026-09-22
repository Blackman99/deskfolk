import { expect, test } from "bun:test";
import {
  classifyPushHealth,
  clientInScope,
  closeCopyKey,
  inboxOpenUrl,
  isTabControlMessage,
  pickOwnerClient,
} from "./tab-owner.ts";

test("tab control messages are shape-exact and never carry business", () => {
  expect(isTabControlMessage({ type: "inbox" })).toBe(true);
  expect(isTabControlMessage({ type: "owner" })).toBe(true);
  expect(isTabControlMessage({ type: "inbox", session_id: "s1" })).toBe(false);
  expect(isTabControlMessage({ type: "allow_once" })).toBe(false);
});

test("owner focus prefers the reported owner then any in-scope client", () => {
  const origin = "https://app.example";
  const clients = [
    { url: "https://other.example/", focused: true },
    { url: "https://app.example/?s=old", focused: false },
    { url: "https://app.example/", focused: false },
  ];
  expect(pickOwnerClient(clients, "https://app.example/", origin, "/")?.url)
    .toBe("https://app.example/");
  expect(pickOwnerClient(clients, null, origin, "/")?.url).toBe("https://app.example/?s=old");
  expect(clientInScope("https://app.example/sw.js", origin, "/")).toBe(true);
  expect(clientInScope("https://evil.example/", origin, "/")).toBe(false);
  expect(inboxOpenUrl(origin, "/")).toBe("https://app.example/");
});

test("close copy keys require both local removal and host disabled confirmation", () => {
  expect(closeCopyKey({ localRemoved: true, hostDisabled: true, hostConfirmed: true })).toBe("closed");
  expect(closeCopyKey({ localRemoved: true, hostDisabled: false, hostConfirmed: false })).toBe("local_only");
  expect(closeCopyKey({ localRemoved: false, hostDisabled: true, hostConfirmed: true })).toBe("host_only");
  expect(closeCopyKey({ localRemoved: false, hostDisabled: false, hostConfirmed: false })).toBe("unconfirmed");
});

test("push health distinguishes paused upgrade, gates, install, and repair", () => {
  expect(classifyPushHealth({
    permission: "granted",
    standalone: true,
    ios: false,
    transport: "paused_upgrade",
    enabled: true,
    subscribed: true,
    recovery: "none",
  })).toBe("paused_upgrade");
  expect(classifyPushHealth({
    permission: "granted",
    standalone: false,
    ios: true,
    transport: "policy_v2",
    enabled: false,
    subscribed: false,
    recovery: "none",
  })).toBe("install_required");
  expect(classifyPushHealth({
    permission: "granted",
    standalone: true,
    ios: false,
    transport: "policy_v2",
    enabled: true,
    subscribed: false,
    recovery: "gone",
  })).toBe("needs_repair");
  expect(classifyPushHealth({
    permission: "denied",
    standalone: true,
    ios: false,
    transport: "policy_v2",
    enabled: false,
    subscribed: false,
    recovery: "none",
  })).toBe("denied");
  expect(classifyPushHealth({
    permission: "granted",
    standalone: true,
    ios: false,
    transport: "policy_v2",
    enabled: false,
    subscribed: false,
    recovery: "none",
    remoteGate: true,
  })).toBe("gated");
});
