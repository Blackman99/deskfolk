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

/** The JSON an MCP result carries in its text content, or the result itself when it is plain data. */
function payloadOf(data: unknown): Record<string, unknown> | null {
  if (data && typeof data === "object" && Array.isArray((data as { content?: unknown }).content)) {
    for (const part of (data as { content: Array<{ type?: string; text?: unknown }> }).content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      try {
        const parsed = JSON.parse(part.text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // not JSON: the next text part may be
      }
    }
    return null;
  }
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

function nested(record: Record<string, unknown>): Record<string, unknown>[] {
  const out = [record];
  for (const key of ["data", "result", "job"]) {
    const inner = record[key];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) out.push(inner as Record<string, unknown>);
  }
  return out;
}

/** The job id a submit's answer names: job_id, request_id, task_id or id, at the top or under data/result/job. */
export function jobIdOf(data: unknown): string | null {
  const payload = payloadOf(data);
  if (!payload) return null;
  for (const record of nested(payload)) {
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

/** What a check's answer says: done, failed or still going, its own status word, and the parts of its result worth passing on. */
export function jobStatusOf(data: unknown): { state: JobState; statusText: string | null; result: string | null } {
  const payload = payloadOf(data);
  if (!payload) return { state: "pending", statusText: null, result: null };
  let status: string | null = null;
  for (const record of nested(payload)) {
    const value = record.status ?? record.state;
    if (typeof value === "string") {
      status = value;
      break;
    }
  }
  const state: JobState = status && DONE.test(status) ? "completed" : status && FAILED.test(status) ? "failed" : "pending";
  const facts: string[] = [];
  for (const record of nested(payload)) {
    for (const key of RESULT_KEYS) {
      const value = record[key];
      if ((typeof value === "string" && value) || typeof value === "number") facts.push(`${key}: ${value}`);
    }
  }
  return { state, statusText: status, result: facts.length > 0 ? [...new Set(facts)].join(", ") : state === "pending" ? null : JSON.stringify(payload) };
}

/** An MCP-shaped answer the Bot reads in place of the server's: one text part of JSON, as the server's own answers are. */
export function jobReply(fields: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(fields) }] };
}
