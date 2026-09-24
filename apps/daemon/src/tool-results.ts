import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { ulid } from "./ids";
import { codePointCount, takeCodePoints } from "./text";
import { classifyPath } from "./workspace-paths";

const LIMIT = 8000;

/** Reserved inside a work dir: the daemon's own spill, never cited as an artifact. */
export const TOOL_RESULTS_DIRNAME = "tool-results";

type Recovery = {
  full_result_saved: boolean;
  full_result_path?: string;
  save_error?: string;
  recovery_hint: string;
};

/**
 * `workDir` puts the spill inside the job it belongs to, which is what makes it collectable: a
 * work dir whose task closed days ago can have its `tool-results/` swept without reasoning about
 * which ULIDs belong to which dead turn. Turns from before work dirs still spill at the root.
 */
export function serializeToolResult(
  payload: unknown,
  workspace: string | null,
  workDir?: string | null,
): string {
  let raw: string;
  try {
    raw = JSON.stringify(payload);
  } catch {
    // Longer than the engine will hold as one string (a shell that printed most of a gigabyte).
    // Nothing can be saved, but the model still hears the status and a preview.
    return boundedResult(null, payload, {
      full_result_saved: false,
      save_error: "result is too large to save",
      recovery_hint: "The result was too large to keep. Narrow the command so it prints less (count or head the output, search one file, leave tool-results/ out of searches), or write output to a file and read parts of it. Do not assume the original action failed or blindly repeat side effects.",
    });
  }
  const chars = codePointCount(raw);
  if (chars <= LIMIT) return raw;
  let recovery: Recovery;
  try {
    if (!workspace) throw new Error("workspace is not set");
    const base = workDir ? `${workDir}/${TOOL_RESULTS_DIRNAME}` : TOOL_RESULTS_DIRNAME;
    const directory = classifyPath(workspace, base);
    if (directory.zone !== "inside") throw new Error("result directory is outside the workspace");
    mkdirSync(directory.abs, { recursive: true, mode: 0o700 });
    const file = classifyPath(workspace, `${base}/${ulid()}.json`);
    if (file.zone !== "inside") throw new Error("result path is outside the workspace");
    writeFileSync(file.abs, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    recovery = {
      full_result_saved: true,
      full_result_path: file.rel,
      recovery_hint: "Full tool-result JSON is saved in the workspace. Use shell to parse full_result_path, extract only needed fields or URLs, or decode base64 to a file. full_result_path is relative to the workspace root, while a shell without cwd runs in this turn's work dir: pass cwd \".\" when a command or script resolves that path. Do not print the whole payload or repeat the original action just because this preview is truncated. Leave tool-results/ out of workspace searches: each file there is one JSON line, so a single match prints all of it.",
    };
  } catch (error) {
    recovery = {
      full_result_saved: false,
      save_error: error instanceof Error ? error.message : "could not save full result",
      recovery_hint: "Full result could not be saved. Check existing artifacts or use supported pagination, smaller queries, or file/URL output. Do not assume the original action failed or blindly repeat side effects.",
    };
  }
  return boundedResult(chars, payload, recovery);
}

/**
 * Drops `tool-results/` from the given work dirs. Nothing else in a work dir is touched — the rest
 * is the user's, including the folder itself. Returns how many it removed.
 */
export function dropToolResults(workspace: string, dirs: readonly string[]): number {
  let dropped = 0;
  for (const dir of dirs) {
    const spill = classifyPath(workspace, `${dir}/${TOOL_RESULTS_DIRNAME}`);
    if (spill.zone !== "inside") continue;
    try {
      if (!existsSync(spill.abs)) continue;
      rmSync(spill.abs, { recursive: true, force: true });
      dropped++;
    } catch {
      // a file the user locked or already removed is not worth failing a boot over
    }
  }
  return dropped;
}

export function trimToolContent(raw: string): string {
  const chars = codePointCount(raw);
  if (chars <= LIMIT) return raw;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = { preview: raw }; }
  return boundedResult(chars, parsed);
}

function boundedResult(originalChars: number | null, payload: unknown, recovery?: Recovery): string {
  const metadata = {
    truncated: true,
    ...(originalChars === null ? {} : { original_chars: originalChars }),
    ...recovery,
  };
  for (const budget of [600, 200, 60, 0]) {
    const preview = compact(payload, budget, 0, { nodes: 120 });
    const result = { ...asRecord(preview), ...metadata };
    const out = JSON.stringify(result);
    if (codePointCount(out) <= LIMIT) return out;
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
