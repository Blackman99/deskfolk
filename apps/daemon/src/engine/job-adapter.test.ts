import { expect, test } from "bun:test";
import { checkedJobId, jobIdOf, jobPair, jobReply, jobStatusOf, type McpToolInfo } from "./job-adapter";

const tools = new Map<string, McpToolInfo>([
  ["mcp_cpa_submit_video", { server: "cpa", tool: "submit_video", readOnly: false, params: ["prompt"] }],
  ["mcp_cpa_check_video", { server: "cpa", tool: "check_video", readOnly: true, params: ["request_id"] }],
  ["mcp_cpa_generate_image", { server: "cpa", tool: "generate_image", readOnly: false, params: ["prompt"] }],
  ["mcp_other_check_video", { server: "other", tool: "check_video", readOnly: true, params: ["job_id"] }],
]);

test("a submit/check pair is found by name on the same server, with the id argument the check takes", () => {
  expect(jobPair("mcp_cpa_submit_video", tools)).toEqual({ kind: "submit", server: "cpa", submitTool: "mcp_cpa_submit_video", checkTool: "mcp_cpa_check_video", idParam: "request_id" });
  expect(jobPair("mcp_cpa_check_video", tools)).toMatchObject({ kind: "check", submitTool: "mcp_cpa_submit_video" });
  // Not half of a pair: a lone tool, or a check whose submit is on another server.
  expect(jobPair("mcp_cpa_generate_image", tools)).toBeNull();
  expect(jobPair("mcp_other_check_video", tools)).toBeNull();
  expect(jobPair("send_message", tools)).toBeNull();
});

test("the job id and state are read from an MCP answer's JSON text, at the top or nested", () => {
  const answer = (fields: unknown) => ({ content: [{ type: "text", text: "queued" }, { type: "text", text: JSON.stringify(fields) }] });
  expect(jobIdOf(answer({ job_id: "j-1", status: "pending" }))).toBe("j-1");
  expect(jobIdOf(answer({ data: { request_id: 42 } }))).toBe("42");
  expect(jobIdOf({ content: [{ type: "text", text: "not json" }] })).toBeNull();
  expect(jobStatusOf(answer({ status: "running" }))).toEqual({ state: "pending", statusText: "running", result: null });
  expect(jobStatusOf(answer({ status: "SUCCEEDED", result: { video_url: "https://x/v.mp4", duration: 8.04, cost: 0.3 } })))
    .toEqual({ state: "completed", statusText: "SUCCEEDED", result: "video_url: https://x/v.mp4, duration: 8.04, cost: 0.3" });
  expect(jobStatusOf(answer({ state: "failed", error: "nsfw" }))).toMatchObject({ state: "failed", result: "error: nsfw" });
  expect(checkedJobId({ request_id: "r-9" })).toBe("r-9");
  expect(checkedJobId({ prompt: "x" })).toBeNull();
  expect(JSON.parse(jobReply({ job_id: "j", cached: true }).content[0]!.text)).toEqual({ job_id: "j", cached: true });
});

test("an answer written as key: value lines is read too: the id without its bracketed hint, the state, and the whole text once over", () => {
  // grok-imagine's own answers, as recorded on 2026-10-04.
  const lines = (text: string) => ({ content: [{ type: "text", text }], structuredContent: { result: text } });
  expect(jobIdOf(lines("request_id: 1d920a6e-f6c3-957d-a5d0-4f859df1a2b5\n(poll with check_video)"))).toBe("1d920a6e-f6c3-957d-a5d0-4f859df1a2b5");
  expect(jobStatusOf(lines("status: pending\nprogress: 80\nrequest_id: 1d920a6e-f6c3-957d-a5d0-4f859df1a2b5 (poll check_video again)")))
    .toEqual({ state: "pending", statusText: "pending", result: null });
  const done = "status: done\nurl: https://vidgen.x.ai/xai-vidgen-bucket/xai-video-1d920a6e.mp4\nduration_s: 6\ncost_in_usd_ticks: 15100000000\n(url is TEMPORARY — fetch promptly)";
  expect(jobStatusOf(lines(done))).toEqual({ state: "completed", statusText: "done", result: done });
  // A sentence is no record, and a bare URL is no key.
  expect(jobIdOf(lines("Error executing tool submit_video: 1080p video resolution is not supported for reference-to-video requests."))).toBeNull();
  expect(jobIdOf(lines("https://vidgen.x.ai/v.mp4"))).toBeNull();
  // JSON still wins where an answer has both.
  expect(jobIdOf({ content: [{ type: "text", text: "request_id: from-lines" }, { type: "text", text: JSON.stringify({ job_id: "from-json" }) }] })).toBe("from-json");
});
