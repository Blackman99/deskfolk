/**
 * A Bot's interface tools (ADR 0106). Reading is free, even under a hold. A change is checked on the
 * interface as it stands and, by the Bot's permission mode, applied at once (auto, allow all), put on
 * a `ui-edit` card (ask first: applied again on the interface as it is when you allow it) or refused
 * (read-only). It is a change, not a change to the app's setup: it reaches no tool, endpoint or rule,
 * every window checks the floor after applying it, and every revision can be taken back.
 */
import {
  INTERFACE_BEHAVIOUR_SPECS,
  INTERFACE_CODE_THEMES,
  INTERFACE_EDIT_KIND,
  INTERFACE_OPEN_KINDS,
  INTERFACE_OPEN_PLACEMENTS,
  INTERFACE_REASON_MAX,
  interfaceChanges,
  UI_FLOORS,
  UI_HOOKS,
  type InterfaceRecord,
} from "@real-bot/protocol";
import type { ToolCtx, ToolResult } from "../collab-tools";
import { runCollabTool } from "../collab-tools";
import { HttpError } from "../errors";
import { toolFail as fail } from "../tool-result";
import { changeVerdict } from "./guards";

/** How much of the custom CSS one read shows, so the whole answer stays inside a tool result. */
const CSS_PAGE = 2500;
const FOUND_MAX = 30;
const RECENT_SHOWN = 5;
const SUMMARY_LINES = 40;
const PATCH_KEYS = ["enabled", "tokens", "behaviour", "css", "copy", "reset", "theme", "locale"] as const;

function en(ctx: ToolCtx): boolean {
  return ctx.store.settingsCached().locale === "en";
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** Token families by their first word (`--accent-soft` is `--accent`), with how many each has. */
function tokenFamilies(names: readonly string[]): Record<string, number> {
  const families: Record<string, number> = {};
  for (const name of names) {
    const family = name.match(/^--[a-z]+/)?.[0] ?? name;
    families[family] = (families[family] ?? 0) + 1;
  }
  return families;
}

export function describeInterface(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const english = en(ctx);
  const state = ctx.store.interfaceState();
  const record = ctx.store.interfaceRecord();
  const { catalog, reports } = ctx.store.interfaceWindows();
  const profile = record.profile;
  const from = typeof args.css_from === "number" && Number.isFinite(args.css_from) ? Math.max(0, Math.floor(args.css_from)) : 0;
  const data: Record<string, unknown> = {
    enabled: profile.enabled,
    theme: record.theme,
    locale: record.locale,
    tokens: profile.tokens,
    behaviour: profile.behaviour,
    css: {
      length: profile.css.length,
      from,
      text: profile.css.slice(from, from + CSS_PAGE),
      ...(profile.css.length > from + CSS_PAGE ? { more_from: from + CSS_PAGE } : {}),
    },
    copy: profile.copy,
    behaviour_list: Object.entries(INTERFACE_BEHAVIOUR_SPECS).map(([key, spec]) => ({
      key,
      values: spec.values === "per-kind"
        ? { kinds: INTERFACE_OPEN_KINDS, placements: INTERFACE_OPEN_PLACEMENTS }
        : spec.values === "per-look" ? INTERFACE_CODE_THEMES : spec.values,
      ...(spec.desktopOnly ? { desktop_only: true } : {}),
      what: english ? spec.en : spec.zh,
    })),
    hooks: Object.fromEntries(UI_HOOKS.map(([name, zh, enWords]) => [name, english ? enWords : zh])),
    floors: UI_FLOORS,
    windows: reports.map((report) => ({
      surface: report.surface,
      at: report.at,
      applied: report.applied,
      revision_id: report.revision_id,
      ...(report.unmatched.length ? { unmatched: report.unmatched } : {}),
      ...(report.dropped ? { dropped: report.dropped } : {}),
      ...(report.bad_tokens.length ? { bad_tokens: report.bad_tokens } : {}),
      ...(report.floor_failed.length ? { floor_failed: report.floor_failed } : {}),
    })),
    recent: state.recent.slice(0, RECENT_SHOWN).map((head) => ({
      id: head.id,
      op: head.op,
      by: head.actor === "bot" ? (head.bot_id === ctx.botId ? "you" : "a bot") : "user",
      at: head.created_at,
      changes: head.changes.slice(0, 6).map((change) => clip(change, 120)),
      undoable: head.undoable,
    })),
  };
  if (catalog) data.token_families = tokenFamilies(catalog.tokens.map((token) => token.name));
  else data.catalog = english ? "No desktop window has said which tokens and words the app has yet." : "还没有桌面窗口报过应用有哪些令牌和文案。";
  const find = typeof args.find === "string" ? args.find.trim().toLowerCase() : "";
  if (find && catalog) {
    data.found_tokens = catalog.tokens
      .filter((token) => token.name.includes(find) || token.light?.toLowerCase().includes(find) || token.dark?.toLowerCase().includes(find))
      .slice(0, FOUND_MAX)
      .map((token) => ({ name: token.name, light: token.light, dark: token.dark }));
    const words = catalog.copy[record.locale] ?? {};
    data.found_words = Object.entries(words)
      .filter(([key, text]) => key.toLowerCase().includes(find) || text.toLowerCase().includes(find))
      .slice(0, FOUND_MAX)
      .map(([key, text]) => ({ key, text: clip(text, 160) }));
  }
  return { ok: true, data, emitted: [] };
}

function requireReason(raw: unknown): string {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (!reason) throw new HttpError(422, "invalid_args", "reason is required: what the user asked for");
  return clip(reason.replace(/\s*\n\s*/g, " "), INTERFACE_REASON_MAX);
}

function sameRecord(a: InterfaceRecord, b: InterfaceRecord): boolean {
  return interfaceChanges(a, b).length === 0;
}

/**
 * The card's text: a head, the reason on the second line, one line per change, and the change itself
 * after a `@@patch` line, which the card reads to let you try it in a window before you allow it.
 */
export function interfaceEditSummary(changes: readonly string[], reason: string, patch: Record<string, unknown>, english: boolean): string {
  const lines = [english ? "Change the interface" : "改界面", english ? `Reason: ${reason}` : `理由：${reason}`];
  for (const change of changes.slice(0, SUMMARY_LINES)) lines.push(`- ${clip(change, 200)}`);
  if (changes.length > SUMMARY_LINES) lines.push(english ? `… ${changes.length - SUMMARY_LINES} more` : `…还有 ${changes.length - SUMMARY_LINES} 处`);
  lines.push("@@patch", JSON.stringify(patch));
  return lines.join("\n");
}

export function editInterface(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const reason = requireReason(args.reason);
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) if (args[key] !== undefined) patch[key] = args[key];
  const restore = args.restore;
  if (restore !== undefined && (typeof restore !== "string" || Object.keys(patch).length > 0)) {
    return fail("invalid_args", "restore takes a change's id, alone");
  }
  if (restore === undefined && Object.keys(patch).length === 0) return fail("invalid_args", "say what to change: tokens, behaviour, css, copy, theme, locale, enabled, reset or restore");
  const current = ctx.store.interfaceRecord();
  let next: InterfaceRecord;
  try {
    next = typeof restore === "string" ? ctx.store.getInterfaceRevision(restore).after : ctx.store.previewInterfacePatch(patch);
  } catch (error) {
    if (ctx.approved && error instanceof HttpError && error.status === 422) {
      return fail("conflict", `the interface changed while the card waited and this no longer fits (${error.message}); read describe_interface again`);
    }
    throw error;
  }
  const changes = interfaceChanges(current, next);
  if (sameRecord(current, next)) return fail("no_change", "the interface already looks like that");
  if (changeVerdict(ctx) === "ask") {
    return {
      ok: false,
      waitApproval: {
        kind_key: INTERFACE_EDIT_KIND,
        target: "interface",
        summary: interfaceEditSummary(changes, reason, typeof restore === "string" ? { restore } : patch, en(ctx)),
        run: (opts) => runCollabTool({ ...ctx, approved: true, approvalId: opts?.approval_id ?? null, approvalMessageId: opts?.message_id ?? null }, "edit_interface", args),
      },
      emitted: [],
    };
  }
  const by = { actor: "bot" as const, botId: ctx.botId, turnId: ctx.turnId, approvalId: ctx.approvalId ?? null, messageId: ctx.approvalMessageId ?? null, reason };
  const result = typeof restore === "string" ? ctx.store.restoreInterfaceRevision(restore, by) : ctx.store.changeInterface(patch, by);
  if (!result.revision) return fail("no_change", "the interface already looks like that");
  return {
    ok: true,
    data: {
      revision_id: result.revision.id,
      changes: changes.slice(0, 20).map((change) => clip(change, 160)),
      applied: en(ctx)
        ? "Applied in every window. The user can undo it under your reply or in Settings › Interface. Read describe_interface in a few seconds for what the windows found."
        : "已在所有窗口生效；用户能在你的回复下或「设置 › 界面」撤销。过几秒用 describe_interface 看各窗口的回报。",
    },
    emitted: [],
  };
}
