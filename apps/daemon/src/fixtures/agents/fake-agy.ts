/**
 * A stand-in Antigravity `agy` in print mode for the driver's tests (ADR 0079): it reads one
 * `{"event":"user","message":{"role":"user","content":[…]}}` line per prompt from stdin, plays the
 * next list of steps from `FAKE_AGY_SCRIPT` (JSON `{ prompts: Step[][] }`) as NDJSON events on
 * stdout, and ends each prompt with a `result` event, staying alive for the next line until stdin
 * closes. What it saw — its argv, its working directory, every input line — goes to `FAKE_AGY_LOG`
 * (one JSON object per line) for the test to read. `@CWD` in the script is the process's cwd.
 *
 * Steps: `{ say }` a chunk of the agent's words (the step is closed, with usage, when a tool call or
 * the end follows; the result's `response` is what it said after its last tool call);
 * `{ tool: { name, parameters, output } }` one of its own tool calls, reported ACTIVE then DONE;
 * `{ fail }` the prompt's result is an ERROR with that text.
 */
import { appendFileSync } from "node:fs";

type Step =
  | { say: string }
  | { tool: { name: string; parameters?: Record<string, unknown>; output?: string } }
  | { fail: string };

type Script = { prompts: Step[][] };

const script = JSON.parse((process.env.FAKE_AGY_SCRIPT ?? '{"prompts":[]}').replaceAll("@CWD", JSON.stringify(process.cwd()).slice(1, -1))) as Script;
const log = (entry: Record<string, unknown>) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(entry)}\n`);
};
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CONVERSATION = "c1";
let promptIndex = 0;
let stepIndex = 0;

log({ argv: process.argv.slice(2), cwd: process.cwd() });
emit({ event: "init", conversation_id: CONVERSATION, init: { cwd: process.cwd(), tools: [], permission_mode: "always-proceed" } });

const update = (fields: Record<string, unknown>) => emit({ event: "step_update", step_update: { conversation_id: CONVERSATION, ...fields } });

async function play(steps: Step[]): Promise<void> {
  let said = "";
  let speaking: number | null = null;
  const closeSpeech = () => {
    if (speaking === null) return;
    update({ step_index: speaking, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40 } });
    speaking = null;
  };
  for (const step of steps) {
    if ("say" in step) {
      speaking ??= ++stepIndex;
      said += step.say;
      update({ step_index: speaking, state: "ACTIVE", step_type: "agent_response", text_delta: step.say });
    } else if ("tool" in step) {
      closeSpeech();
      said = "";
      const index = ++stepIndex;
      const info = { name: step.tool.name, parameters: step.tool.parameters ?? {} };
      update({ step_index: index, state: "ACTIVE", step_type: "tool", tool_name: step.tool.name, tool_info: info });
      await sleep(10);
      update({ step_index: index, state: "DONE", step_type: "tool", tool_name: step.tool.name, tool_info: { ...info, output: step.tool.output ?? "" } });
    } else if ("fail" in step) {
      closeSpeech();
      emit({ event: "result", result: { conversation_id: CONVERSATION, status: "ERROR", error: step.fail } });
      return;
    }
    await sleep(5);
  }
  closeSpeech();
  emit({ event: "result", result: { conversation_id: CONVERSATION, status: "SUCCESS", response: `${said}\n` } });
}

// One prompt at a time, in the order the lines came.
let chain = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (message.event !== "user") continue;
    log({ input: message });
    const steps = script.prompts[promptIndex++] ?? [{ say: "(no more script)" }];
    chain = chain.then(() => play(steps));
  }
});
process.stdin.on("end", () => process.exit(0));
