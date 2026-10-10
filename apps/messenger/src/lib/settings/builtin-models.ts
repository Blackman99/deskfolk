import {
  BUILTIN_MODEL_ROLES,
  type BuiltinModelRole,
  type ReaderEndpointModel,
  type ReaderModel,
  type Settings,
  type SettingsPatch,
} from "@real-bot/protocol";

/** Every built-in call with no model of its own, as a settings snapshot starts out. */
export const noBuiltinModels = (): Record<BuiltinModelRole, ReaderModel | null> =>
  Object.fromEntries(BUILTIN_MODEL_ROLES.map((role) => [role, null])) as Record<BuiltinModelRole, ReaderModel | null>;

/**
 * What the page can choose and what is chosen. A daemon with ADR 0077 reports every call in
 * `builtin_models`. An older one (a phone paired with an older Mac) only has the reading model and the
 * organizing model, each in a setting of its own, and takes no Claude model for the organizer; `legacy`
 * says which of the two it is, so a choice is sent the way that daemon reads it.
 */
export function builtinModelsOf(settings: Settings): {
  chosen: Partial<Record<BuiltinModelRole, ReaderModel | null>>;
  roles: readonly BuiltinModelRole[];
  legacy: boolean;
} {
  if (settings.builtin_models) return { chosen: settings.builtin_models, roles: BUILTIN_MODEL_ROLES, legacy: false };
  const chosen: Partial<Record<BuiltinModelRole, ReaderModel | null>> = {};
  const roles: BuiltinModelRole[] = [];
  if (settings.reader_model !== undefined) {
    chosen.reader = settings.reader_model;
    roles.push("reader");
  }
  if (settings.organizer_model !== undefined) {
    chosen.organizer = settings.organizer_model;
    roles.push("organizer");
  }
  return { chosen, roles, legacy: true };
}

/** The patch that saves one call's model (null runs it as before), in the shape the daemon reads. */
export function builtinPatch(role: BuiltinModelRole, next: ReaderModel | null, legacy: boolean): SettingsPatch {
  if (legacy && role === "reader") return { reader_model: next };
  // An older daemon runs the organizer on an endpoint's model only, and the row offers no other.
  if (legacy && role === "organizer") return { organizer_model: next as ReaderEndpointModel | null };
  return { builtin_models: { [role]: next } };
}
