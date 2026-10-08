/** Tools over the Bot roster: create, list, and a Bot's own profile and pins. */
import { BORING_AVATAR_VARIANTS, generateBoringAvatar, type ThinkingLevel } from "@real-bot/protocol";
import { avatarMimeFromPath, rasterFileToAvatarDataUri } from "../avatar-image";
import { runCollabTool, type ToolCtx, type ToolResult } from "../collab-tools";
import { HttpError } from "../errors";
import type { Store } from "../store";
import { normalizeOptionalId } from "../store/shared";
import { toolFail as fail } from "../tool-result";
import { classifyPath } from "../workspace-paths";
import { nullableThinkingLevel, optionalNumber, optionalString, parseAvatarStyle, requireString } from "./args";
import { assertActive } from "./guards";

export async function createBot(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const pin = await pinFromArgs(ctx, args, { currentModel: null, currentProviderId: null }, true);
  assertActive(ctx);
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

export function listBots(ctx: ToolCtx): ToolResult {
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

export async function updateProfile(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
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
    assertActive(ctx);
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
    assertActive(ctx);
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

export function resolveNamedBot(
  ctx: ToolCtx,
  name: string | undefined,
): { ok: true; id: string } | { ok: false; error: ToolResult } {
  if (!name) return { ok: true, id: ctx.botId };
  const bot = ctx.store.findBotByName(name);
  if (!bot) return { ok: false, error: fail("not_found", "bot not found") };
  return { ok: true, id: bot.id };
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
  const endpointRaw = hasEndpoint ? normalizeOptionalId(args.endpoint_id, "endpoint_id") : undefined;
  const modelRaw = hasModel ? normalizeOptionalId(args.model, "model") : undefined;
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
    assertActive(ctx);
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

export function snapshotBotPins(store: Store): Array<{ id: string; model: string | null; provider_id: string | null }> {
  return store.listBots().map((bot) => ({ id: bot.id, model: bot.model, provider_id: bot.provider_id }));
}

export function botPinEmits(
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
