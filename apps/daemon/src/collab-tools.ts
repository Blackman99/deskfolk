import {
  BORING_AVATAR_VARIANTS,
  USER_MEMBER,
  generateBoringAvatar,
  isThinkingLevel,
  type BoringAvatarVariant,
  type Bot,
  type ThinkingLevel,
  type McpHeader,
  type McpServer,
  type McpTransport,
  type Memory,
  type Message,
  type Provider,
  type Routine,
  type Skill,
  type SessionDetail,
  type SessionSummary,
} from "@real-bot/protocol";
import { avatarMimeFromPath, rasterFileToAvatarDataUri } from "./avatar-image";
import { parseMentions } from "./mentions";
import { isNoWorkCloser } from "./no-work";
import { HttpError } from "./errors";
import type { TurnAdmission } from "./quiesce";
import { normalizeModelCatalog } from "./models";
import { type Store } from "./store";
import { extractWorkspacePathsFromBody, linkifyWorkspacePaths, mergeCitedPaths } from "./artifact-paths";
import { classifyPath } from "./workspace-paths";

const DEFAULT_ENDPOINT_GUARD =
  "cannot modify the default endpoint's URL or key, or delete it";

export type ToolResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
  waitAsk?: { question: string };
  waitApproval?: {
    kind_key: string;
    target: string;
    summary: string;
    requiresApiKey?: boolean;
    run: (opts?: { api_key?: string }) => Promise<ToolResult> | ToolResult;
  };
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
  parentId: string | null;
  approved?: boolean;
  approvalApiKey?: string;
  writtenPaths?: string[];
  /** Unknown `@token`s already rejected once this turn; a resend with them goes through. Absent = always reject. */
  mentionWarned?: Set<string>;
  /** Names in this hop's tools array (built-in + `mcp_…`). Absent = skip the stale-name check in read_skill. */
  availableToolNames?: ReadonlySet<string>;
  admission?: TurnAdmission;
};

export async function runCollabTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (["create_group", "create_direct", "add_member"].includes(name)) ctx.admission?.assertNew();
    switch (name) {
      case "send_message":
        return sendMessage(ctx, args);
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
        return createDirect(ctx, args);
      case "add_member":
        return addMember(ctx, args);
      case "remove_member":
        return removeMember(ctx, args);
      case "ask_user":
        return askUser(ctx, args);
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
      case "list_endpoints":
        return await listEndpoints(ctx);
      case "add_endpoint":
        return await addEndpoint(ctx, args);
      case "update_endpoint":
        return await updateEndpoint(ctx, args);
      case "delete_endpoint":
        return await deleteEndpoint(ctx, args);
      case "list_mcp_servers":
        return await listMcpServers(ctx);
      case "add_mcp_server":
        return await addMcpServer(ctx, args);
      case "update_mcp_server":
        return await updateMcpServer(ctx, args);
      case "delete_mcp_server":
        return await deleteMcpServer(ctx, args);
      default:
        return fail("failed", `unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof HttpError) return fail(error.code, error.message);
    return fail("failed", "tool failed");
  }
}

function sendMessage(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const body = requireString(args.body, "body");
  if (isNoWorkCloser(body)) {
    return { ok: true, data: { skipped: true, reason: "no_new_work" }, emitted: [] };
  }
  const sessionId = optionalString(args.session_id) ?? ctx.sessionId;
  const parentId = optionalString(args.parent_id);
  if (!ctx.store.isPresent(sessionId, ctx.botId)) {
    return fail("not_a_member", "you are not in that session");
  }
  const session = ctx.store.getSession(sessionId);
  const roster = ctx.store.listBots();
  const selfName = roster.find((b) => b.id === ctx.botId)?.name;
  const presentNames = presentMemberNames(ctx.store, sessionId, roster);
  const parsed = parseMentions(body, roster.map((b) => b.name), { lenient: presentNames });
  const emitted: ToolResult["emitted"] = [];
  if (ctx.admission?.draining && (sessionId !== ctx.sessionId || parsed.everyone || parsed.mentions.some(name => name !== selfName))) {
    return fail("draining", "new handoffs and child turns are paused; finish this turn without delegation");
  }
  if (session.kind === "group") {
    for (const name of parsed.mentions) {
      const bot = ctx.store.findBotByName(name);
      if (!bot) continue;
      if (!ctx.store.isPresent(sessionId, bot.id)) {
        const next = ctx.store.addMember(sessionId, bot.id);
        emitted.push({ kind: "session", session: next });
      }
    }
  }
  const unresolved = parsed.unresolved.filter((token) => token !== "everyone");
  if (session.kind === "group" && unresolved.length > 0) {
    const fresh = unresolved.filter((token) => !ctx.mentionWarned?.has(token));
    if (fresh.length > 0) {
      for (const token of fresh) ctx.mentionWarned?.add(token);
      const members = presentNames.filter((name) => name !== selfName);
      return fail("unknown_mention", unknownMentionError(fresh, members));
    }
  }
  const cited = mergeCitedPaths(
    [...(ctx.writtenPaths ?? []), ...(optionalStringArray(args.paths, "paths") ?? [])],
    extractWorkspacePathsFromBody(body),
  );
  const resolved = resolveCitedPaths(ctx.store, cited);
  const linked = linkifyWorkspacePaths(body, resolved.paths);
  const message = ctx.store.insertMessage({
    sessionId,
    turnId: ctx.turnId,
    parentId: parentId ?? null,
    kind: "bot",
    author: ctx.botId,
    body: linked,
    sourceTurnId: ctx.turnId,
    paths: resolved.paths,
  });
  const stored = parseMentions(message.body, roster.map((b) => b.name), { lenient: presentNames });
  emitted.push({ kind: "message", message });
  emitted.push({ kind: "participation", message });
  return {
    ok: true,
    data: {
      message_id: message.id,
      session_id: sessionId,
      mentions: stored.mentions,
      corrected_mentions: stored.corrected,
      unresolved_mentions: stored.unresolved.filter((token) => token !== "everyone"),
      paths: resolved.paths,
      unresolved_paths: resolved.unresolved,
    },
    emitted,
  };
}

async function createBot(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const pin = await pinFromArgs(ctx, args, { currentModel: null, currentProviderId: null }, true);
  const created = ctx.store.createBot(
    {
      name: requireString(args.name, "name"),
      duties: requireString(args.duties, "duties"),
      boundaries: requireString(args.boundaries, "boundaries"),
      avatar: optionalString(args.avatar),
      model: pin.model,
      provider_id: pin.providerId,
      thinking_level:
        "thinking_level" in args ? nullableThinkingLevel(args.thinking_level) : undefined,
    },
    ctx.botId,
  );
  return {
    ok: true,
    data: {
      bot_id: created.bot.id,
      name: created.bot.name,
      direct_session_id: created.direct_session.id,
      avatar: created.bot.avatar,
      endpoint_id: created.bot.provider_id,
      model: created.bot.model,
      thinking_level: created.bot.thinking_level,
    },
    emitted: [
      { kind: "bot", bot: created.bot, deleted_at: null },
      { kind: "session", session: created.direct_session },
    ],
  };
}

function listBots(ctx: ToolCtx): ToolResult {
  return {
    ok: true,
    data: {
      bots: ctx.store.listBots().map((b) => ({
        id: b.id,
        name: b.name,
        duties: b.duties,
        boundaries: b.boundaries,
        avatar: b.avatar,
        endpoint_id: b.provider_id,
        model: b.model,
        thinking_level: b.thinking_level,
        archived: Boolean(b.archived_at),
      })),
    },
    emitted: [],
  };
}

async function updateProfile(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const name = optionalString(args.name);
  const duties = optionalString(args.duties);
  const boundaries = optionalString(args.boundaries);
  const avatarStyle = optionalString(args.avatar_style);
  const avatarPath = optionalString(args.avatar_path);
  const avatarSeed = optionalNumber(args.avatar_seed);
  const pinTouched = "endpoint_id" in args || "model" in args;
  const thinkingTouched = "thinking_level" in args;
  if (
    name === undefined &&
    duties === undefined &&
    boundaries === undefined &&
    avatarStyle === undefined &&
    avatarPath === undefined &&
    !pinTouched &&
    !thinkingTouched
  ) {
    return fail(
      "invalid_args",
      "name, duties, boundaries, avatar_style, avatar_path, endpoint_id, model, or thinking_level is required",
    );
  }
  if (avatarStyle !== undefined && avatarPath !== undefined) {
    return fail("invalid_args", "provide avatar_style or avatar_path, not both");
  }
  if (avatarSeed !== undefined && avatarStyle === undefined) {
    return fail("invalid_args", "avatar_seed requires avatar_style");
  }

  const current = ctx.store.getBot(ctx.botId);
  const nextName = name !== undefined ? name.trim() : current.name;
  if (name !== undefined && nextName.length === 0) {
    return fail("invalid_args", "name is required");
  }

  const patch: {
    name?: string;
    duties?: string;
    boundaries?: string;
    avatar?: string;
    model?: string | null;
    provider_id?: string | null;
    thinking_level?: ThinkingLevel | null;
  } = {};
  if (name !== undefined) patch.name = nextName;
  if (duties !== undefined) patch.duties = duties;
  if (boundaries !== undefined) patch.boundaries = boundaries;
  if (pinTouched) {
    const pin = await pinFromArgs(
      ctx,
      args,
      { currentModel: current.model, currentProviderId: current.provider_id },
      false,
    );
    patch.model = pin.model;
    patch.provider_id = pin.providerId;
  }
  if (thinkingTouched) patch.thinking_level = nullableThinkingLevel(args.thinking_level);

  if (avatarStyle !== undefined) {
    const variant = parseAvatarStyle(avatarStyle);
    if (!variant) {
      return fail(
        "invalid_args",
        `avatar_style must be one of ${BORING_AVATAR_VARIANTS.join(", ")}`,
      );
    }
    const seed = avatarSeed ?? 0;
    patch.avatar = generateBoringAvatar({
      name: seed > 0 ? `${nextName}_${seed}` : nextName,
      variant,
    });
  } else if (avatarPath !== undefined) {
    if (avatarPath.trim().length === 0) return fail("invalid_args", "avatar_path is required");
    const resolved = await resolveAvatarPath(ctx, avatarPath.trim(), args);
    if (!resolved.ok) return resolved.result;
    patch.avatar = resolved.dataUri;
  }

  const bot = ctx.store.patchBot(ctx.botId, patch, ctx.botId);
  return {
    ok: true,
    data: {
      name: bot.name,
      duties: bot.duties,
      boundaries: bot.boundaries,
      avatar: bot.avatar,
      endpoint_id: bot.provider_id,
      model: bot.model,
      thinking_level: bot.thinking_level,
    },
    emitted: [{ kind: "bot", bot, deleted_at: null }],
  };
}

function parseAvatarStyle(value: string): BoringAvatarVariant | null {
  return (BORING_AVATAR_VARIANTS as readonly string[]).includes(value)
    ? (value as BoringAvatarVariant)
    : null;
}

async function resolveAvatarPath(
  ctx: ToolCtx,
  input: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; dataUri: string } | { ok: false; result: ToolResult }> {
  const root = ctx.store.workspacePath();
  if (!root) return { ok: false, result: fail("failed", "workspace is not set") };
  const classified = classifyPath(root, input);
  if (!avatarMimeFromPath(classified.abs)) {
    return {
      ok: false,
      result: fail("not_text", "avatar_path must be a PNG, JPEG, GIF, or WebP image"),
    };
  }
  if (classified.zone === "outside") {
    if (!ctx.approved && !ctx.store.matchesAllowRule("outside-read", classified.abs)) {
      return {
        ok: false,
        result: {
          ok: false,
          waitApproval: {
            kind_key: "outside-read",
            target: classified.abs,
            summary: `outside-read ${classified.abs}`,
            run: () => runCollabTool({ ...ctx, approved: true }, "update_profile", args),
          },
          emitted: [],
        },
      };
    }
  }
  const encoded = rasterFileToAvatarDataUri(classified.abs);
  if (!encoded.ok) return { ok: false, result: fail(encoded.code, encoded.message) };
  return { ok: true, dataUri: encoded.dataUri };
}

/** Bot↔Bot directs pile up one per trigger, so this stops at the ones a Bot touched last. */
const LISTED_SESSIONS = 30;

function listSessions(ctx: ToolCtx): ToolResult {
  const items = ctx.store
    .listSessions()
    .filter((s) => s.participants.some((p) => p.member === ctx.botId && p.left_at === null))
    .slice(0, LISTED_SESSIONS)
    .map((s) => serializeSession(ctx.store, s));
  return { ok: true, data: { sessions: items }, emitted: [] };
}

function createGroup(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const name = requireString(args.name, "name");
  if (!Array.isArray(args.members)) return fail("invalid_args", "members is required");
  const names = args.members.map((n) => {
    if (typeof n !== "string") throw new HttpError(422, "invalid_args", "members must be names");
    return n;
  });
  const ids = new Set<string>([ctx.botId]);
  for (const n of names) {
    const bot = ctx.store.findBotByName(n);
    if (!bot) return fail("invalid_args", "members must exist on the roster");
    ids.add(bot.id);
  }
  if (ids.size < 2) return fail("invalid_args", "a group needs at least two bots");
  const session = ctx.store.createGroup({ name, members: [...ids] });
  return {
    ok: true,
    data: {
      session_id: session.id,
      name: session.name,
      members: memberNames(ctx.store, session),
    },
    emitted: [{ kind: "session", session }],
  };
}

/**
 * The message that woke this turn: where the entry point to a new Bot↔Bot direct hangs, and the
 * receipt a memory carries. Both halves come off the turn so they cannot disagree. A turn that is
 * not on record — a test harness, or one deleted mid-flight — leaves the row without a source.
 */
function turnOrigin(ctx: ToolCtx): { sessionId: string; messageId: string } | null {
  try {
    const turn = ctx.store.getTurn(ctx.turnId);
    return { sessionId: turn.session_id, messageId: turn.trigger_message_id };
  } catch {
    return null;
  }
}

function createDirect(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const other = ctx.store.requireBotByName(requireString(args.name, "name"));
  const session = ctx.store.createBotDirect(ctx.botId, other.id, turnOrigin(ctx));
  return {
    ok: true,
    data: {
      session_id: session.id,
      members: memberNames(ctx.store, session),
    },
    emitted: [{ kind: "session", session }],
  };
}

function addMember(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const sessionId = requireString(args.session_id, "session_id");
  if (!ctx.store.isPresent(sessionId, ctx.botId)) {
    return fail("not_a_member", "you are not in that session");
  }
  const bot = ctx.store.requireBotByName(requireString(args.name, "name"));
  const session = ctx.store.addMember(sessionId, bot.id);
  return {
    ok: true,
    data: { session_id: session.id, members: memberNames(ctx.store, session) },
    emitted: [{ kind: "session", session }],
  };
}

function removeMember(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const sessionId = requireString(args.session_id, "session_id");
  if (!ctx.store.isPresent(sessionId, ctx.botId)) {
    return fail("not_a_member", "you are not in that session");
  }
  const bot = ctx.store.requireBotByName(requireString(args.name, "name"));
  try {
    const session = ctx.store.removeMember(sessionId, bot.id);
    return {
      ok: true,
      data: { session_id: session.id, members: memberNames(ctx.store, session) },
      emitted: [{ kind: "session", session }],
    };
  } catch (error) {
    if (error instanceof HttpError && error.message === "a group needs at least two bots") {
      return fail("failed", error.message);
    }
    throw error;
  }
}

function askUser(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const question = requireString(args.question, "question");
  // A Bot↔Bot direct is the user's to read, not to answer in. Parking a turn on a question
  // nobody can reach would hang it for good, so send the Bot back to where the user is.
  if (!ctx.store.isPresent(ctx.sessionId, USER_MEMBER)) {
    return fail("not_a_member", "the user is not in this session; ask where they are");
  }
  return { ok: true, data: {}, waitAsk: { question }, emitted: [] };
}

function listRoutines(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const bot = resolveNamedBot(ctx, optionalString(args.name));
  if (!bot.ok) return bot.error;
  return {
    ok: true,
    data: {
      routines: ctx.store.listRoutines().filter((r) => r.bot_id === bot.id).map(serializeRoutine),
    },
    emitted: [],
  };
}

function createRoutine(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const bot = resolveNamedBot(ctx, optionalString(args.name));
  if (!bot.ok) return bot.error;
  const title = requireString(args.title, "title");
  const instruction = requireString(args.instruction, "instruction");
  const schedule = args.schedule as Routine["schedule"] | undefined;
  const enabled = args.enabled === undefined ? undefined : Boolean(args.enabled);
  const routine = ctx.store.createRoutine({
    bot_id: bot.id,
    title,
    instruction,
    schedule: schedule as Routine["schedule"],
    enabled,
  });
  return { ok: true, data: serializeRoutine(routine), emitted: [{ kind: "routine", routine }] };
}

function updateRoutine(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const id = requireString(args.id, "id");
  const current = ctx.store.getRoutine(id);
  const patch: Partial<{ title: string; instruction: string; schedule: Routine["schedule"]; enabled: boolean }> = {};
  if (args.title !== undefined) patch.title = requireString(args.title, "title");
  if (args.instruction !== undefined) patch.instruction = requireString(args.instruction, "instruction");
  if (args.schedule !== undefined) patch.schedule = args.schedule as Routine["schedule"];
  if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
  const routine = ctx.store.patchRoutine(current.id, patch);
  return { ok: true, data: serializeRoutine(routine), emitted: [{ kind: "routine", routine }] };
}

function deleteRoutine(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const id = requireString(args.id, "id");
  ctx.store.getRoutine(id);
  ctx.store.deleteRoutine(id);
  return { ok: true, data: { id }, emitted: [{ kind: "routine_removed", id }] };
}

function listSkills(ctx: ToolCtx): ToolResult {
  return {
    ok: true,
    data: {
      skills: ctx.store.listSkills(ctx.botId).map(serializeSkillSummary),
    },
    emitted: [],
  };
}

function readSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const skill = resolveOwnSkill(ctx, args, { requireEnabled: true });
  if (!skill.ok) return skill.error;
  const data = serializeSkill(skill.skill);
  const stale = staleMcpToolNames(skill.skill.body, ctx.availableToolNames);
  if (stale.length > 0) {
    data.stale_tool_names = stale;
    data.hint =
      "这些 mcp_ 工具名不在本轮 tools 数组里（服务器可能改名、停用，或撞名后缀变了）。按「本轮 MCP」段里的服务器名和工具说明找到现名再调用，并用 update_skill 把正文里的名字改过来。" +
      " / These mcp_ names are not in this hop's tools array (server renamed, disabled, or a collision suffix changed). Find the current name in the MCP block before calling, and fix the body with update_skill.";
  }
  return { ok: true, data, emitted: [] };
}

/**
 * `mcp_<server>_<tool>` names cited in a skill body that are not in this hop's tools array.
 * Tool names drift when a server is renamed or a collision suffix (`_2`) changes; a body that
 * hardcodes the old name would otherwise fail only at call time.
 */
export function staleMcpToolNames(body: string, available: ReadonlySet<string> | undefined): string[] {
  if (!available) return [];
  const cited = new Set(body.match(/\bmcp_[A-Za-z0-9_]+/g) ?? []);
  return [...cited].filter((name) => !available.has(name)).sort();
}

function createSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const name = requireString(args.name, "name");
  const description = requireString(args.description, "description");
  const body = requireString(args.body, "body");
  const enabled = args.enabled === undefined ? undefined : Boolean(args.enabled);
  const skill = ctx.store.createSkill({
    bot_id: ctx.botId,
    name,
    description,
    body,
    enabled,
    uses: parseUsesArg(args.uses),
  });
  return { ok: true, data: serializeSkill(skill), emitted: [{ kind: "skill", skill }] };
}

/** `uses` is a list of MCP server names; the store trims, dedupes, and bounds it. */
function parseUsesArg(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(422, "invalid_args", "uses must be an array of MCP server names");
  }
  return value as string[];
}

function updateSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const current = resolveOwnSkill(ctx, args, { requireEnabled: false });
  if (!current.ok) return current.error;
  const patch: Partial<{ name: string; description: string; body: string; enabled: boolean; uses: string[] }> = {};
  if (args.name !== undefined) patch.name = requireString(args.name, "name");
  if (args.description !== undefined) patch.description = requireString(args.description, "description");
  if (args.body !== undefined) patch.body = requireString(args.body, "body");
  if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
  if (args.uses !== undefined) patch.uses = parseUsesArg(args.uses);
  if (
    patch.name === undefined &&
    patch.description === undefined &&
    patch.body === undefined &&
    patch.enabled === undefined &&
    patch.uses === undefined
  ) {
    return fail("invalid_args", "name, description, body, enabled, or uses is required");
  }
  const skill = ctx.store.patchSkill(current.skill.id, patch);
  return { ok: true, data: serializeSkill(skill), emitted: [{ kind: "skill", skill }] };
}

function deleteSkill(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const current = resolveOwnSkill(ctx, args, { requireEnabled: false });
  if (!current.ok) return current.error;
  ctx.store.deleteSkill(current.skill.id);
  return { ok: true, data: { id: current.skill.id }, emitted: [{ kind: "skill_removed", id: current.skill.id }] };
}

/**
 * The Bot never passes bot_id or the source ids: they come off the turn, so a Bot can neither
 * write into another Bot's memory nor forge where a memory came from.
 */
function remember(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const origin = turnOrigin(ctx);
  const memory = ctx.store.rememberMemory({
    bot_id: ctx.botId,
    subject: requireString(args.subject, "subject"),
    body: requireString(args.body, "body"),
    source_session_id: origin?.sessionId ?? ctx.sessionId,
    source_message_id: origin?.messageId ?? null,
  });
  return { ok: true, data: serializeMemory(memory), emitted: [{ kind: "memory", memory }] };
}

function forget(ctx: ToolCtx, args: Record<string, unknown>): ToolResult {
  const current = resolveOwnMemory(ctx, args);
  if (!current.ok) return current.error;
  ctx.store.deleteMemory(current.memory.id);
  return {
    ok: true,
    data: { id: current.memory.id, subject: current.memory.subject },
    emitted: [{ kind: "memory_removed", id: current.memory.id }],
  };
}

function resolveOwnMemory(
  ctx: ToolCtx,
  args: Record<string, unknown>,
): { ok: true; memory: Memory } | { ok: false; error: ToolResult } {
  const id = optionalString(args.id);
  const subject = optionalString(args.subject);
  if (!id && !subject) return { ok: false, error: fail("invalid_args", "id or subject is required") };
  let memory: Memory | null = null;
  if (id) {
    try {
      memory = ctx.store.getMemory(id);
    } catch (error) {
      if (error instanceof HttpError && error.code === "not_found") {
        return { ok: false, error: fail("not_found", "memory not found") };
      }
      throw error;
    }
  } else if (subject) {
    memory = ctx.store.findMemoryBySubject(ctx.botId, subject);
  }
  if (!memory || memory.bot_id !== ctx.botId) {
    return { ok: false, error: fail("not_found", "memory not found") };
  }
  return { ok: true, memory };
}

function serializeMemory(memory: Memory): Record<string, unknown> {
  return { id: memory.id, subject: memory.subject, body: memory.body };
}

function resolveOwnSkill(
  ctx: ToolCtx,
  args: Record<string, unknown>,
  opts: { requireEnabled: boolean },
): { ok: true; skill: Skill } | { ok: false; error: ToolResult } {
  const id = optionalString(args.id);
  const name = optionalString(args.name);
  if (!id && !name) return { ok: false, error: fail("invalid_args", "id or name is required") };
  let skill: Skill | null = null;
  if (id) {
    try {
      skill = ctx.store.getSkill(id);
    } catch (error) {
      if (error instanceof HttpError && error.code === "not_found") {
        return { ok: false, error: fail("not_found", "skill not found") };
      }
      throw error;
    }
  } else if (name) {
    skill = ctx.store.findSkillByName(ctx.botId, name);
  }
  if (!skill || skill.bot_id !== ctx.botId) {
    return { ok: false, error: fail("not_found", "skill not found") };
  }
  if (opts.requireEnabled && !skill.enabled) {
    return { ok: false, error: fail("not_found", "skill not found") };
  }
  return { ok: true, skill };
}

function serializeSkillSummary(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    uses: skill.uses,
    enabled: skill.enabled,
  };
}

function serializeSkill(skill: Skill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    uses: skill.uses,
    enabled: skill.enabled,
  };
}

async function listEndpoints(ctx: ToolCtx): Promise<ToolResult> {
  const providers = await ctx.store.listProviders();
  const defaultId = ctx.store.defaultProviderId();
  return {
    ok: true,
    data: {
      endpoints: providers.map((provider) => serializeEndpoint(provider, defaultId)),
    },
    emitted: [],
  };
}

async function addEndpoint(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const name = requireString(args.name, "name");
  const baseUrl = requireString(args.base_url, "base_url");
  const models = args.models === undefined ? undefined : args.models;
  const defaultModel = optionalString(args.default_model);
  if (!ctx.approved) {
    const catalog = models === undefined ? [] : normalizeModelCatalog(models);
    return {
      ok: false,
      waitApproval: {
        kind_key: "endpoint-add",
        target: baseUrl,
        summary: endpointAddSummary(name, baseUrl, catalog.map((row) => row.name)),
        requiresApiKey: true,
        run: (opts) =>
          runCollabTool({ ...ctx, approved: true, approvalApiKey: opts?.api_key }, "add_endpoint", args),
      },
      emitted: [],
    };
  }
  const apiKey = ctx.approvalApiKey?.trim() ?? "";
  if (!apiKey) {
    throw new HttpError(422, "invalid_args", "api_key is required");
  }
  const previousBots = snapshotBotPins(ctx.store);
  const provider = await ctx.store.createProvider({
    name,
    base_url: baseUrl,
    api_key: apiKey,
    models: models === undefined ? undefined : (models as Provider["model_catalog"]),
    default_model: defaultModel,
  });
  return {
    ok: true,
    data: serializeEndpoint(provider, ctx.store.defaultProviderId()),
    emitted: [{ kind: "provider", provider }, { kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

async function updateEndpoint(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  const current = await ctx.store.getProvider(id);
  const defaultId = ctx.store.defaultProviderId();
  const isDefault = defaultId === id;
  const nextName = args.name !== undefined ? requireString(args.name, "name") : undefined;
  const nextUrl = args.base_url !== undefined ? requireString(args.base_url, "base_url") : undefined;
  const urlChanging = nextUrl !== undefined && nextUrl !== (current.base_url ?? "");
  if (urlChanging && isDefault) {
    return fail("failed", DEFAULT_ENDPOINT_GUARD);
  }
  if (urlChanging && !ctx.approved) {
    const catalog =
      args.models !== undefined ? normalizeModelCatalog(args.models) : current.model_catalog;
    return {
      ok: false,
      waitApproval: {
        kind_key: "endpoint-edit",
        target: nextUrl!,
        summary: endpointEditSummary(nextName ?? current.name, nextUrl!, catalog.map((row) => row.name)),
        requiresApiKey: !current.key_set,
        run: (opts) =>
          runCollabTool({ ...ctx, approved: true, approvalApiKey: opts?.api_key }, "update_endpoint", args),
      },
      emitted: [],
    };
  }
  if (urlChanging) {
    const apiKey = ctx.approvalApiKey?.trim() ?? "";
    if (!current.key_set && !apiKey) {
      throw new HttpError(422, "invalid_args", "api_key is required");
    }
  }
  const patch: {
    name?: string;
    base_url?: string;
    api_key?: string;
    models?: Provider["model_catalog"];
    default_model?: string | null;
  } = {};
  if (nextName !== undefined) patch.name = nextName;
  if (urlChanging) patch.base_url = nextUrl;
  if (args.models !== undefined) patch.models = args.models as Provider["model_catalog"];
  if (args.default_model !== undefined) {
    patch.default_model = optionalString(args.default_model) ?? null;
  }
  if (urlChanging && ctx.approvalApiKey && ctx.approvalApiKey.trim().length > 0) {
    patch.api_key = ctx.approvalApiKey.trim();
  }
  const previousBots = snapshotBotPins(ctx.store);
  const provider = await ctx.store.patchProvider(id, patch);
  return {
    ok: true,
    data: serializeEndpoint(provider, ctx.store.defaultProviderId()),
    emitted: [{ kind: "provider", provider }, { kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

async function deleteEndpoint(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  await ctx.store.getProvider(id);
  if (ctx.store.defaultProviderId() === id) {
    return fail("failed", DEFAULT_ENDPOINT_GUARD);
  }
  const previousBots = snapshotBotPins(ctx.store);
  await ctx.store.deleteProvider(id);
  return {
    ok: true,
    data: { id },
    emitted: [{ kind: "provider_removed", id }, { kind: "settings" }, ...botPinEmits(ctx.store, previousBots)],
  };
}

async function listMcpServers(ctx: ToolCtx): Promise<ToolResult> {
  const servers = await ctx.store.listMcpServersHydrated();
  return {
    ok: true,
    data: {
      servers: servers.map(serializeMcp),
    },
    emitted: [],
  };
}

async function addMcpServer(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const name = requireString(args.name, "name");
  const parsed = parseMcpToolSpec(args);
  const enabled = args.enabled === undefined ? true : Boolean(args.enabled);
  if (!ctx.approved) {
    return {
      ok: false,
      waitApproval: {
        kind_key: "mcp-add",
        target: mcpTarget(parsed.spec),
        summary: mcpAddSummary(name, parsed.spec),
        requiresApiKey: parsed.spec.transport === "http",
        run: (opts) =>
          runCollabTool(
            { ...ctx, approved: true, approvalApiKey: opts?.api_key },
            "add_mcp_server",
            args,
          ),
      },
      emitted: [],
    };
  }
  const auth =
    parsed.spec.transport === "http" ? (ctx.approvalApiKey?.trim() || undefined) : undefined;
  if (parsed.spec.transport === "http" && !auth) {
    throw new HttpError(422, "invalid_args", "api_key is required");
  }
  const server = await ctx.store.createMcpServer({
    name,
    transport: parsed.spec.transport,
    command: parsed.spec.command,
    args: parsed.spec.args,
    url: parsed.spec.url,
    headers: parsed.spec.headers,
    auth,
    enabled,
    usage_note: parseUsageNoteArg(args.usage_note),
  });
  return { ok: true, data: serializeMcp(server), emitted: [{ kind: "mcp", server }] };
}

/** `undefined` leaves the note alone; `null` or an empty string clears it. */
function parseUsageNoteArg(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(422, "invalid_args", "usage_note must be a string");
  }
  return value;
}

async function updateMcpServer(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  const current = ctx.store.listMcpServers().find((row) => row.id === id);
  if (!current) throw new HttpError(404, "not_found", "mcp server not found");
  const nextName = args.name !== undefined ? requireString(args.name, "name") : undefined;
  const nextTransport =
    args.transport !== undefined ? parseTransportArg(args.transport) : undefined;
  const nextCommand = args.command !== undefined ? requireString(args.command, "command") : undefined;
  const nextArgs = args.args !== undefined ? optionalStringArray(args.args) : undefined;
  const nextUrl = args.url !== undefined ? requireString(args.url, "url") : undefined;
  const nextHeadersParsed = args.headers !== undefined ? parseHeaderArg(args.headers) : undefined;
  const nextHeaders = nextHeadersParsed?.headers;
  const connectionChanging = mcpConnectionChanging(current, {
    transport: nextTransport,
    command: nextCommand,
    args: nextArgs,
    url: nextUrl,
    headers: nextHeaders,
  });
  if (connectionChanging && !ctx.approved) {
    const nextSpec: McpToolSpec = {
      transport: nextTransport ?? current.transport,
      command: nextCommand ?? current.command,
      args: nextArgs ?? current.args,
      url: nextUrl ?? current.url,
      headers: nextHeaders ?? current.headers,
    };
    return {
      ok: false,
      waitApproval: {
        kind_key: "mcp-edit",
        target: mcpTarget(nextSpec),
        summary: mcpEditSummary(nextName ?? current.name, nextSpec),
        requiresApiKey: nextSpec.transport === "http" && !current.auth_set,
        run: (opts) =>
          runCollabTool(
            {
              ...ctx,
              approved: true,
              approvalApiKey: opts?.api_key,
            },
            "update_mcp_server",
            args,
          ),
      },
      emitted: [],
    };
  }
  const auth = ctx.approvalApiKey?.trim() || undefined;
  if (
    ctx.approved &&
    connectionChanging &&
    (nextTransport ?? current.transport) === "http" &&
    !current.auth_set &&
    !auth
  ) {
    throw new HttpError(422, "invalid_args", "api_key is required");
  }
  const server = await ctx.store.patchMcpServer(id, {
    name: nextName,
    transport: nextTransport,
    command: nextCommand,
    args: nextArgs,
    url: nextUrl,
    headers: nextHeaders,
    auth,
    enabled: args.enabled === undefined ? undefined : Boolean(args.enabled),
    usage_note: parseUsageNoteArg(args.usage_note),
  });
  return { ok: true, data: serializeMcp(server), emitted: [{ kind: "mcp", server }] };
}

async function deleteMcpServer(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const id = requireString(args.id, "id");
  await ctx.store.deleteMcpServer(id);
  return { ok: true, data: { id }, emitted: [{ kind: "mcp_removed", id }] };
}

function resolveNamedBot(
  ctx: ToolCtx,
  name: string | undefined,
): { ok: true; id: string } | { ok: false; error: ToolResult } {
  if (!name) return { ok: true, id: ctx.botId };
  const bot = ctx.store.findBotByName(name);
  if (!bot) return { ok: false, error: fail("not_found", "bot not found") };
  return { ok: true, id: bot.id };
}

function serializeRoutine(routine: Routine): Record<string, unknown> {
  return {
    id: routine.id,
    bot_id: routine.bot_id,
    title: routine.title,
    instruction: routine.instruction,
    schedule: routine.schedule,
    enabled: routine.enabled,
    last_fired_for_due_at: routine.last_fired_for_due_at,
    created_at: routine.created_at,
    updated_at: routine.updated_at,
  };
}

function memberNames(store: Store, session: SessionDetail | SessionSummary): string[] {
  return session.participants
    .filter((p) => p.left_at === null)
    .map((p) => (p.member === USER_MEMBER ? "user" : store.getBot(p.member).name));
}

function serializeSession(store: Store, session: SessionSummary) {
  return {
    id: session.id,
    kind: session.kind,
    name: session.name,
    members: memberNames(store, session),
    updated_at: session.updated_at,
  };
}

async function pinFromArgs(
  ctx: ToolCtx,
  args: Record<string, unknown>,
  current: { currentModel: string | null; currentProviderId: string | null },
  creating: boolean,
): Promise<{ model: string | null; providerId: string | null }> {
  const hasEndpoint = "endpoint_id" in args;
  const hasModel = "model" in args;
  if (!hasEndpoint && !hasModel) {
    return creating
      ? { model: null, providerId: null }
      : { model: current.currentModel, providerId: current.currentProviderId };
  }
  const endpointRaw = hasEndpoint ? nullableId(args.endpoint_id, "endpoint_id") : undefined;
  const modelRaw = hasModel ? nullableId(args.model, "model") : undefined;
  if (hasEndpoint && hasModel && !endpointRaw && !modelRaw) {
    return { model: null, providerId: null };
  }
  if (hasEndpoint && !hasModel && !endpointRaw) {
    return { model: null, providerId: null };
  }

  let providerId = hasEndpoint ? endpointRaw : current.currentProviderId;
  let model = hasModel ? modelRaw : current.currentModel;

  if (!providerId && model) {
    providerId = ctx.store.defaultProviderId();
  }
  if (providerId) {
    const provider = await ctx.store.getProvider(providerId);
    if (model && !provider.models.includes(model)) {
      if (hasModel) {
        throw new HttpError(422, "invalid_args", "model must be one of the provider models");
      }
      model = null;
    }
  } else if (model) {
    throw new HttpError(422, "invalid_args", "model must be one of the provider models");
  }
  return { model: model ?? null, providerId: providerId ?? null };
}

function nullableThinkingLevel(value: unknown): ThinkingLevel | null {
  const raw = nullableId(value, "thinking_level");
  if (raw === null) return null;
  if (!isThinkingLevel(raw)) {
    throw new HttpError(422, "invalid_args", "thinking_level must be a reasoning_effort name");
  }
  return raw;
}

function nullableId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", `${field} must be a string`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function serializeEndpoint(provider: Provider, defaultId: string | null): Record<string, unknown> {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    key_set: provider.key_set,
    models: provider.models,
    model_catalog: provider.model_catalog,
    available_models: provider.available_models,
    default_model: provider.default_model,
    is_default: provider.id === defaultId,
  };
}

function serializeMcp(server: McpServer): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    auth_set: server.auth_set,
    enabled: server.enabled,
    instructions: server.instructions,
    usage_note: server.usage_note,
    tool_catalog: server.tool_catalog,
  };
}

type McpToolSpec = {
  transport: McpTransport;
  command: string;
  args: string[];
  url: string | null;
  headers: McpHeader[];
};

function parseMcpToolSpec(args: Record<string, unknown>): { spec: McpToolSpec; auth: string | undefined } {
  const url = optionalString(args.url);
  const command = optionalString(args.command);
  const parsedHeaders = args.headers === undefined ? { headers: [] as McpHeader[], auth: undefined } : parseHeaderArg(args.headers);
  const transport =
    args.transport !== undefined
      ? parseTransportArg(args.transport)
      : url && !command
        ? "http"
        : "stdio";
  if (transport === "http") {
    if (!url) throw new HttpError(422, "invalid_args", "url is required");
    return {
      spec: {
        transport,
        command: "",
        args: [],
        url,
        headers: parsedHeaders.headers,
      },
      auth: parsedHeaders.auth,
    };
  }
  if (!command) throw new HttpError(422, "invalid_args", "command is required");
  return {
    spec: {
      transport,
      command,
      args: optionalStringArray(args.args) ?? [],
      url: null,
      headers: [],
    },
    auth: undefined,
  };
}

function parseTransportArg(value: unknown): McpTransport {
  if (value !== "stdio" && value !== "http") {
    throw new HttpError(422, "invalid_args", "transport must be stdio or http");
  }
  return value;
}

function parseHeaderArg(value: unknown): { headers: McpHeader[]; auth?: string } {
  if (value === undefined || value === null) return { headers: [] };
  if (typeof value === "string") return parseHeaderLines(value);
  if (!Array.isArray(value)) {
    throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
  }
  const headers: McpHeader[] = [];
  let auth: string | undefined;
  for (const item of value) {
    if (typeof item === "string") {
      const parsed = parseHeaderLines(item);
      headers.push(...parsed.headers);
      if (parsed.auth) auth = parsed.auth;
      continue;
    }
    if (!item || typeof item !== "object") {
      throw new HttpError(422, "invalid_args", "headers must be an array of { name, value }");
    }
    const name = (item as { name?: unknown }).name;
    const headerValue = (item as { value?: unknown }).value;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new HttpError(422, "invalid_args", "header name is required");
    }
    if (typeof headerValue !== "string") {
      throw new HttpError(422, "invalid_args", "header value must be a string");
    }
    if (name.trim().toLowerCase() === "authorization") {
      auth = headerValue;
      continue;
    }
    headers.push({ name: name.trim(), value: headerValue });
  }
  return { headers, auth };
}

function parseHeaderLines(raw: string): { headers: McpHeader[]; auth?: string } {
  const headers: McpHeader[] = [];
  let auth: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) throw new HttpError(422, "invalid_args", "headers must look like Name: value");
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (name.toLowerCase() === "authorization") {
      auth = value;
      continue;
    }
    headers.push({ name, value });
  }
  return { headers, auth };
}

function mcpConnectionChanging(
  current: McpServer,
  next: {
    transport?: McpTransport;
    command?: string;
    args?: string[];
    url?: string;
    headers?: McpHeader[];
  },
): boolean {
  if (next.transport !== undefined && next.transport !== current.transport) return true;
  if (next.command !== undefined && next.command !== current.command) return true;
  if (next.args !== undefined && JSON.stringify(next.args) !== JSON.stringify(current.args)) return true;
  if (next.url !== undefined && next.url !== (current.url ?? "")) return true;
  if (next.headers !== undefined && JSON.stringify(next.headers) !== JSON.stringify(current.headers)) {
    return true;
  }
  return false;
}

function mcpTarget(spec: McpToolSpec): string {
  if (spec.transport === "http") return spec.url ?? "";
  return `${spec.command} ${spec.args.join(" ")}`.trim();
}

function endpointAddSummary(name: string, url: string, models: string[]): string {
  const list = models.length > 0 ? models.join(", ") : "(none)";
  return `endpoint-add ${name}\n${url}\nmodels: ${list}`;
}

function endpointEditSummary(name: string, url: string, models: string[]): string {
  const list = models.length > 0 ? models.join(", ") : "(none)";
  return `endpoint-edit ${name}\n${url}\nmodels: ${list}`;
}

function mcpAddSummary(name: string, spec: McpToolSpec): string {
  return `mcp-add ${name}\n${mcpSummaryLine(spec)}`;
}

function mcpEditSummary(name: string, spec: McpToolSpec): string {
  return `mcp-edit ${name}\n${mcpSummaryLine(spec)}`;
}

function mcpSummaryLine(spec: McpToolSpec): string {
  if (spec.transport === "http") {
    const extra = spec.headers.length > 0 ? `\nheaders: ${spec.headers.map((h) => h.name).join(", ")}` : "";
    return `${spec.url}${extra}`;
  }
  return `${spec.command} ${spec.args.join(" ")}`.trimEnd();
}

function snapshotBotPins(store: Store): Array<{ id: string; model: string | null; provider_id: string | null }> {
  return store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
}

function botPinEmits(
  store: Store,
  previous: Array<{ id: string; model: string | null; provider_id: string | null }>,
): ToolResult["emitted"] {
  const out: ToolResult["emitted"] = [];
  for (const bot of store.listBots()) {
    const before = previous.find((row) => row.id === bot.id);
    if (before?.model === bot.model && before.provider_id === bot.provider_id) continue;
    out.push({ kind: "bot", bot, deleted_at: null });
  }
  return out;
}

function resolveCitedPaths(store: Store, inputs: string[]): { paths: string[]; unresolved: string[] } {
  const root = store.workspacePath();
  if (!root) return { paths: [], unresolved: [...inputs] };
  const paths: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const classified = classifyPath(root, input);
    if (classified.zone !== "inside") {
      unresolved.push(input);
      continue;
    }
    const rel = classified.rel;
    if (seen.has(rel)) continue;
    seen.add(rel);
    paths.push(rel);
  }
  return { paths, unresolved };
}

function optionalStringArray(value: unknown, field = "args"): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new HttpError(422, "invalid_args", `${field} must be an array of strings`);
  return value.map((item) => {
    if (typeof item !== "string") throw new HttpError(422, "invalid_args", `${field} must be an array of strings`);
    return item;
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(422, "invalid_args", `${field} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(422, "invalid_args", "expected a string");
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HttpError(422, "invalid_args", "avatar_seed must be a non-negative integer");
  }
  return value;
}

function presentMemberNames(
  store: Store,
  sessionId: string,
  roster: ReturnType<Store["listBots"]>,
): string[] {
  const byId = new Map(roster.map((b) => [b.id, b.name] as const));
  return store
    .presentBotIds(sessionId)
    .map((id) => byId.get(id))
    .filter((name): name is string => typeof name === "string");
}

/** Tool error for `@token`s that match nobody present; lists the exact names to use. */
function unknownMentionError(tokens: string[], members: string[]): string {
  const label = tokens.length === 1 ? "unknown mention" : "unknown mentions";
  const list = tokens.map((token) => `@${token}`).join(", ");
  const who = members.length > 0 ? members.join(", ") : "(nobody else)";
  return `${label} ${list}: no member here has that name. Members here: ${who}. Use one of these exact names, or drop the @ and send again.`;
}

function fail(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message }, emitted: [] };
}
