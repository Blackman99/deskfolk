import { mkdirSync, writeFileSync } from "node:fs";
import { ulid } from "./ids";
import { takeCodePoints } from "./text";
import { classifyPath } from "./workspace-paths";

const LIMIT = 8000;

type Recovery = {
  full_result_saved: boolean;
  full_result_path?: string;
  save_error?: string;
  recovery_hint: string;
};

export function serializeToolResult(payload: unknown, workspace: string | null): string {
  const raw = JSON.stringify(payload);
  if (codePoints(raw) <= LIMIT) return raw;
  let recovery: Recovery;
  try {
    if (!workspace) throw new Error("workspace is not set");
    const directory = classifyPath(workspace, "tool-results");
    if (directory.zone !== "inside") throw new Error("result directory is outside the workspace");
    mkdirSync(directory.abs, { recursive: true, mode: 0o700 });
    const file = classifyPath(workspace, `tool-results/${ulid()}.json`);
    if (file.zone !== "inside") throw new Error("result path is outside the workspace");
    writeFileSync(file.abs, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    recovery = {
      full_result_saved: true,
      full_result_path: file.rel,
      recovery_hint: "Full tool-result JSON is saved in the workspace. Use shell to parse full_result_path, extract only needed fields or URLs, or decode base64 to a file. Do not print the whole payload or repeat the original action just because this preview is truncated.",
    };
  } catch (error) {
    recovery = {
      full_result_saved: false,
      save_error: error instanceof Error ? error.message : "could not save full result",
      recovery_hint: "Full result could not be saved. Check existing artifacts or use supported pagination, smaller queries, or file/URL output. Do not assume the original action failed or blindly repeat side effects.",
    };
  }
  return boundedResult(raw, payload, recovery);
}

export function trimToolContent(raw: string): string {
  if (codePoints(raw) <= LIMIT) return raw;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = { preview: raw }; }
  return boundedResult(raw, parsed);
}

function boundedResult(raw: string, payload: unknown, recovery?: Recovery): string {
  const metadata = {
    truncated: true,
    original_chars: codePoints(raw),
    ...recovery,
  };
  for (const budget of [600, 200, 60, 0]) {
    const preview = compact(payload, budget, 0, { nodes: 120 });
    const result = { ...asRecord(preview), ...metadata };
    const out = JSON.stringify(result);
    if (codePoints(out) <= LIMIT) return out;
  }
  const source = asRecord(payload);
  return JSON.stringify({
    ...(typeof source.ok === "boolean" ? { ok: source.ok } : {}),
    ...metadata,
    preview: "Result preview omitted; inspect the full result when available.",
  });
}

function compact(value: unknown, budget: number, depth: number, state: { nodes: number }): unknown {
  if (typeof value === "string") {
    const clipped = takeCodePoints(value, budget);
    return clipped.truncated ? `${clipped.text}… [truncated ${clipped.original} chars]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6 || state.nodes-- <= 0) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => compact(item, budget, depth + 1, state));
    if (value.length > 9) items.push(`[${value.length - 9} intervening items omitted]`);
    if (value.length > 8) items.push(compact(value.at(-1), budget, depth + 1, state));
    return items;
  }
  const entries = Object.entries(value);
  const priority = ["ok", "error", "code", "message", "isError", "exit_code", "stderr", "path", "url", "data", "content", "stdout"];
  entries.sort(([a], [b]) => {
    const rank = (key: string) => { const index = priority.indexOf(key); return index < 0 ? priority.length : index; };
    return rank(a) - rank(b);
  });
  return Object.fromEntries(entries.slice(0, 16).map(([key, val]) => [
    takeCodePoints(key, 100).text,
    compact(val, budget, depth + 1, state),
  ]));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { preview: value };
}

function codePoints(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}
