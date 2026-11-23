/**
 * Consultants (ADR 0116): a project session's agent asks another local agent — or another model —
 * to talk a plan over, when you ask it to. The app gives every run of a session of yours one tool,
 * `consult`; a call starts (or goes on with) a consultant: a project session of its own in the same
 * directory, under this one, that only looks (`projectPermissionMode`). What the agent says to it
 * is the consultant's next line; what the consultant answers comes back as the tool's result. A
 * question the consultant asks goes back the same way, for the asking agent to answer (or to ask
 * you). Nothing here reads your words: whether to ask, whom, and how often is the agent's.
 *
 * A consultant is not listed anywhere: each call is a task on the asking run (`consult_` ids), a
 * row under the agent's reply that opens onto what the consultant said. When the asking run ends,
 * however it ends, its consultants stop with it.
 *
 * Each agent cuts a tool call off at its own limit (measured 2026-11-23: Antigravity at 3 min), so
 * a call waits at most `CONSULT_WAIT_MS` for its agent and then says the consultant is still at it;
 * calling again with the consultant's id waits on.
 */
import {
  CONSULT_TASK_PREFIX,
  consultTaskParts,
  isConsultTask,
  isProjectAgent,
  PROJECT_AGENTS,
  type AgentRun,
  type AgentTask,
  type AgentTaskDetail,
  type AgentTaskStep,
  type AskSpec,
  type Message,
  type ProjectAgent,
} from "@real-bot/protocol";
import { AGENT_MCP_PREFIX, AGENT_MCP_TOKEN_ENV, AGENT_MCP_URL_ENV, agentMcpPort, mintAgentMcp, revokeAgentMcp } from "./agent-mcp/bridge";
import { agentMcpShim } from "./agent-mcp/launch";
import type { AgentTool, AgentToolBridge } from "./engine/agent-runner";
import { isoNow } from "./ids";
import type { ProjectRunner } from "./project-runner";
import type { Store } from "./store";

/** The tool's name; the server it comes on is the app's own (`deskfolk`), as a Bot's tools are. */
export const CONSULT_TOOL = "consult";
export const CONSULT_SERVER = "deskfolk";

/**
 * How long one call waits for the consultant before it says it is still at it, by the asking agent
 * (measured 2026-11-23). Claude Code's limit is the app's own (the in-process server's `timeout`).
 * The others reach the tool through the daemon's stdio shim, whose request to the daemon is cut at
 * about 6 minutes, and Antigravity cuts any MCP call at 3. Each stays well inside.
 */
export const CONSULT_WAIT_MS: Record<ProjectAgent, number> = {
  claude_code: 30 * 60_000,
  codex: 4 * 60_000,
  antigravity: 150_000,
  grok: 4 * 60_000,
};
/** What Codex is told it may wait on the app's MCP server, in seconds: past any wait above. */
export const CONSULT_CODEX_TIMEOUT_S = 24 * 60 * 60;

const POLL_MS = 400;
const AGENT_NAMES: Record<ProjectAgent, string> = { claude_code: "Claude Code", codex: "Codex", antigravity: "Antigravity", grok: "Grok" };
const SUMMARY_MAX = 300;

/** The tool as every asking agent is offered it. */
export const CONSULT_TOOL_SPEC: AgentTool = {
  name: CONSULT_TOOL,
  readOnly: true,
  description: [
    "Ask another local coding agent (Claude Code, Codex, Antigravity or Grok), or another model, to talk a plan or a question over with you: a consultant.",
    "Use it only when the user asks you to bring in another agent or model; never on your own.",
    "The consultant works in this same project directory and only looks: it reads and searches, and changes nothing.",
    "It sees only what you send in `message`, so give it what it needs: the plan, the files to look at, the question.",
    "Its answer comes back as this tool's result. To go on with the same consultant, call again with `consultant` set to its id (the result's first line gives it).",
    "If it asks you something, answer it the same way, or ask the user when you cannot.",
    "If the result says it is still working, call again with only `consultant` to keep waiting.",
    "Tell the user what came of it in your own words.",
  ].join(" "),
  inputSchema: {
    properties: {
      agent: { type: "string", enum: [...PROJECT_AGENTS], description: "Which agent to ask: claude_code, codex, antigravity or grok. Leave it out when going on with `consultant`." },
      model: { type: "string", description: "The model it runs on, as that agent names it (Claude Code: opus, sonnet, haiku or a full id; Codex: for example gpt-5.6-terra). Leave it out for that agent's default." },
      effort: { type: "string", description: "Its thinking level, as that agent names it (low, medium, high). Leave it out for its default." },
      message: { type: "string", description: "What you say to it: the question, the plan and the context it needs, or your answer to its question. Leave it out only to keep waiting for an answer still coming." },
      consultant: { type: "string", description: "The id of a consultant asked before in this session, to go on with it." },
    },
  },
};

/** The tool for one run of a session of yours: in process (Claude Code), or through the stdio shim. */
export type ConsultMount = {
  bridge: AgentToolBridge;
  /** The command an agent in a process of its own starts to reach the tool, made on first use. */
  stdio(): { command: string; args: string[]; env: Record<string, string> };
  /** The run is over: its token is gone. */
  close(): void;
};

export type ConsultDesk = {
  /** The consult tool for a run of one of your sessions; null for a consultant's own run (it asks no one). */
  mount(sessionId: string, runId: string): ConsultMount | null;
  /** Stops a session's consultants (its run stopped, its history is cleared, it is deleted). */
  stopConsultants(sessionId: string): void;
  /** Stops the consultant a task asked; false for any other task. */
  stopTask(runId: string, taskId: string): boolean;
  close(): void;
};

type Outcome =
  | { kind: "answer"; text: string }
  | { kind: "question"; text: string }
  | { kind: "working" }
  | { kind: "failed"; text: string }
  | { kind: "stopped"; text: string };

export function createConsultDesk(deps: { store: Store; runner: () => ProjectRunner; pollMs?: number; waitMs?: number }): ConsultDesk {
  const { store } = deps;
  const pollMs = deps.pollMs ?? POLL_MS;
  /** Each asking run's consultants: they stop once it ends. */
  const asked = new Map<string, { sessionId: string; consultants: Set<string> }>();
  let watching: ReturnType<typeof setInterval> | null = null;
  const en = () => store.settingsCached().locale === "en";

  const live = (run: AgentRun | null | undefined) => !!run && (run.status === "running" || run.status === "waiting_approval");

  function watch(): void {
    if (watching || asked.size === 0) return;
    watching = setInterval(() => {
      for (const [runId, entry] of asked) {
        let run: AgentRun | null = null;
        try {
          run = store.getAgentRun(runId);
        } catch {
          run = null;
        }
        if (live(run)) continue;
        asked.delete(runId);
        for (const consultant of entry.consultants) stopOne(consultant);
      }
      if (asked.size === 0 && watching) {
        clearInterval(watching);
        watching = null;
      }
    }, Math.max(pollMs, 250));
    watching.unref?.();
  }

  function stopOne(consultant: string): void {
    try {
      deps.runner().stopSession(consultant);
    } catch (error) {
      console.error(`[consult ${consultant}] could not stop`, error);
    }
  }

  /** The consultant's lines after `seq`, oldest first. */
  function linesAfter(consultant: string, seq: number): Array<{ id: string; kind: string; author: string; body: string; ask_spec: string | null; created_at: string; message_seq: number }> {
    return store.db
      .query<{ id: string; kind: string; author: string; body: string; ask_spec: string | null; created_at: string; message_seq: number }, [string, number]>(
        `SELECT id, kind, author, body, ask_spec, created_at, message_seq FROM messages WHERE session_id = ? AND message_seq > ? ORDER BY message_seq`,
      )
      .all(consultant, seq);
  }
  const seqOf = (messageId: string) => store.db.query<{ message_seq: number }, [string]>(`SELECT message_seq FROM messages WHERE id = ?`).get(messageId)?.message_seq ?? 0;

  /** What the consultant said to a line, up to the next line it was asked: its replies joined. */
  function replyTo(consultant: string, line: string): string {
    const said: string[] = [];
    for (const row of linesAfter(consultant, seqOf(line))) {
      if (row.kind === "user") break;
      if (row.kind === "bot" && row.body.trim()) said.push(row.body.trim());
    }
    return said.join("\n\n");
  }

  /** The app's own last line about a run that ended badly (why it stopped), when there is one. */
  function lastNote(consultant: string, line: string): string | null {
    const notes = linesAfter(consultant, seqOf(line)).filter((row) => row.kind === "system");
    return notes.at(-1)?.body ?? null;
  }

  function questionsOf(run: AgentRun): string {
    const lines = (run.asks ?? []).flatMap((id, index) => {
      try {
        const ask = store.getMessage(id);
        const spec: AskSpec | null | undefined = ask.ask;
        const options = spec?.options?.length ? (en() ? ` (options: ${spec.options.map((o) => o.label).join(" / ")})` : `（选项：${spec.options.map((o) => o.label).join(" / ")}）`) : "";
        return [`${index + 1}. ${ask.body}${options}`];
      } catch {
        return [];
      }
    });
    return lines.join("\n");
  }

  /** Where a consultant stands on the line it was asked (`line`), the run that took it being the one started at or after `since`. */
  function outcome(consultant: string, line: string, before: string | null): Outcome | null {
    const run = store.latestAgentRun(consultant);
    // Its line has not reached a run of its own yet: the last one is still winding down.
    if (!run || (run.id === before && !live(run))) return null;
    if (run.status === "waiting_approval" && (run.asks ?? []).length > 0) return { kind: "question", text: questionsOf(run) };
    if (run.status === "waiting_approval" && run.approval) {
      // A consultant only looks: whatever it asks leave for is refused, and it goes on.
      try {
        deps.runner().answer(run.id, false);
      } catch {
        // gone meanwhile
      }
      return null;
    }
    if (run.status === "completed" || (run.status === "running" && run.idle)) return { kind: "answer", text: replyTo(consultant, line) };
    if (run.status === "stopped" || run.status === "interrupted") return { kind: "stopped", text: replyTo(consultant, line) };
    if (run.status === "failed") return { kind: "failed", text: [run.error ?? lastNote(consultant, line) ?? "", replyTo(consultant, line)].filter(Boolean).join("\n\n") };
    return null;
  }

  function taskOf(runId: string, id: string): AgentTask | null {
    try {
      return store.getAgentRun(runId).tasks?.find((task) => task.id === id) ?? null;
    } catch {
      return null;
    }
  }

  /** Puts the task on the asking run, or changes it there. */
  function putTask(runId: string, task: AgentTask): void {
    try {
      const run = store.getAgentRun(runId);
      const others = (run.tasks ?? []).filter((one) => one.id !== task.id);
      store.updateAgentRun(runId, { tasks: [...others, task] });
    } catch (error) {
      console.error(`[consult] could not keep the task on ${runId}`, error);
    }
  }

  function header(consultant: string): string {
    const project = store.projectOf(consultant);
    const agent = project ? AGENT_NAMES[project.agent] : "?";
    return `${en() ? "Consultant" : "参谋"} ${consultant} · ${agent}${project?.model ? ` · ${project.model}` : ""}`;
  }

  /** The first line a consultant reads: who asks, what it may do, then what it was asked. */
  function opener(host: ProjectAgent, hostModel: string | null, agent: ProjectAgent, message: string): string {
    const who = `${AGENT_NAMES[host]}${hostModel ? `（${hostModel}）` : ""}`;
    if (en()) {
      const may = agent === "codex"
        ? "You may read files and run commands that only look; your sandbox stops anything that writes."
        : agent === "antigravity"
          ? "You may read and search files. Do not change files and do not run any command: either ends this consultation."
          : "You may read and search files. You cannot change files or run commands.";
      return `[Deskfolk consultant] ${who.replace("（", " (").replace("）", ")")} in this project asks you in to talk a plan over; it takes your answer back to the user. ${may} If something is unclear, ask: the question goes back to it.\n\n${message}`;
    }
    const may = agent === "codex"
      ? "可以读文件、跑只看不改的命令；写东西的操作会被沙盒挡下。"
      : agent === "antigravity"
        ? "可以读文件、搜索；不要改文件，也不要跑任何命令，那会让这次请教停下。"
        : "可以读文件、搜索；不能改文件，也不能跑命令。";
    return `[Deskfolk 参谋] 同一个项目里的 ${who} 请你一起讨论方案，会把你的回答带回去给用户。${may}有不清楚的可以直接反问，问题会转给它。\n\n${message}`;
  }

  /** A follow-up goes in as said, but one that looks like a command is not run as one. */
  const asLine = (message: string) => (/^\s*\//.test(message) ? `› ${message}` : message);

  const fail = (text: string) => ({ text, isError: true });

  async function call(sessionId: string, runId: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const zh = !en();
    const parent = store.projectOf(sessionId);
    if (!parent) return fail(zh ? "这个会话已经不在了" : "this session is gone");
    if (parent.parentId) return fail(zh ? "参谋不能再请参谋" : "a consultant asks no consultant of its own");
    const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
    const message = text("message");
    let consultant = text("consultant");
    let agent: ProjectAgent;
    if (consultant) {
      const project = store.projectOf(consultant);
      if (!project || project.parentId !== sessionId) {
        return fail(zh ? `这个会话里没有参谋 ${consultant}；要请新的参谋，不填 consultant` : `there is no consultant ${consultant} in this session; leave consultant out to ask a new one`);
      }
      agent = project.agent;
    } else {
      const named = text("agent");
      if (!isProjectAgent(named)) return fail(zh ? `agent 要是 ${PROJECT_AGENTS.join("、")} 之一` : `agent must be one of ${PROJECT_AGENTS.join(", ")}`);
      if (!message) return fail(zh ? "message 不能为空：告诉参谋要讨论什么" : "message is required: tell the consultant what to talk over");
      agent = named;
      const parentName = store.getSession(sessionId).name;
      const created = store.createConsultantSession({
        parentId: sessionId, agent, model: text("model") || null, effort: text("effort") || null,
        name: `${zh ? "参谋" : "Consultant"} · ${AGENT_NAMES[agent]}${parentName ? ` — ${parentName}` : ""}`.slice(0, 120),
      });
      consultant = created.id;
    }

    const entry = asked.get(runId) ?? { sessionId, consultants: new Set<string>() };
    entry.consultants.add(consultant);
    asked.set(runId, entry);
    watch();

    // The line it is asked, and the run of it before: an answer to its question goes on in that run.
    let line: string;
    let before: string | null;
    const latest = store.latestAgentRun(consultant);
    if (message) {
      if (live(latest) && latest!.status === "running" && !latest!.idle) {
        return fail(zh ? `${header(consultant)} 还在回答上一句：只带 consultant 再调一次，等它说完` : `${header(consultant)} is still answering: call again with only consultant to wait for it`);
      }
      const first = !store.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND kind = 'user'`).get(consultant)?.n;
      const body = first ? opener(parent.agent, parent.model, agent, message) : asLine(message);
      const posted: Message = store.transaction(() => store.postMessage(consultant, { body }));
      line = posted.id;
      // A question it waits on takes this line as its answer, in the same run.
      before = live(latest) ? null : (latest?.id ?? null);
      deps.runner().heard(posted);
    } else {
      const last = store.db.query<{ id: string }, [string]>(`SELECT id FROM messages WHERE session_id = ? AND kind = 'user' ORDER BY message_seq DESC LIMIT 1`).get(consultant);
      if (!last) return fail(zh ? "这个参谋还没被问过：带上 message" : "this consultant has not been asked anything yet: send a message");
      line = last.id;
      before = null;
    }

    const project = store.projectOf(consultant)!;
    const taskId = `${CONSULT_TASK_PREFIX}${consultant}_${line}`;
    const kept = taskOf(runId, taskId);
    const task: AgentTask = kept ?? {
      id: taskId, tool_use_id: null, kind: "subagent", status: "running", description: firstLine(message) ?? header(consultant), command: null,
      agent_type: AGENT_NAMES[project.agent], activity: null, summary: null, tool_uses: null, tokens: null, started_at: isoNow(), ended_at: null, output_file: null,
      agent: project.agent, model: project.model,
    };
    putTask(runId, { ...task, status: "running", ended_at: null });
    try {
      store.updateAgentRun(runId, { activity: zh ? `请教 ${AGENT_NAMES[project.agent]}` : `Consulting ${AGENT_NAMES[project.agent]}` });
    } catch {
      // the run is gone
    }

    const budget = deps.waitMs ?? CONSULT_WAIT_MS[parent.agent];
    const started = Date.now();
    let result: Outcome = { kind: "working" };
    while (Date.now() - started < budget) {
      let host: AgentRun | null = null;
      try {
        host = store.getAgentRun(runId);
      } catch {
        host = null;
      }
      if (!live(host)) {
        stopOne(consultant);
        result = { kind: "stopped", text: "" };
        break;
      }
      const now = outcome(consultant, line, before);
      if (now) {
        result = now;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const ended = result.kind === "answer" || result.kind === "failed" || result.kind === "stopped";
    putTask(runId, {
      ...task,
      status: result.kind === "answer" ? "completed" : result.kind === "failed" ? "failed" : result.kind === "stopped" ? "stopped" : "running",
      summary: result.kind === "working" ? null : clipLine(result.text),
      ended_at: ended ? isoNow() : null,
    });
    try {
      if (live(store.getAgentRun(runId))) store.updateAgentRun(runId, { activity: null });
    } catch {
      // the run is gone
    }
    const head = header(consultant);
    switch (result.kind) {
      case "answer":
        return { text: `${head}\n\n${result.text || (zh ? "（参谋没有说什么）" : "(the consultant said nothing)")}`, isError: false };
      case "question":
        return {
          text: zh
            ? `${head} 在问你：\n${result.text}\n\n把回答写在 message 里、带上 consultant=${consultant} 再调一次；你答不了的，问用户。`
            : `${head} asks you:\n${result.text}\n\nCall again with your answer in message and consultant=${consultant}; ask the user what you cannot answer.`,
          isError: false,
        };
      case "working":
        return { text: zh ? `${head} 还在想。只带 consultant=${consultant} 再调一次，接着等它的回答。` : `${head} is still working. Call again with only consultant=${consultant} to keep waiting for its answer.`, isError: false };
      case "stopped":
        return fail(`${head}${zh ? " 停下了" : " was stopped"}${result.text ? `${zh ? "，停下前说了：" : "; before that it said:"}\n\n${result.text}` : ""}`);
      case "failed":
        return fail(`${head}${zh ? " 出错了：" : " failed: "}${result.text || "?"}`);
    }
  }

  return {
    mount(sessionId, runId) {
      const project = store.projectOf(sessionId);
      if (!project || project.parentId) return null;
      const bridge: AgentToolBridge = {
        tools: [CONSULT_TOOL_SPEC],
        // Grok keeps MCP tools behind its own search: this says what to search for.
        instructions: "Deskfolk's consult tool asks another local agent (Claude Code, Codex, Antigravity, Grok) or another model for its view on a plan. When the user asks you to bring in, consult or ask another agent or model, use the tool named consult.",
        call: (name, args) => (name === CONSULT_TOOL ? call(sessionId, runId, args) : Promise.resolve(fail(`${name} is not a tool here`))),
      };
      let token: string | null = null;
      return {
        bridge,
        stdio() {
          token ??= mintAgentMcp(runId, bridge);
          const shim = agentMcpShim();
          const url = `http://127.0.0.1:${agentMcpPort() ?? 17890}${AGENT_MCP_PREFIX}${token}`;
          return { command: shim.command, args: shim.args, env: { [AGENT_MCP_URL_ENV]: url, [AGENT_MCP_TOKEN_ENV]: token } };
        },
        close() {
          revokeAgentMcp(token);
          token = null;
        },
      };
    },
    stopConsultants(sessionId) {
      for (const consultant of store.consultantsOf(sessionId)) stopOne(consultant);
      for (const [runId, entry] of asked) if (entry.sessionId === sessionId) asked.delete(runId);
    },
    stopTask(_runId, taskId) {
      const parts = consultTaskParts(taskId);
      if (!parts) return false;
      if (store.projectOf(parts.consultant)?.parentId) stopOne(parts.consultant);
      return true;
    },
    close() {
      if (watching) clearInterval(watching);
      watching = null;
      asked.clear();
    },
  };
}

/** The marks the app's opener starts with, in either language. */
const OPENER = /^\[Deskfolk (?:参谋|consultant)\][^\n]*\n\n/;

/** A consultant's first line without the app's opener: what the asking agent said. */
export function withoutOpener(text: string): string {
  return text.replace(OPENER, "");
}

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).find((part) => part.trim())?.trim();
  return line ? (line.length > 120 ? `${line.slice(0, 119)}…` : line) : null;
}

function clipLine(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/**
 * A consultant's task opened (`GET /v1/agent-runs/:id/tasks/:task`): what it was asked, the model
 * it runs on, and what it said to that line — read from its own session, which the app keeps.
 */
export function consultDetail(store: Store, task: AgentTask): AgentTaskDetail | null {
  if (!isConsultTask(task)) return null;
  const parts = consultTaskParts(task.id);
  if (!parts) return null;
  const project = store.projectOf(parts.consultant);
  let prompt: string | null = null;
  const steps: AgentTaskStep[] = [];
  try {
    // What the asking agent said; the app's opener before it is the app's, not the question.
    prompt = withoutOpener(store.getMessage(parts.message).body);
    const seq = store.db.query<{ message_seq: number }, [string]>(`SELECT message_seq FROM messages WHERE id = ?`).get(parts.message)?.message_seq ?? 0;
    const rows = store.db
      .query<{ kind: string; body: string; created_at: string }, [string, number]>(`SELECT kind, body, created_at FROM messages WHERE session_id = ? AND message_seq > ? ORDER BY message_seq`)
      .all(parts.consultant, seq);
    for (const row of rows) {
      if (row.kind === "user") break;
      if (!row.body.trim()) continue;
      steps.push({ kind: "say", at: row.created_at, text: row.kind === "ask" ? `？ ${row.body}` : row.body });
    }
  } catch {
    // its session is gone: the task says what it can
  }
  return { task, output: null, output_bytes: null, prompt, model: project?.model ?? task.model ?? null, steps };
}
