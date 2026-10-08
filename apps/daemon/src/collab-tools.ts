import type { AskSpec, Bot, McpServer, Memory, Message, ModelSpeed, Provider, Routine, SessionDetail, Skill } from "@real-bot/protocol";
import { listAnnotations, resolveAnnotation } from "./collab-tools/annotations";
import { addMember, askUser, checkBack, createDirect, createGroup, delegate, endTurn, listSessions, removeMember, sendMessage, workOn } from "./collab-tools/conversation";
import { addEndpoint, deleteEndpoint, listEndpoints, measureModelTool, updateEndpoint, updateModelSettings } from "./collab-tools/endpoints";
import { assertActive } from "./collab-tools/guards";
import { addMcpServer, deleteMcpServer, listMcpServers, updateMcpServer } from "./collab-tools/mcp";
import { forget, remember } from "./collab-tools/memory";
import { createBot, listBots, updateProfile } from "./collab-tools/roster";
import { createRoutine, deleteRoutine, listRoutines, updateRoutine } from "./collab-tools/routines";
import { createSkill, deleteSkill, listSkills, readSkill, updateSkill } from "./collab-tools/skills";
import { describeData, queryData, readDataLog } from "./data-tools";
import { HttpError } from "./errors";
import type { LoopPicture } from "./loop-pictures";
import { editPrompt, listPrompts, readPrompt, resetPrompt } from "./prompt-tools";
import type { TurnAdmission } from "./quiesce";
import type { Store } from "./store";
import { toolFail as fail } from "./tool-result";

export type ToolResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  waitAsk?: { question: string; spec: AskSpec | null };
  waitApproval?: {
    kind_key: string;
    target: string;
    summary: string;
    requiresApiKey?: boolean;
    /** Runs the call once you allow it; `approval_id` / `message_id` say which card let it through. */
    run: (opts?: { api_key?: string; approval_id?: string; message_id?: string | null }) => Promise<ToolResult> | ToolResult;
  };
  /** A picture `read_file` found; the engine shows it after the hop's tool results (see loop-pictures.ts). */
  picture?: LoopPicture;
  /** Lines of yours the call filed under a job (`work_on`), for the scribe; not shown to the model. */
  filed?: string[];
  emitted: Array<
    | { kind: "bot"; bot: Bot; deleted_at: string | null }
    | { kind: "session"; session: SessionDetail }
    | { kind: "message"; message: Message }
    | { kind: "participation"; message: Message }
    | { kind: "routine"; routine: Routine }
    | { kind: "routine_removed"; id: string }
    | { kind: "skill"; skill: Skill }
    | { kind: "skill_removed"; id: string }
    | { kind: "memory"; memory: Memory }
    | { kind: "memory_removed"; id: string }
    | { kind: "provider"; provider: Provider }
    | { kind: "provider_removed"; id: string }
    | { kind: "mcp"; server: McpServer }
    | { kind: "mcp_removed"; id: string }
    | { kind: "settings" }
  >;
};

export type ToolCtx = {
  store: Store;
  botId: string;
  sessionId: string;
  turnId: string;
  /**
   * Set on the learning hop. Remember then stamps the chain it came from, and create_skill is
   * refused: one incident becomes a memory, and only an existing skill may be revised.
   */
  learnedChainId?: string | null;
  parentId: string | null;
  approved?: boolean;
  approvalApiKey?: string;
  /** The approval card that let this call through, and its message, when one did (a prompt edit records them). */
  approvalId?: string | null;
  approvalMessageId?: string | null;
  writtenPaths?: string[];
  /** Every file the turn wrote, cited in a message or not (`Live.producedPaths`). */
  producedPaths?: string[];
  /** This turn's work dir (its ticket's), so a path the Bot wrote from its shell's point of view still resolves. */
  workDir?: string | null;
  /** The plan dir this turn belongs to: what "this job's" annotations span, whichever ticket is on. */
  planDir?: string | null;
  /** Unknown `@token`s already rejected once this turn; a resend with them goes through. Absent = always reject. */
  mentionWarned?: Set<string>;
  /** This turn was opened by the app's plan call-back, so a reply repeating one already given is dropped. */
  planNudge?: boolean;
  /** Names in this hop's tools array (built-in + `mcp_…`). Absent = skip the stale-name check in read_skill. */
  availableToolNames?: ReadonlySet<string>;
  admission?: TurnAdmission;
  signal?: AbortSignal;
  /**
   * Times a model and checks it calls tools, recording its speed (ADR 0067): the engine's speed
   * test, for measure_model. Absent where no engine runs the call; the tool then says so.
   */
  measure?: (providerId: string, model: string, signal: AbortSignal) => Promise<ModelSpeed>;
  /**
   * What the call's words say, as the engine read them before it runs (ADR 0055): `noWork` for a
   * `send_message` body that is only a no-work closer; `lastWord` for an `end_turn`, the segment's
   * last word and the sentence in which it says the work is still going; `goAhead` for a question
   * to the user (`ask_user`, a blocked ending) that only asks their OK to go on (ADR 0058). Absent,
   * the word lists read them here, and none of them reads a go-ahead.
   */
  read?: { noWork?: boolean; lastWord?: { said: string; later: string | null }; goAhead?: boolean };
};

export async function runCollabTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    assertActive(ctx);
    if (["create_group", "create_direct", "add_member"].includes(name)) ctx.admission?.assertNew();
    switch (name) {
      case "send_message":
        return sendMessage(ctx, args);
      case "plan_items": {
        if (!ctx.turnId) return fail("invalid_args", "plan_items needs a turn");
        return { ok: true, data: ctx.store.planItems({ turnId: ctx.turnId, items: args.items }), emitted: [] };
      }
      case "create_bot":
        return await createBot(ctx, args);
      case "list_bots":
        return listBots(ctx);
      case "update_profile":
        return await updateProfile(ctx, args);
      case "list_sessions":
        return listSessions(ctx);
      case "create_group":
        return createGroup(ctx, args);
      case "create_direct":
        if (ctx.store.capabilities().engine_level >= 3) return fail("use_delegate", "to ask a teammate to work, use delegate");
        return createDirect(ctx, args);
      case "delegate":
        // Never a filing refusal: at the desk delegate binds the segment before it runs, so what it
        // refuses is a bound segment's ordinary failed call.
        return delegate(ctx, args);
      case "add_member":
        return addMember(ctx, args);
      case "remove_member":
        return removeMember(ctx, args);
      case "ask_user":
        return askUser(ctx, args);
      case "check_back":
        return checkBack(ctx, args);
      case "work_on": {
        const result = workOn(ctx, args);
        if (!result.ok && ["invalid_candidate", "invalid_args", "locked_attribution"].includes(result.error?.code ?? "")) ctx.store.noteFilingBounce(ctx.turnId);
        return result;
      }
      case "end_turn":
        // The engine ends the turn once the hop's calls are done (see executeTools). What the Bot
        // says it did with each line it read is recorded now, on those inbox rows (ADR 0040 P4a).
        return endTurn(ctx, args);
      case "list_routines":
        return listRoutines(ctx, args);
      case "create_routine":
        return createRoutine(ctx, args);
      case "update_routine":
        return updateRoutine(ctx, args);
      case "delete_routine":
        return deleteRoutine(ctx, args);
      case "list_skills":
        return listSkills(ctx);
      case "read_skill":
        return readSkill(ctx, args);
      case "create_skill":
        return createSkill(ctx, args);
      case "update_skill":
        return updateSkill(ctx, args);
      case "delete_skill":
        return deleteSkill(ctx, args);
      case "remember":
        return remember(ctx, args);
      case "forget":
        return forget(ctx, args);
      case "list_annotations":
        return listAnnotations(ctx, args);
      case "resolve_annotation":
        return resolveAnnotation(ctx, args);
      case "list_endpoints":
        return await listEndpoints(ctx);
      case "add_endpoint":
        return await addEndpoint(ctx, args);
      case "update_endpoint":
        return await updateEndpoint(ctx, args);
      case "delete_endpoint":
        return await deleteEndpoint(ctx, args);
      case "measure_model":
        return await measureModelTool(ctx, args);
      case "update_model_settings":
        return await updateModelSettings(ctx, args);
      case "list_mcp_servers":
        return await listMcpServers(ctx);
      case "add_mcp_server":
        return await addMcpServer(ctx, args);
      case "update_mcp_server":
        return await updateMcpServer(ctx, args);
      case "delete_mcp_server":
        return await deleteMcpServer(ctx, args);
      // Built-in prompts (ADR 0064): reading is free; an edit or a reset waits for your approval card.
      case "list_prompts":
        return listPrompts(ctx, args);
      case "read_prompt":
        return readPrompt(ctx, args);
      case "edit_prompt":
        return editPrompt(ctx, args);
      case "reset_prompt":
        return resetPrompt(ctx, args);
      // This machine's records, read-only (ADR 0065).
      case "describe_data":
        return await describeData(ctx, args);
      case "query_data":
        return await queryData(ctx, args);
      case "read_data_log":
        return readDataLog(ctx, args);
      default:
        return fail("failed", `unknown tool: ${name}`);
    }
  } catch (error) {
    if (["work_on", "end_turn"].includes(name) && error instanceof HttpError && ["invalid_candidate", "invalid_args", "locked_attribution", "not_found"].includes(error.code)) {
      ctx.store.noteFilingBounce(ctx.turnId);
    }
    if (error instanceof HttpError) return fail(error.code, error.message);
    return fail("failed", "tool failed");
  }
}
