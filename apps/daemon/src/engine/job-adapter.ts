/**
 * How the daemon reads a media server's submit/check pair (ADR 0047): `submit_<x>` starts a job and
 * answers with its id, `check_<x>` on the same server takes that id and answers with its state. The
 * pair is found by name, so any server shaped like westlake-cpa's `submit_video` / `check_video`
 * works the same; a tool that is not one half of such a pair is left alone.
 */
import type { JobState } from "../store";

export type McpToolInfo = { server: string; tool: string; readOnly: boolean; params?: string[] };
export type JobPair = { kind: "submit" | "check"; server: string; submitTool: string; checkTool: string; idParam: string };

/** The argument names a check tool may take the job's id in, in the order they are tried. */
const ID_PARAMS = ["job_id", "request_id", "task_id", "jobId", "requestId", "id"];

/** The submit/check pair `name` belongs to, by its tools on the same server; null when it is not one. */
export function jobPair(name: string, tools: ReadonlyMap<string, McpToolInfo>): JobPair | null {
  const info = tools.get(name);
  if (!info) return null;
  const match = /^(submit|check)_(.+)$/.exec(info.tool);
  if (!match) return null;
  const other = `${match[1] === "submit" ? "check" : "submit"}_${match[2]}`;
  const partner = [...tools.entries()].find(([, candidate]) => candidate.server === info.server && candidate.tool === other);
  if (!partner) return null;
  const [submitTool, checkTool] = match[1] === "submit" ? [name, partner[0]] : [partner[0], name];
  const checkInfo = match[1] === "check" ? info : partner[1];
  const idParam = ID_PARAMS.find((param) => checkInfo.params?.includes(param)) ?? "job_id";
  return { kind: match[1] as "submit" | "check", server: info.server, submitTool, checkTool, idParam };
}

/**
 * An answer written as `key: value` lines, as some servers write theirs (grok-imagine:
 * `request_id: …` from a submit, `status: done` and `url: …` from a check), read as one record. A
 * note in brackets at the end of a line is the server's hint, not part of the value
 * (`request_id: 1d92… (poll check_video again)`); a line that is not a key and a value is skipped.
 */
function keyValues(text: string): Record<string, string> | null {
  const record: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][\w.-]*)\s*[:=]\s+(\S.*?)\s*$/.exec(line);
    if (!match || match[1]! in record) continue;
    const value = match[2]!.replace(/\s*\([^()]*\)$/, "");
    if (value) record[match[1]!] = value;
  }
  return Object.keys(record).length > 0 ? record : null;
}

/**
 * What an MCP result says: the JSON in its text content, failing that its `key: value` lines (with
 * the text as the server wrote it, which is what a Bot reads when the job is over), or the result
 * itself when it is plain data.
 */
function payloadOf(data: unknown): { record: Record<string, unknown>; text: string | null } | null {
  if (data && typeof data === "object" && Array.isArray((data as { content?: unknown }).content)) {
    const texts: string[] = [];
    for (const part of (data as { content: Array<{ type?: string; text?: unknown }> }).content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      texts.push(part.text);
      try {
        const parsed = JSON.parse(part.text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { record: parsed as Record<string, unknown>, text: null };
      } catch {
        // not JSON: the next text part may be
      }
    }
    for (const text of texts) {
      const record = keyValues(text);
      if (record) return { record, text: text.trim() };
    }
    return null;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? { record: data as Record<string, unknown>, text: null } : null;
}

function nested(record: Record<string, unknown>): Record<string, unknown>[] {
  const out = [record];
  for (const key of ["data", "result", "job"]) {
    const inner = record[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) out.push(inner as Record<string, unknown>);
  }
  return out;
}

/** The job id a submit's answer names: job_id, request_id, task_id or id, at the top or under data/result/job, or on a line of its own. */
export function jobIdOf(data: unknown): string | null {
  const payload = payloadOf(data);
  if (!payload) return null;
  for (const record of nested(payload.record)) {
    for (const key of ID_PARAMS) {
      const value = record[key];
      if ((typeof value === "string" && value.trim()) || typeof value === "number") return String(value).trim();
    }
  }
  return null;
}

/** The job id a Bot's check names in its arguments. */
export function checkedJobId(args: Record<string, unknown>): string | null {
  for (const key of ID_PARAMS) {
    const value = args[key];
    if ((typeof value === "string" && value.trim()) || typeof value === "number") return String(value).trim();
  }
  return null;
}

const DONE = /^(?:completed?|succeeded|success(?:ful)?|done|finished|ready)$/i;
const FAILED = /^(?:failed|failure|error|errored|cancel+ed|timeout|timed_out|rejected)$/i;
const RESULT_KEYS = ["url", "video_url", "output_url", "download_url", "file", "path", "duration", "seconds", "cost", "price", "error", "message"];

/**
 * What a check's answer says: done, failed or still going, its own status word, and the parts of its
 * result worth passing on — all of it, as the server wrote it, when it wrote lines (grok-imagine's
 * `(url is TEMPORARY — fetch promptly)` is for the Bot who fetches it).
 */
export function jobStatusOf(data: unknown): { state: JobState; statusText: string | null; result: string | null } {
  const payload = payloadOf(data);
  if (!payload) return { state: "pending", statusText: null, result: null };
  let status: string | null = null;
  for (const record of nested(payload.record)) {
    const value = record.status ?? record.state;
    if (typeof value === "string") {
      status = value;
      break;
    }
  }
  const state: JobState = status && DONE.test(status) ? "completed" : status && FAILED.test(status) ? "failed" : "pending";
  if (payload.text !== null) return { state, statusText: status, result: state === "pending" ? null : payload.text };
  const facts: string[] = [];
  for (const record of nested(payload.record)) {
    for (const key of RESULT_KEYS) {
      const value = record[key];
      if ((typeof value === "string" && value) || typeof value === "number") facts.push(`${key}: ${value}`);
    }
  }
  return { state, statusText: status, result: facts.length > 0 ? [...new Set(facts)].join(", ") : state === "pending" ? null : JSON.stringify(payload.record) };
}

/** An MCP-shaped answer the Bot reads in place of the server's: one text part of JSON, as the server's own answers are. */
export function jobReply(fields: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(fields) }] };
}
