import type { SettingsPatch } from "@real-bot/protocol";

export type FieldErrorKind = "empty" | "invalid";

export type SettingsFieldErrors = {
  workspace?: FieldErrorKind;
  endpoint?: FieldErrorKind;
  endpointKey?: FieldErrorKind;
  models?: FieldErrorKind;
  defaultModel?: FieldErrorKind;
};

export type SettingsSavePlan =
  | { ok: true; patch: SettingsPatch }
  | { ok: false; errors: SettingsFieldErrors };

export type MappedSettingsError =
  | { workspace: FieldErrorKind }
  | { endpoint: FieldErrorKind }
  | { models: FieldErrorKind }
  | { defaultModel: FieldErrorKind }
  | { top: true };

export function parseModelLines(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function planSettingsSave(input: {
  workspacePath: string;
  endpointUrl: string;
  endpointKey: string;
  modelsText: string;
  defaultModel: string;
  wizardComplete: boolean;
}): SettingsSavePlan {
  const workspace = input.workspacePath.trim();
  const endpoint = input.endpointUrl.trim();
  const models = parseModelLines(input.modelsText);
  const defaultModel = input.defaultModel.trim();
  const errors: SettingsFieldErrors = {};
  if (workspace.length === 0) errors.workspace = "empty";
  else if (!looksLikeAbsoluteOrHome(workspace)) errors.workspace = "invalid";
  if (endpoint.length === 0) errors.endpoint = "empty";
  else if (!isHttpOrHttpsUrl(endpoint)) errors.endpoint = "invalid";
  if (!input.wizardComplete && input.endpointKey.length === 0) errors.endpointKey = "empty";
  if (models.length === 0) errors.models = "empty";
  if (defaultModel.length === 0) errors.defaultModel = "empty";
  else if (models.length > 0 && !models.includes(defaultModel)) errors.defaultModel = "invalid";
  if (errors.workspace || errors.endpoint || errors.endpointKey || errors.models || errors.defaultModel) {
    return { ok: false, errors };
  }
  const patch: SettingsPatch = {
    workspace_path: workspace,
    endpoint_base_url: endpoint,
    endpoint_models: models,
    endpoint_default_model: defaultModel,
  };
  if (input.endpointKey.length > 0) patch.endpoint_api_key = input.endpointKey;
  return { ok: true, patch };
}

export type WorkspaceSavePlan =
  | { ok: true; workspace_path: string }
  | { ok: false; error: FieldErrorKind };

export function planWorkspaceSave(workspacePath: string): WorkspaceSavePlan {
  const workspace = workspacePath.trim();
  if (workspace.length === 0) return { ok: false, error: "empty" };
  if (!looksLikeAbsoluteOrHome(workspace)) return { ok: false, error: "invalid" };
  return { ok: true, workspace_path: workspace };
}

export function mapSettingsError(message: string): MappedSettingsError {
  if (message === "workspace_path cannot be empty") return { workspace: "empty" };
  if (message.startsWith("workspace_path")) return { workspace: "invalid" };
  if (message === "endpoint_base_url cannot be empty") return { endpoint: "empty" };
  if (message.startsWith("endpoint_base_url")) return { endpoint: "invalid" };
  if (message.startsWith("endpoint_models")) return { models: "invalid" };
  if (message.startsWith("endpoint_default_model")) return { defaultModel: "invalid" };
  return { top: true };
}

function looksLikeAbsoluteOrHome(value: string): boolean {
  return value.startsWith("/") || value === "~" || value.startsWith("~/");
}

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
