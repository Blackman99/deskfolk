import { expect, test } from "bun:test";
import { mapSettingsError, planSettingsSave, planWorkspaceSave } from "./wizard-save.ts";

test("settings Save only PATCHes a legal workspace path", () => {
  expect(planWorkspaceSave("   ")).toEqual({ ok: false, error: "empty" });
  expect(planWorkspaceSave("relative")).toEqual({ ok: false, error: "invalid" });
  expect(planWorkspaceSave("~/Projects")).toEqual({ ok: true, workspace_path: "~/Projects" });
  expect(planWorkspaceSave("/tmp/ws")).toEqual({ ok: true, workspace_path: "/tmp/ws" });
});

test("incomplete empty path, URL, and key do not produce a PATCH", () => {
  expect(
    planSettingsSave({
      workspacePath: "   ",
      endpointUrl: "",
      endpointKey: "",
      modelsText: "",
      defaultModel: "",
      wizardComplete: false,
    }),
  ).toEqual({
    ok: false,
    errors: {
      workspace: "empty",
      endpoint: "empty",
      endpointKey: "empty",
      models: "empty",
      defaultModel: "empty",
    },
  });
});

test("incomplete filled fields still report the ones that are wrong, and send nothing", () => {
  expect(
    planSettingsSave({
      workspacePath: "/tmp/ws",
      endpointUrl: "ftp://api.example",
      endpointKey: "",
      modelsText: "grok-4.5",
      defaultModel: "grok-4.5",
      wizardComplete: false,
    }),
  ).toEqual({
    ok: false,
    errors: { endpoint: "invalid", endpointKey: "empty" },
  });
});

test("complete save still requires a path and URL", () => {
  expect(
    planSettingsSave({
      workspacePath: "",
      endpointUrl: "https://api.example/v1",
      endpointKey: "",
      modelsText: "grok-4.5",
      defaultModel: "grok-4.5",
      wizardComplete: true,
    }),
  ).toEqual({
    ok: false,
    errors: { workspace: "empty" },
  });
});

test("tilde path is sent; existence is the daemon's job", () => {
  expect(
    planSettingsSave({
      workspacePath: "~/Projects",
      endpointUrl: "https://api.example/v1",
      endpointKey: "sk-secret",
      modelsText: " grok-4.5 \n\ndeepseek-v4-pro\ngrok-4.5",
      defaultModel: " grok-4.5 ",
      wizardComplete: false,
    }),
  ).toEqual({
    ok: true,
    patch: {
      workspace_path: "~/Projects",
      endpoint_base_url: "https://api.example/v1",
      endpoint_api_key: "sk-secret",
      endpoint_models: ["grok-4.5", "deepseek-v4-pro"],
      endpoint_default_model: "grok-4.5",
    },
  });
});

test("relative workspace path does not produce a PATCH", () => {
  expect(
    planSettingsSave({
      workspacePath: "relative/ws",
      endpointUrl: "https://api.example/v1",
      endpointKey: "sk-secret",
      modelsText: "grok-4.5",
      defaultModel: "grok-4.5",
      wizardComplete: false,
    }),
  ).toEqual({
    ok: false,
    errors: { workspace: "invalid" },
  });
});

test("incomplete legal triple is one PATCH with all three", () => {
  expect(
    planSettingsSave({
      workspacePath: " /tmp/ws ",
      endpointUrl: " https://api.example/v1 ",
      endpointKey: "sk-secret",
      modelsText: "grok-4.5",
      defaultModel: "grok-4.5",
      wizardComplete: false,
    }),
  ).toEqual({
    ok: true,
    patch: {
      workspace_path: "/tmp/ws",
      endpoint_base_url: "https://api.example/v1",
      endpoint_api_key: "sk-secret",
      endpoint_models: ["grok-4.5"],
      endpoint_default_model: "grok-4.5",
    },
  });
});

test("complete save omits an empty key and still sends path and URL", () => {
  expect(
    planSettingsSave({
      workspacePath: "/tmp/ws",
      endpointUrl: "https://api.example/v1",
      endpointKey: "",
      modelsText: "grok-4.5",
      defaultModel: "grok-4.5",
      wizardComplete: true,
    }),
  ).toEqual({
    ok: true,
    patch: {
      workspace_path: "/tmp/ws",
      endpoint_base_url: "https://api.example/v1",
      endpoint_models: ["grok-4.5"],
      endpoint_default_model: "grok-4.5",
    },
  });
});

test("complete save includes a newly pasted key", () => {
  const plan = planSettingsSave({
    workspacePath: "/tmp/ws",
    endpointUrl: "https://api.example/v1",
    endpointKey: "sk-new",
    modelsText: "grok-4.5",
    defaultModel: "grok-4.5",
    wizardComplete: true,
  });
  expect(plan).toEqual({
    ok: true,
    patch: {
      workspace_path: "/tmp/ws",
      endpoint_base_url: "https://api.example/v1",
      endpoint_api_key: "sk-new",
      endpoint_models: ["grok-4.5"],
      endpoint_default_model: "grok-4.5",
    },
  });
});

test("default model must be one of the listed names", () => {
  expect(
    planSettingsSave({
      workspacePath: "/tmp/ws",
      endpointUrl: "https://api.example/v1",
      endpointKey: "sk-secret",
      modelsText: "grok-4.5",
      defaultModel: "nope",
      wizardComplete: false,
    }),
  ).toEqual({
    ok: false,
    errors: { defaultModel: "invalid" },
  });
});

test("maps daemon English messages onto the locked field kinds", () => {
  expect(mapSettingsError("workspace_path must be an existing absolute directory")).toEqual({
    workspace: "invalid",
  });
  expect(mapSettingsError("workspace_path must be an absolute directory")).toEqual({
    workspace: "invalid",
  });
  expect(mapSettingsError("workspace_path must be a directory")).toEqual({ workspace: "invalid" });
  expect(mapSettingsError("workspace_path could not be created")).toEqual({ workspace: "invalid" });
  expect(mapSettingsError("workspace_path cannot be empty")).toEqual({ workspace: "empty" });
  expect(mapSettingsError("endpoint_base_url must be an http or https URL")).toEqual({
    endpoint: "invalid",
  });
  expect(mapSettingsError("endpoint_base_url cannot be empty")).toEqual({ endpoint: "empty" });
  expect(mapSettingsError("endpoint_models must be an array of strings")).toEqual({
    models: "invalid",
  });
  expect(mapSettingsError("endpoint_default_model must be one of endpoint_models")).toEqual({
    defaultModel: "invalid",
  });
  expect(mapSettingsError("locale must be zh or en")).toEqual({ top: true });
  expect(mapSettingsError("unknown settings field: foo")).toEqual({ top: true });
});
