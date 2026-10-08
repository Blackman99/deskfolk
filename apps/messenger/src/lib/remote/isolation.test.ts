import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { discoverEndpoint } from "./local-discovery-stub.ts";
import { LocalApi } from "./local-api-stub.ts";

test("hosted discovery stub never fetches __local-api", async () => {
  const fetchFn = (async () => {
    throw new Error("hosted messenger must not discover a local bearer");
  }) as typeof fetch;
  await expect(discoverEndpoint(fetchFn)).resolves.toBeNull();
});

test("hosted LocalApi stub refuses to construct a loopback client", () => {
  expect(() => new LocalApi({ origin: "http://127.0.0.1:17890", token: "secret-bearer" })).toThrow(/hosted messenger/);
});

test("local-only sources keep the discovery path that hosted stubs omit", () => {
  const local = readFileSync(new URL("../local-api.ts", import.meta.url), "utf8");
  const discovery = readFileSync(new URL("../local-discovery.ts", import.meta.url), "utf8");
  const stubApi = readFileSync(new URL("./local-api-stub.ts", import.meta.url), "utf8");
  const stubDiscovery = readFileSync(new URL("./local-discovery-stub.ts", import.meta.url), "utf8");
  expect(local).toContain("Bearer");
  expect(discovery).toContain("LOCAL_API_DISCOVERY_PATH");
  expect(discovery).toContain("@real-bot/protocol/local-discovery");
  expect(stubApi).not.toContain("Bearer");
  expect(stubApi).not.toContain("__local-api");
  expect(stubDiscovery).not.toContain("__local-api");
  expect(stubDiscovery).not.toContain("Bearer");
  expect(stubDiscovery).not.toContain("LOCAL_API_DISCOVERY_PATH");
});

test("service worker source caches immutable assets only", () => {
  const sw = readFileSync(new URL("../../../static/sw.js", import.meta.url), "utf8");
  expect(sw).toContain("/_app/immutable/");
  expect(sw).toContain('request.mode === "navigate"');
  expect(sw).toContain("if (request.method !== \"GET\") return");
  expect(sw).toContain("if (request.mode === \"navigate\" || !isImmutable(request.url)) return");
  expect(sw).toContain('addEventListener("push"');
  expect(sw).toContain('addEventListener("notificationclick"');
  expect(sw).toContain('postMessage({ type: "inbox" })');
  expect(sw).toContain('openWindow("/")');
  expect(sw).not.toContain("/approvals/");
  expect(sw).not.toContain("allow_once");
  expect(sw).not.toContain("resolveApproval");
  expect(sw).not.toContain("caches.open(\"chat");
});

/** The settings modal and the pieces it was split into; the remote session's card lives in its own file. */
const settingsSource = (name: string) => readFileSync(new URL(`../settings/${name}`, import.meta.url), "utf8");
const SETTINGS_FILES = [
  "SettingsModal.svelte",
  "SettingsNav.svelte",
  "GeneralTab.svelte",
  "ProvidersTab.svelte",
  "RemoteTab.svelte",
  "RemoteSessionSettings.svelte",
  "AboutTab.svelte",
  "ProviderEditorFlyout.svelte",
  "IndependentConfirm.svelte",
  "provider-editor.svelte.ts",
  "independent-runtime.svelte.ts",
];

test("hosted and remote settings omit workspace_path from PATCH", () => {
  const modal = settingsSource("SettingsModal.svelte");
  const general = settingsSource("GeneralTab.svelte");
  const remoteSession = settingsSource("RemoteSessionSettings.svelte");
  expect(modal).toContain("workspaceReadOnly = $derived(runtime.hosted && !runtime.remote)");
  expect(modal).toContain("if (workspaceReadOnly || runtime.remote)");
  expect(general).toContain("t.settings.workspaceHostOnly");
  expect(general).toContain("workspaceRemoteBrowse");
  expect(modal).toMatch(/patchSettings\(\{\s*workspace_path:/);
  expect(remoteSession).toContain("remote-push-toggle");
  expect(remoteSession).toContain("setPushEnabled");
});

test("hosted and remote onboarding skip the workspace step and omit workspace_path from PATCH", () => {
  const onboarding = readFileSync(new URL("../Onboarding.svelte", import.meta.url), "utf8");
  expect(onboarding).toContain("workspaceReadOnly = $derived(runtime.hosted || runtime.remote)");
  expect(onboarding).toContain("if (!workspaceReadOnly)");
  expect(onboarding).toMatch(/patchSettings\(\{\s*workspace_path:/);
  expect(onboarding).toContain("t.settings.workspaceHostOnly");
  expect(onboarding).toContain("WorkspacePicker");
});

test("push opt-in lives on the remote settings card and does not add restart or file-browser UI", () => {
  const remoteSession = settingsSource("RemoteSessionSettings.svelte");
  expect(settingsSource("RemoteTab.svelte")).toContain("<RemoteSessionSettings {runtime} {t} />");
  expect(remoteSession).toContain('id="remote-push-toggle"');
  expect(remoteSession).toContain("t.remote.pushDenied");
  for (const name of SETTINGS_FILES) {
    const source = settingsSource(name);
    expect(source).not.toContain("file-browser");
    expect(source).not.toContain("runtime/restart");
  }
});

test("hosted layout registers the worker from the compile flag, not import.meta.env", () => {
  const layout = readFileSync(new URL("../../routes/+layout.svelte", import.meta.url), "utf8");
  expect(layout).toContain("HOSTED_MESSENGER");
  expect(layout).toContain("serviceWorker.register('/sw.js')");
  expect(layout).not.toContain("import.meta.env.REAL_BOT_HOSTED");
});
