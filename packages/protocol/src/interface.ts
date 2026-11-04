/**
 * 界面方案 (Interface profile, ADR 0106): what you changed about how the app looks and works, laid
 * over its defaults. Three layers, all in one profile every window and paired phone reads:
 *
 * - tokens: any design token (`--x`) the app defines, set for the light look, the dark look or both;
 * - behaviour: a fixed list of how the app works, each with the values it takes;
 * - css: a stylesheet of your own, for anything the two lists do not reach;
 * - copy: the app's own words, changed one at a time.
 *
 * The defaults stay code (`tokens.css`, `copy/`); the profile only overrides. A Bot changes it when
 * you ask in a conversation (`edit_interface`), you change it in Settings › 界面, and every change is
 * a revision you can take back. What no layer may do is hide what you need to stay in charge — Stop,
 * the buttons on a card that waits for you, the way back to Settings: each window checks those after
 * applying the profile and drops the token and CSS layers where they would be hidden (`data-floor`).
 */
import type { Locale, Theme } from "./constants.ts";

/** How long the stylesheet of your own may be, in characters. */
export const INTERFACE_CSS_MAX = 64_000;
/** How long one token's value may be. */
export const INTERFACE_TOKEN_VALUE_MAX = 200;
/** How many tokens one look may set. */
export const INTERFACE_TOKENS_MAX = 300;
/** How many of the app's words one language may change, and how long each may be. */
export const INTERFACE_COPY_MAX = 500;
export const INTERFACE_COPY_TEXT_MAX = 500;
/** How long a change's reason may be. */
export const INTERFACE_REASON_MAX = 500;
/** How many changes to the stylesheet one edit may make. */
export const INTERFACE_CSS_EDITS_MAX = 10;
/** The newest revisions a snapshot carries, heads only. */
export const INTERFACE_RECENT_MAX = 20;
/** The approval card kind a Bot's interface change waits on under ask-first (a change, not a setup change). */
export const INTERFACE_EDIT_KIND = "ui-edit";

/**
 * The parts of the app a stylesheet of yours can count on: `[data-ui="…"]` stays on the same part
 * from one version to the next, unlike class names. A source test checks each one is still there.
 */
export const UI_HOOKS = [
  ["sidebar", "侧栏", "the sidebar"],
  ["sidebar-rail", "收起时的窄侧栏", "the narrow sidebar when folded"],
  ["session-list", "会话列表", "the list of conversations"],
  ["session-row", "会话列表里的一行", "one row of the conversation list"],
  ["chat", "一个会话的整页", "a conversation, whole"],
  ["chat-header", "会话顶上的标题栏", "a conversation's header"],
  ["transcript", "消息列表", "the messages"],
  ["bubble-you", "你说的一条", "one line of yours"],
  ["bubble-bot", "Bot 说的一段", "one Bot's reply"],
  ["avatar", "头像", "an avatar"],
  ["composer", "输入框整块", "the composer"],
  ["composer-input", "输入的文字区", "the composer's text box"],
  ["send-button", "发送按钮", "the send button"],
  ["approval-card", "等你批准的卡片", "a card waiting for your approval"],
  ["ask-card", "Bot 问你的卡片", "a card where a Bot asks you"],
  ["workbench", "桌面工作台", "the desktop workbench"],
  ["pane", "工作台的一块窗格", "one pane of the workbench"],
  ["tab-strip", "窗格顶上的标签栏", "a pane's tab strip"],
  ["tab", "一个标签", "one tab"],
  ["settings", "设置", "Settings"],
  ["flow-board", "流程图", "the flow board"],
  ["preview", "文件预览", "a file's preview"],
  ["workspace-tree", "工作区文件树", "the workspace's file tree"],
  ["terminal", "终端", "a terminal"],
  ["mobile-nav", "手机底部导航", "the phone's bottom bar"],
  ["empty-state", "空状态插图", "an empty state"],
] as const;
export type UiHook = (typeof UI_HOOKS)[number][0];

/**
 * What a window checks it can still show after applying the profile (`data-floor="…"`): what you
 * need to stop a Bot, answer one, and get back to Settings to undo a change.
 */
export const UI_FLOORS = ["stop", "approval", "ask", "settings-entry", "interface-pause", "interface-undo"] as const;
export type UiFloor = (typeof UI_FLOORS)[number];

/** The kinds of window and where each opens (ADR 0074), as the messenger names them. */
export const INTERFACE_OPEN_KINDS = ["chat", "trace", "preview", "workspace", "terminal", "routines", "spend", "usage", "roles", "map"] as const;
export const INTERFACE_OPEN_PLACEMENTS = [
  "tab", "tab-background", "replace", "split-left", "split-right", "split-up", "split-down",
  "side-left", "side-right", "side-up", "side-down", "float",
] as const;
export type InterfaceOpenKind = (typeof INTERFACE_OPEN_KINDS)[number];
export type InterfaceOpenPlacement = (typeof INTERFACE_OPEN_PLACEMENTS)[number];

/** How the app works, from a fixed list: each key is absent until set, and absent is the app's default. */
export type InterfaceBehaviour = {
  /** Hide times, durations, commands, model tags and Bot↔Bot entries in conversations. */
  focus_mode?: boolean;
  /** Where each kind of window opens on the desktop (ADR 0074); a phone shows one screen at a time. */
  open_placement?: Partial<Record<InterfaceOpenKind, InterfaceOpenPlacement>>;
  /** Which key sends: Enter (Shift+Enter is a new line), or ⌘/Ctrl+Enter (Enter is a new line). */
  send_key?: "enter" | "mod_enter";
  /** How a message's time reads. */
  time_format?: "24h" | "12h";
  /** Whether the app moves as your system says, or always as little as it can. */
  motion?: "system" | "reduce";
};

export const INTERFACE_BEHAVIOUR_KEYS = ["focus_mode", "open_placement", "send_key", "time_format", "motion"] as const;
export type InterfaceBehaviourKey = (typeof INTERFACE_BEHAVIOUR_KEYS)[number];

/** What each behaviour takes and where it applies, for Settings and for a Bot reading the list. */
export const INTERFACE_BEHAVIOUR_SPECS: Record<InterfaceBehaviourKey, { values: readonly (string | boolean)[] | "per-kind"; desktopOnly: boolean; zh: string; en: string }> = {
  focus_mode: { values: [true, false], desktopOnly: false, zh: "专注模式：会话里不显示时间、耗时、跑过的命令、模型和 Bot↔Bot 往来", en: "Focus mode: conversations hide times, durations, commands, models and Bot↔Bot entries" },
  open_placement: { values: "per-kind", desktopOnly: true, zh: "每种窗口在桌面上从哪打开", en: "Where each kind of window opens on the desktop" },
  send_key: { values: ["enter", "mod_enter"], desktopOnly: false, zh: "回车发送，或 ⌘/Ctrl+回车 发送", en: "Enter sends, or ⌘/Ctrl+Enter sends" },
  time_format: { values: ["24h", "12h"], desktopOnly: false, zh: "消息时间按 24 小时或 12 小时制", en: "Message times in 24-hour or 12-hour form" },
  motion: { values: ["system", "reduce"], desktopOnly: false, zh: "动效跟随系统，或一直减弱", en: "Motion as the system says, or always reduced" },
};

/** Tokens you set, by look. A token set in both is two entries, one in each. */
export type InterfaceTokens = { light: Record<string, string>; dark: Record<string, string> };

export type InterfaceProfile = {
  /** Off, every window shows the app's own look; the behaviour list still holds. */
  enabled: boolean;
  tokens: InterfaceTokens;
  behaviour: InterfaceBehaviour;
  css: string;
  /** The app's words you changed, by language, keyed by where they sit (`composer.send`). */
  copy: Record<Locale, Record<string, string>>;
};

export function emptyInterfaceProfile(): InterfaceProfile {
  return { enabled: true, tokens: { light: {}, dark: {} }, behaviour: {}, css: "", copy: { zh: {}, en: {} } };
}

/** What a revision keeps: the profile, and the theme and language beside it, which live in Settings. */
export type InterfaceRecord = { profile: InterfaceProfile; theme: Theme; locale: Locale };

export type InterfaceRevisionOp = "edit" | "reset" | "undo" | "restore";

/** One change, kept for the history; folded only while you keep typing in one sitting of Settings. */
export type InterfaceRevision = {
  id: string;
  revision: number;
  op: InterfaceRevisionOp;
  actor: "user" | "bot";
  bot_id: string | null;
  turn_id: string | null;
  approval_id: string | null;
  message_id: string | null;
  reason: string | null;
  /** The app's build the change was made against, as the last window reported it. */
  app_version: string | null;
  before: InterfaceRecord;
  after: InterfaceRecord;
  created_at: string;
};

/** A revision without its bodies, with what changed in a few words and whether it can be taken back now. */
export type InterfaceRevisionHead = Omit<InterfaceRevision, "before" | "after"> & { changes: string[]; undoable: boolean };

/** What a window found after applying the profile (`POST /v1/interface/window`). */
export type InterfaceWindowReport = {
  at: string;
  surface: InterfaceSurface;
  app_version: string | null;
  /** The revision it applied. */
  revision_id: string | null;
  /** Whether the profile was on in that window: off by your switch, `?ui=default` or a floor that failed. */
  applied: boolean;
  /** Selectors of your stylesheet that matched nothing on that screen just then (up to 50). */
  unmatched: string[];
  /** Rules the browser could not read and dropped. */
  dropped: number;
  /** Tokens it did not take as values (`CSS.supports` said no). */
  bad_tokens: string[];
  /** Floors the profile hid, and how; empty when none was. */
  floor_failed: Array<{ floor: UiFloor | string; why: string }>;
};

export type InterfaceSurface = "desktop" | "tablet" | "phone";

/** What a desktop window says the app has, so a Bot can look things up (`POST /v1/interface/window`). */
export type InterfaceCatalog = {
  app_version: string | null;
  /** Each token with its default in each look; null where that look does not set it. */
  tokens: Array<{ name: string; light: string | null; dark: string | null }>;
  /** The app's words, by language and key. */
  copy: Record<Locale, Record<string, string>>;
};

/** The profile as clients read it (`GET /v1/interface`, the snapshot and `interface.changed`). */
export type InterfaceState = {
  profile: InterfaceProfile;
  /** How many changes there have been; 0 is never changed. */
  revision: number;
  /** The latest change, for `if_revision`; null when never changed. */
  revision_id: string | null;
  recent: InterfaceRevisionHead[];
};

/** `GET /v1/interface` and what its writes answer: the state, and what each kind of window last found. */
export type InterfaceResponse = InterfaceState & { reports: InterfaceWindowReport[] };

/** A change to the stylesheet: replace a passage found once, add after one, or append. */
export type InterfaceCssEdit = { old: string; new: string } | { after: string; add: string } | { add: string };

/** A change to the profile, as a Bot's tool and Settings send it; null removes an entry. */
export type InterfacePatch = {
  enabled?: boolean;
  tokens?: { light?: Record<string, string | null>; dark?: Record<string, string | null>; both?: Record<string, string | null> };
  behaviour?: { [K in Exclude<InterfaceBehaviourKey, "open_placement">]?: InterfaceBehaviour[K] | null } & {
    open_placement?: Partial<Record<InterfaceOpenKind, InterfaceOpenPlacement | null>> | null;
  };
  css?: { set: string } | { edits: InterfaceCssEdit[] };
  copy?: { zh?: Record<string, string | null>; en?: Record<string, string | null> };
  /** Parts put back to the app's own, before anything else in the patch applies. */
  reset?: Array<"tokens" | "behaviour" | "css" | "copy">;
  theme?: Theme;
  locale?: Locale;
};

export class InterfacePatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,62}$/;
const COPY_KEY = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+){0,6}$/;
const PARTS = ["tokens", "behaviour", "css", "copy"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Why a token's value cannot be one, or null. The browser still has the last word (`CSS.supports`). */
export function tokenValueProblem(value: string): string | null {
  if (value.trim() === "") return "is empty";
  if ([...value].length > INTERFACE_TOKEN_VALUE_MAX) return `is longer than ${INTERFACE_TOKEN_VALUE_MAX} characters`;
  if (/[;{}<>]/.test(value)) return "may not hold ; { } < or >";
  if (/url\s*\(|expression\s*\(|!\s*important|javascript:/i.test(value)) return "may not hold url(), expression() or !important";
  return null;
}

/**
 * Why a stylesheet cannot be applied, or null. It goes into a `<style>` as text, so it can hold no
 * markup; it loads nothing from elsewhere (the pages' CSP would refuse that too), except pictures
 * written inline as `data:image/…`.
 */
export function cssProblem(css: string): string | null {
  if (css.length > INTERFACE_CSS_MAX) return `is longer than ${INTERFACE_CSS_MAX} characters`;
  if (/<\s*\/?\s*style/i.test(css)) return "may not hold a <style> tag";
  if (/@import/i.test(css)) return "may not @import";
  if (/expression\s*\(|-moz-binding|behavior\s*:|javascript:/i.test(css)) return "may not hold expression(), -moz-binding, behavior or javascript:";
  for (const match of css.matchAll(/url\s*\(\s*(['"]?)\s*([^'")\s]*)/gi)) {
    if (!/^data:image\//i.test(match[2] ?? "")) return "url() may only hold an inline data:image/… picture";
  }
  return null;
}

function tokenSide(raw: unknown, into: Record<string, string>, where: string): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) throw new InterfacePatchError("invalid_args", `tokens.${where} must be an object of token names to values`);
  for (const [name, value] of Object.entries(raw)) {
    if (!TOKEN_NAME.test(name)) throw new InterfacePatchError("invalid_args", `tokens.${where}: ${name} is not a token name (--like-this)`);
    if (value === null) {
      delete into[name];
      continue;
    }
    if (typeof value !== "string") throw new InterfacePatchError("invalid_args", `tokens.${where}.${name} must be text or null`);
    const problem = tokenValueProblem(value);
    if (problem) throw new InterfacePatchError("invalid_args", `tokens.${where}.${name} ${problem}`);
    into[name] = value.trim();
  }
  if (Object.keys(into).length > INTERFACE_TOKENS_MAX) throw new InterfacePatchError("too_many", `at most ${INTERFACE_TOKENS_MAX} tokens per look`);
}

function behaviourValue(key: InterfaceBehaviourKey, value: unknown): unknown {
  if (key === "focus_mode") {
    if (typeof value !== "boolean") throw new InterfacePatchError("invalid_args", "behaviour.focus_mode must be true or false");
    return value;
  }
  if (key === "open_placement") {
    if (!isRecord(value)) throw new InterfacePatchError("invalid_args", "behaviour.open_placement must map kinds of window to placements");
    const out: Partial<Record<InterfaceOpenKind, InterfaceOpenPlacement>> = {};
    for (const [kind, placement] of Object.entries(value)) {
      if (!(INTERFACE_OPEN_KINDS as readonly string[]).includes(kind)) {
        throw new InterfacePatchError("invalid_args", `behaviour.open_placement: ${kind} is not a kind of window (${INTERFACE_OPEN_KINDS.join(", ")})`);
      }
      if (placement === null) continue;
      if (!(INTERFACE_OPEN_PLACEMENTS as readonly unknown[]).includes(placement)) {
        throw new InterfacePatchError("invalid_args", `behaviour.open_placement.${kind} must be one of ${INTERFACE_OPEN_PLACEMENTS.join(", ")}`);
      }
      out[kind as InterfaceOpenKind] = placement as InterfaceOpenPlacement;
    }
    return out;
  }
  const values = INTERFACE_BEHAVIOUR_SPECS[key].values as readonly unknown[];
  if (!values.includes(value)) throw new InterfacePatchError("invalid_args", `behaviour.${key} must be one of ${values.join(", ")}`);
  return value;
}

function applyCss(current: string, raw: unknown): string {
  if (!isRecord(raw)) throw new InterfacePatchError("invalid_args", "css must be { set } or { edits }");
  if (raw.set !== undefined) {
    if (typeof raw.set !== "string" || raw.edits !== undefined) throw new InterfacePatchError("invalid_args", "css.set must be the whole stylesheet as text, alone");
    return raw.set;
  }
  const edits = raw.edits;
  if (!Array.isArray(edits) || edits.length === 0) throw new InterfacePatchError("invalid_args", "css.edits must list at least one change");
  if (edits.length > INTERFACE_CSS_EDITS_MAX) throw new InterfacePatchError("too_many", `at most ${INTERFACE_CSS_EDITS_MAX} changes to the stylesheet at once`);
  let css = current;
  edits.forEach((edit: unknown, at) => {
    const n = at + 1;
    if (!isRecord(edit)) throw new InterfacePatchError("invalid_args", `css edit ${n} is not an object`);
    const text = (key: string) => (typeof edit[key] === "string" ? (edit[key] as string) : undefined);
    const old = text("old"), next = text("new"), after = text("after"), add = text("add");
    const once = (needle: string) => {
      const first = css.indexOf(needle);
      if (needle === "" || first < 0) throw new InterfacePatchError("not_found", `css edit ${n}: that passage is not in the stylesheet`);
      if (css.indexOf(needle, first + 1) >= 0) throw new InterfacePatchError("ambiguous", `css edit ${n}: that passage occurs more than once; quote more of it`);
      return first;
    };
    if (old !== undefined && next !== undefined && after === undefined && add === undefined) {
      const at0 = once(old);
      css = css.slice(0, at0) + next + css.slice(at0 + old.length);
    } else if (after !== undefined && add !== undefined && old === undefined && next === undefined) {
      const at0 = once(after) + after.length;
      css = css.slice(0, at0) + add + css.slice(at0);
    } else if (add !== undefined && old === undefined && next === undefined && after === undefined) {
      css = css === "" ? add : css.endsWith("\n") ? css + add : `${css}\n${add}`;
    } else {
      throw new InterfacePatchError("invalid_args", `css edit ${n}: give old + new, after + add, or add alone`);
    }
  });
  return css;
}

function copySide(raw: unknown, into: Record<string, string>, where: string): void {
  if (raw === undefined) return;
  if (!isRecord(raw)) throw new InterfacePatchError("invalid_args", `copy.${where} must be an object of keys to text`);
  for (const [key, value] of Object.entries(raw)) {
    if (!COPY_KEY.test(key)) throw new InterfacePatchError("invalid_args", `copy.${where}: ${key} is not a key of the app's words`);
    if (value === null) {
      delete into[key];
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") throw new InterfacePatchError("invalid_args", `copy.${where}.${key} must be text or null`);
    if ([...value].length > INTERFACE_COPY_TEXT_MAX) throw new InterfacePatchError("invalid_args", `copy.${where}.${key} is longer than ${INTERFACE_COPY_TEXT_MAX} characters`);
    into[key] = value;
  }
  if (Object.keys(into).length > INTERFACE_COPY_MAX) throw new InterfacePatchError("too_many", `at most ${INTERFACE_COPY_MAX} changed words per language`);
}

/** A profile as stored, read leniently: what does not fit is left out rather than failing the app. */
export function normalizeInterfaceProfile(raw: unknown): InterfaceProfile {
  const out = emptyInterfaceProfile();
  if (!isRecord(raw)) return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  const tokens = isRecord(raw.tokens) ? raw.tokens : {};
  for (const side of ["light", "dark"] as const) {
    const values = isRecord(tokens[side]) ? tokens[side] : {};
    for (const [name, value] of Object.entries(values)) {
      if (TOKEN_NAME.test(name) && typeof value === "string" && !tokenValueProblem(value)) out.tokens[side][name] = value;
    }
  }
  const behaviour = isRecord(raw.behaviour) ? raw.behaviour : {};
  for (const key of INTERFACE_BEHAVIOUR_KEYS) {
    if (behaviour[key] === undefined) continue;
    try {
      (out.behaviour as Record<string, unknown>)[key] = behaviourValue(key, behaviour[key]);
    } catch {
      // A value this build does not know: the default.
    }
  }
  if (typeof raw.css === "string" && !cssProblem(raw.css)) out.css = raw.css;
  const copy = isRecord(raw.copy) ? raw.copy : {};
  for (const locale of ["zh", "en"] as const) {
    const words = isRecord(copy[locale]) ? copy[locale] : {};
    for (const [key, value] of Object.entries(words)) {
      if (COPY_KEY.test(key) && typeof value === "string" && value.trim() !== "") out.copy[locale][key] = value;
    }
  }
  return out;
}

/**
 * The profile with a patch applied, checked; throws {@link InterfacePatchError} for what cannot be.
 * Resets go first, then the rest. Theme and language are not in the profile: the caller reads them
 * off the patch.
 */
export function applyInterfacePatch(current: InterfaceProfile, raw: unknown): InterfaceProfile {
  if (!isRecord(raw)) throw new InterfacePatchError("invalid_args", "the change must be an object");
  const allowed = new Set(["enabled", "tokens", "behaviour", "css", "copy", "reset", "theme", "locale"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new InterfacePatchError("invalid_args", `${key} is not part of the interface`);
  }
  const next = JSON.parse(JSON.stringify(current)) as InterfaceProfile;
  if (raw.reset !== undefined) {
    if (!Array.isArray(raw.reset) || raw.reset.some((part) => !(PARTS as readonly unknown[]).includes(part))) {
      throw new InterfacePatchError("invalid_args", `reset lists parts: ${PARTS.join(", ")}`);
    }
    const empty = emptyInterfaceProfile();
    for (const part of raw.reset as Array<(typeof PARTS)[number]>) (next as Record<string, unknown>)[part] = empty[part];
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new InterfacePatchError("invalid_args", "enabled must be true or false");
    next.enabled = raw.enabled;
  }
  if (raw.tokens !== undefined) {
    if (!isRecord(raw.tokens)) throw new InterfacePatchError("invalid_args", "tokens must be { light, dark, both }");
    for (const key of Object.keys(raw.tokens)) {
      if (!["light", "dark", "both"].includes(key)) throw new InterfacePatchError("invalid_args", `tokens.${key}: say light, dark or both`);
    }
    tokenSide(raw.tokens.both, next.tokens.light, "both");
    tokenSide(raw.tokens.both, next.tokens.dark, "both");
    tokenSide(raw.tokens.light, next.tokens.light, "light");
    tokenSide(raw.tokens.dark, next.tokens.dark, "dark");
  }
  if (raw.behaviour !== undefined) {
    if (!isRecord(raw.behaviour)) throw new InterfacePatchError("invalid_args", "behaviour must be an object");
    for (const [key, value] of Object.entries(raw.behaviour)) {
      if (!(INTERFACE_BEHAVIOUR_KEYS as readonly string[]).includes(key)) {
        throw new InterfacePatchError("invalid_args", `behaviour.${key} is not on the list (${INTERFACE_BEHAVIOUR_KEYS.join(", ")})`);
      }
      const typed = key as InterfaceBehaviourKey;
      if (value === null) delete next.behaviour[typed];
      else if (typed === "open_placement") {
        const merged = { ...(next.behaviour.open_placement ?? {}) };
        for (const [kind, placement] of Object.entries(value as Record<string, unknown>)) {
          if (placement === null) delete merged[kind as InterfaceOpenKind];
        }
        Object.assign(merged, behaviourValue(typed, value));
        if (Object.keys(merged).length === 0) delete next.behaviour.open_placement;
        else next.behaviour.open_placement = merged;
      } else (next.behaviour as Record<string, unknown>)[typed] = behaviourValue(typed, value);
    }
  }
  if (raw.css !== undefined) {
    const css = applyCss(next.css, raw.css);
    const problem = cssProblem(css);
    if (problem) throw new InterfacePatchError("invalid_args", `the stylesheet ${problem}`);
    next.css = css;
  }
  if (raw.copy !== undefined) {
    if (!isRecord(raw.copy)) throw new InterfacePatchError("invalid_args", "copy must be { zh, en }");
    for (const key of Object.keys(raw.copy)) {
      if (key !== "zh" && key !== "en") throw new InterfacePatchError("invalid_args", `copy.${key}: say zh or en`);
    }
    copySide(raw.copy.zh, next.copy.zh, "zh");
    copySide(raw.copy.en, next.copy.en, "en");
  }
  return next;
}

export function sameInterfaceProfile(a: InterfaceProfile, b: InterfaceProfile): boolean {
  return JSON.stringify(normalizeInterfaceProfile(a)) === JSON.stringify(normalizeInterfaceProfile(b));
}

/** What changed between two records, in a few words each (English keys; the screens word them). */
export function interfaceChanges(before: InterfaceRecord, after: InterfaceRecord): string[] {
  const out: string[] = [];
  if (before.theme !== after.theme) out.push(`theme: ${after.theme}`);
  if (before.locale !== after.locale) out.push(`locale: ${after.locale}`);
  if (before.profile.enabled !== after.profile.enabled) out.push(after.profile.enabled ? "enabled" : "paused");
  for (const side of ["light", "dark"] as const) {
    const names = new Set([...Object.keys(before.profile.tokens[side]), ...Object.keys(after.profile.tokens[side])]);
    for (const name of [...names].sort()) {
      const was = before.profile.tokens[side][name], now = after.profile.tokens[side][name];
      if (was !== now) out.push(now === undefined ? `${side} ${name}: default` : `${side} ${name}: ${now}`);
    }
  }
  for (const key of INTERFACE_BEHAVIOUR_KEYS) {
    const was = JSON.stringify(before.profile.behaviour[key]), now = JSON.stringify(after.profile.behaviour[key]);
    if (was !== now) out.push(now === undefined ? `${key}: default` : `${key}: ${now}`);
  }
  if (before.profile.css !== after.profile.css) {
    out.push(after.profile.css === "" ? "css: removed" : `css: ${after.profile.css.length} characters`);
  }
  for (const locale of ["zh", "en"] as const) {
    const keys = new Set([...Object.keys(before.profile.copy[locale]), ...Object.keys(after.profile.copy[locale])]);
    for (const key of [...keys].sort()) {
      const was = before.profile.copy[locale][key], now = after.profile.copy[locale][key];
      if (was !== now) out.push(now === undefined ? `copy ${locale} ${key}: default` : `copy ${locale} ${key}: ${now}`);
    }
  }
  return out;
}
