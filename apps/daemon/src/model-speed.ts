/**
 * The speed test a model's settings run (ADR 0067): one short streamed reply to time how fast the
 * model writes, and one request offering a tool to see whether it calls it. A model on this
 * computer writes at a few to a few dozen tokens a second, and how long a hop may stream is sized
 * from that (`hop-limits.ts`); a model that never calls a tool cannot do a Bot's work at all, and
 * the settings say so before a turn finds out.
 */
import type { ModelSpeed } from "@real-bot/protocol";
import type { CompletionsClient, CompletionRequest, MappedUsage } from "./completions";

/** What is timed: a list long enough to time, in words so every model tokenizes it alike. */
const SPEED_PROMPT = "Count from one to one hundred in English words, separated by commas. Output only the list.";
const SPEED_CAP = 800;
const TOOL_PROMPT = "What time is it? Call the get_time tool to find out; do not answer from memory.";
const TOOL_CAP = 1024;
const TIME_TOOL = {
  type: "function",
  function: {
    name: "get_time",
    description: "Returns the current time.",
    parameters: { type: "object", properties: {} },
  },
};

/**
 * Share of the measured speed that is recorded. The test reads a prompt of a few dozen tokens; a
 * Bot's hop reads tens of thousands, and a model writes slower the more it has read.
 */
export const RECORDED_SHARE = 0.6;

/** Tokens per second over the stream after its first byte; null when there was too little to time. */
export function writingSpeed(input: { sentAt: number; firstAt: number | null; endAt: number; usage: MappedUsage | null; content: string }): number | null {
  if (input.firstAt === null) return null;
  const seconds = (input.endAt - input.firstAt) / 1000;
  const tokens = input.usage?.output_tokens ?? Math.round(input.content.length / 4);
  if (seconds < 0.2 || tokens < 8) return null;
  return Math.round(((tokens - 1) / seconds) * 10) / 10;
}

export type SpeedTarget = Pick<CompletionRequest, "baseUrl" | "apiKey" | "apiFormat" | "model">;

/** Runs both requests one after the other on `target`. Never throws; what failed comes back null. */
export async function measureModel(
  completions: CompletionsClient,
  target: SpeedTarget,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<Omit<ModelSpeed, "recorded_tps">> {
  const sentAt = now();
  let firstAt: number | null = null;
  const mark = () => {
    firstAt ??= now();
  };
  const speed = await completions.complete({
    ...target,
    thinkingLevel: "none",
    messages: [{ role: "user", content: SPEED_PROMPT }],
    tools: [],
    signal,
    maxTokens: SPEED_CAP,
    onEvent: mark,
    onToken: mark,
    // You are waiting on it: it does not queue behind a Bot's hop in the app (the server may still).
    lane: "reading",
  });
  const endAt = now();
  const tokensPerSecond = speed.ok
    ? writingSpeed({ sentAt, firstAt, endAt, usage: speed.usage, content: speed.content })
    : null;
  const firstByteMs = speed.ok && firstAt !== null ? (firstAt as number) - sentAt : null;
  if (signal.aborted) return { tokens_per_second: tokensPerSecond, first_byte_ms: firstByteMs, tool_call: null, failed: speed.ok ? null : speed.failKind };
  const tool = await completions.complete({
    ...target,
    thinkingLevel: "none",
    messages: [{ role: "user", content: TOOL_PROMPT }],
    tools: [TIME_TOOL],
    signal,
    maxTokens: TOOL_CAP,
    lane: "reading",
  });
  return {
    tokens_per_second: tokensPerSecond,
    first_byte_ms: firstByteMs,
    tool_call: tool.ok ? tool.toolCalls.some((call) => call.name === "get_time") : null,
    failed: !speed.ok ? speed.failKind : !tool.ok ? tool.failKind : null,
  };
}
