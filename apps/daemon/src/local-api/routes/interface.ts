import type { InterfaceCatalog, InterfaceResponse, InterfaceSurface, InterfaceWindowReport } from "@real-bot/protocol";
import { HttpError } from "../../errors";
import { emptyResponse, jsonResponse, matchPath } from "../../http";
import { isoNow } from "../../ids";
import type { Store } from "../../store";
import type { RouteCtx } from "../route-ctx";

const SURFACES: readonly InterfaceSurface[] = ["desktop", "tablet", "phone"];
/** How much of a window's catalog is kept: every token, and the app's words in both languages. */
const CATALOG_TOKENS_MAX = 2000;
const CATALOG_WORDS_MAX = 20_000;

export function interfaceResponse(store: Store): InterfaceResponse {
  return { ...store.interfaceState(), reports: store.interfaceWindows().reports };
}

function texts(value: unknown, max: number, each = 300): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, max).map((item) => [...item].slice(0, each).join(""));
}

/** A window's report, read leniently: it is what the window saw, not something to refuse. */
function readReport(raw: unknown): InterfaceWindowReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const report = raw as Record<string, unknown>;
  const surface = SURFACES.includes(report.surface as InterfaceSurface) ? (report.surface as InterfaceSurface) : "desktop";
  const floors = Array.isArray(report.floor_failed) ? report.floor_failed : [];
  return {
    at: isoNow(),
    surface,
    app_version: typeof report.app_version === "string" ? report.app_version.slice(0, 80) : null,
    revision_id: typeof report.revision_id === "string" ? report.revision_id.slice(0, 40) : null,
    applied: report.applied !== false,
    unmatched: texts(report.unmatched, 50),
    dropped: typeof report.dropped === "number" && Number.isFinite(report.dropped) ? Math.max(0, Math.floor(report.dropped)) : 0,
    bad_tokens: texts(report.bad_tokens, 50, 80),
    floor_failed: floors.slice(0, 20).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { floor, why } = item as { floor?: unknown; why?: unknown };
      return typeof floor === "string" && typeof why === "string" ? [{ floor: floor.slice(0, 40), why: why.slice(0, 200) }] : [];
    }),
  };
}

function readWords(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= CATALOG_WORDS_MAX) break;
    if (typeof value !== "string" || key.length > 160) continue;
    out[key] = value.slice(0, 2000);
    count += 1;
  }
  return out;
}

function readCatalog(raw: unknown): InterfaceCatalog | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const catalog = raw as Record<string, unknown>;
  const tokens = Array.isArray(catalog.tokens) ? catalog.tokens : [];
  const copy = (catalog.copy && typeof catalog.copy === "object" ? catalog.copy : {}) as Record<string, unknown>;
  return {
    app_version: typeof catalog.app_version === "string" ? catalog.app_version.slice(0, 80) : null,
    tokens: tokens.slice(0, CATALOG_TOKENS_MAX).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { name, light, dark } = item as { name?: unknown; light?: unknown; dark?: unknown };
      if (typeof name !== "string" || !/^--[a-z][a-z0-9-]{0,62}$/.test(name)) return [];
      const value = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : null);
      return [{ name, light: value(light), dark: value(dark) }];
    }),
    copy: { zh: readWords(copy.zh), en: readWords(copy.en) },
  };
}

/**
 * Local API routes for your interface profile (ADR 0106): read it with what each kind of window last
 * found, change it as you would in Settings (a sitting folds into one revision), read its history,
 * take the latest change back or restore any, and a window's report after applying it. Changes reach
 * every window as `interface.changed` through the store's journal.
 */
export function interfaceRoutes(ctx: RouteCtx): Response | null {
  const { input, store, method, path, url } = ctx;
  if (!path.startsWith("/v1/interface")) return null;
  const body = (input.body ?? {}) as Record<string, unknown>;

  if (path === "/v1/interface") {
    if (method === "GET") return jsonResponse(interfaceResponse(store), 200, null);
    if (method === "PATCH") {
      if (body.if_revision !== undefined && body.if_revision !== null && typeof body.if_revision !== "string") {
        throw new HttpError(422, "invalid_args", "if_revision must be a revision id or null");
      }
      store.changeInterface(body.patch, {
        actor: "user",
        ifRevision: body.if_revision as string | null | undefined,
        editSession: typeof body.edit_session === "string" && body.edit_session ? body.edit_session.slice(0, 80) : null,
        reason: typeof body.reason === "string" ? body.reason : null,
      });
      return jsonResponse(interfaceResponse(store), 200, null);
    }
    return null;
  }

  if (path === "/v1/interface/window" && method === "POST") {
    store.noteInterfaceWindow({ report: readReport(body.report), catalog: readCatalog(body.catalog) });
    return emptyResponse(204, null);
  }

  if (path === "/v1/interface/revisions" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    return jsonResponse({
      items: store.listInterfaceRevisions({
        turnId: url.searchParams.get("turn_id") ?? undefined,
        approvalId: url.searchParams.get("approval_id") ?? undefined,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    }, 200, null);
  }

  let params = matchPath(path, "/v1/interface/revisions/:id");
  if (params && method === "GET") return jsonResponse(store.getInterfaceRevision(params.id!), 200, null);
  params = matchPath(path, "/v1/interface/revisions/:id/undo");
  if (params && method === "POST") {
    store.undoInterfaceRevision(params.id!, { actor: "user" });
    return jsonResponse(interfaceResponse(store), 200, null);
  }
  params = matchPath(path, "/v1/interface/revisions/:id/restore");
  if (params && method === "POST") {
    store.restoreInterfaceRevision(params.id!, { actor: "user" });
    return jsonResponse(interfaceResponse(store), 200, null);
  }
  return null;
}
