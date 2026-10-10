/**
 * Which driver runs each local agent other than Claude Code, and how (ADR 0079). The ACP agents
 * differ only in how a turn's model and effort reach them and in what keeps a Bot's turn asking
 * before it acts; Codex and Antigravity have drivers of their own.
 */
import type { BotRunner } from "@real-bot/protocol";
import type { AgentDriver } from "../driver";
import { acpDriver } from "./acp";
import { codexDriver } from "./codex";
import { agyDriver } from "./agy";

/**
 * OpenCode decides on its own most of what it runs (measured 2026-10-10: only reads outside its
 * directory asked); told to ask for everything, it asks before every command and edit, and the app
 * answers by its rules. Passed per launch in `OPENCODE_CONFIG_CONTENT`, never written to your config.
 */
const OPENCODE_ASK_EVERYTHING = JSON.stringify({ permission: { "*": "ask" } });

export function driverFor(runner: Exclude<BotRunner, "claude_code">): AgentDriver {
  switch (runner) {
    case "codex":
      return codexDriver();
    case "antigravity":
      return agyDriver();
    case "grok":
      // Grok takes its model and effort as flags; `stdio` comes last.
      return acpDriver({
        modelByFlag: true,
        // Grok keeps an MCP server's tools behind its tool search (measured 2026-10-10).
        toolHint: {
          zh: "在 Grok 里，这些工具先用 search_tool 搜（比如搜 deskfolk end_turn），再用 use_tool 按 deskfolk__end_turn 这样的名字调用。",
          en: "In Grok, find these tools with search_tool (search e.g. deskfolk end_turn) and call them with use_tool under names like deskfolk__end_turn.",
        },
        args: (host, base) => {
          const flags = [...(host.model ? ["-m", host.model] : []), ...(host.effort ? ["--reasoning-effort", host.effort] : [])];
          const at = base.lastIndexOf("stdio");
          return at < 0 ? [...base, ...flags] : [...base.slice(0, at), ...flags, ...base.slice(at)];
        },
      });
    case "opencode":
      return acpDriver({
        env: () => ({ OPENCODE_CONFIG_CONTENT: OPENCODE_ASK_EVERYTHING }),
        // OpenCode 2.0 calls an MCP server's tools from code, in its execute tool (measured 2026-10-10).
        toolHint: {
          zh: "在 OpenCode 里，这些工具要在它的 execute 工具里用代码调用，比如 `await tools.deskfolk.end_turn({})`、`await tools.deskfolk.ask_user({ question: \"…\", options: [\"…\"] })`。它们都在，不要以为没有。",
          en: "In OpenCode, call these tools from code in its execute tool, e.g. `await tools.deskfolk.end_turn({})` or `await tools.deskfolk.ask_user({ question: \"…\", options: [\"…\"] })`. They are all there; do not assume they are missing.",
        },
      });
    case "zcode":
    case "custom":
      return acpDriver();
  }
}
