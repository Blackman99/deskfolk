/**
 * What every project session on an Agent Client Protocol agent shares (ADR 0111, ADR 0115): your
 * line as prompt blocks, lines queued while a prompt runs, the `/` commands the agent offered, the
 * names and places its calls take on the task map, and starting its process recorded and killed
 * with the run.
 */
import { consultBrief } from "./project-consult-brief";
import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import type { ClaudeCodeCommand, Message } from "@real-bot/protocol";
import { agentAnnotations } from "./annotation-context";
import { claudeLaunch, killsTree } from "./claude-code/spawn";
import type { AppAction } from "./engine/agent/policy";
import { recordLiveProc } from "./live-procs";
import { pictureMime } from "./loop-pictures";
import type { Store } from "./store";
import { visionImage } from "./vision-image";

/** One prompt block, as ACP takes it. */
export type Block = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
/** A line the agent has not been sent yet: its blocks, the command it starts with, and your message. */
export type Queued = { blocks: Block[]; command: string | null; messageId: string | null };

const PICTURE_BYTES_MAX = 5_000_000;

/** The commands an agent offers in a directory, as runs there heard them (`available_commands_update`). */
export type CommandMemory = { get(dir: string): ClaudeCodeCommand[] | null; set(dir: string, commands: ClaudeCodeCommand[]): void };

export function createCommandMemory(maxAgeMs = 10 * 60_000, now: () => number = Date.now): CommandMemory {
  const kept = new Map<string, { commands: ClaudeCodeCommand[]; at: number }>();
  return {
    get: (dir) => {
      const entry = kept.get(dir);
      return entry && now() - entry.at < maxAgeMs ? entry.commands : null;
    },
    set: (dir, commands) => {
      kept.set(dir, { commands, at: now() });
    },
  };
}

/** An `available_commands_update` as the `/` list reads it, each name once. */
export function acpCommandsOf(listed: unknown): ClaudeCodeCommand[] {
  const out = new Map<string, ClaudeCodeCommand>();
  for (const entry of Array.isArray(listed) ? listed as Array<{ name?: unknown; description?: unknown; input?: { hint?: unknown } | null }> : []) {
    if (typeof entry?.name !== "string" || !entry.name.trim() || out.has(entry.name)) continue;
    out.set(entry.name, { name: entry.name, description: typeof entry.description === "string" ? entry.description : "", argument_hint: typeof entry.input?.hint === "string" ? entry.input.hint : "", aliases: [] });
  }
  return [...out.values()];
}

/** A picture of a line as ACP takes one, shrunk as a Bot's are; null for anything else. */
function pictureBlock(abs: string, name: string): Block | null {
  const mime = pictureMime(name) ?? pictureMime(abs);
  if (!mime) return null;
  try {
    const image = visionImage(abs, mime, statSync(abs));
    if (image.bytes.byteLength > PICTURE_BYTES_MAX) return null;
    return { type: "image", mimeType: image.mime, data: image.bytes.toString("base64") };
  } catch {
    return null;
  }
}

/** Your line as an ACP agent reads it: its pictures first, then your words, any other file by its path; annotations spelled out after. */
export function lineBlocks(store: Store, message: Message, en: boolean): Block[] {
  const notes = agentAnnotations(store, message.id, en ? "en" : "zh");
  // The consultant switch's note, when it is on (ADR 0116 addendum 2026-11-23).
  const brief = consultBrief(store, message, en);
  const pictures: Block[] = [];
  const named: string[] = [];
  for (const att of message.attachments) {
    let abs: string;
    try {
      abs = store.getAttachmentFilePath(att);
    } catch {
      continue;
    }
    const picture = pictureBlock(abs, att.original_filename);
    if (picture) pictures.push(picture);
    else named.push(`${en ? "Attached: " : "附件："}${abs}`);
  }
  for (const crop of notes?.crops ?? []) pictures.push({ type: "image", mimeType: crop.mime, data: Buffer.from(crop.bytes).toString("base64") });
  const text = [message.body.trim() ? message.body : "", ...named, notes?.text ?? "", brief ?? ""].filter(Boolean).join("\n\n");
  return [...pictures, ...(text || pictures.length === 0 ? [{ type: "text" as const, text: text || message.body }] : [])];
}

/** One of an ACP agent's calls as the task map and the chat name it: a command `shell`, a change `write_file`, as Codex's are. */
export function frameOf(action: AppAction): { name: string; place: { tool: string; input: Record<string, unknown> }; command?: string; target?: string } {
  if (action.appName === "shell") return { name: "shell", place: { tool: "Bash", input: { command: action.command ?? "" } }, command: action.command ?? "" };
  const file = action.paths[0];
  if (action.appName === "write_file") return { name: "write_file", place: { tool: "Write", input: { file_path: file ?? action.cwd } }, ...(file ? { target: file } : {}) };
  if (action.appName === "read_file") return { name: "Read", place: { tool: "Read", input: { file_path: file ?? action.cwd } }, ...(file ? { target: file } : {}) };
  if (action.appName === "list_dir") return { name: "Grep", place: { tool: "Grep", input: { path: file ?? action.cwd } }, ...(file ? { target: file } : {}) };
  if (action.appName === "web") return { name: "WebFetch", place: { tool: "WebFetch", input: {} } };
  return { name: action.vendorTool, place: { tool: action.vendorTool, input: {} } };
}

/** What the next prompt takes: a command on its own, or every line of words up to the next command, at once. */
export function takeNext(queue: Queued[]): Queued | null {
  const first = queue[0];
  if (!first) return null;
  if (first.command) return queue.shift()!;
  const at = queue.findIndex((line) => line.command);
  const words = queue.splice(0, at === -1 ? queue.length : at);
  return { blocks: words.flatMap((line) => line.blocks), command: null, messageId: words.at(-1)?.messageId ?? null };
}

/** The agent's process for a run: its own process group, on record for cleanup, ended with the run. */
export function spawnRecorded(store: Store, abort: AbortController, executable: string, args: string[], cwd: string, env: Record<string, string>): ChildProcess {
  const windows = process.platform === "win32";
  const launch = claudeLaunch(executable, args, env);
  const child = spawn(launch.command, launch.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: !windows, windowsHide: true, windowsVerbatimArguments: launch.verbatim });
  if (child.pid) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      recordLiveProc(store, { pid: child.pid, exited }, { pgid: windows ? null : child.pid, command: `${executable} (project session)` });
    } catch {
      // the record is for cleanup after a crash; the run itself does not need it
    }
  }
  killsTree(child);
  const kill = () => child.kill("SIGTERM");
  if (abort.signal.aborted) kill();
  else abort.signal.addEventListener("abort", kill, { once: true });
  return child;
}
