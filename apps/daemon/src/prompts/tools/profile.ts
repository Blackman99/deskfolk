import type { ToolDef } from "../tool-schema";

export const UPDATE_PROFILE: ToolDef = {
  name: "update_profile",
  description: {
    zh: "改自己的名字、职责、边界、头像、钉的端点+模型和/或思考等级。至少提供一项。头像用 avatar_style 生成，或用工作区里一张 PNG / JPEG / GIF / WebP 的 avatar_path；不要两个一起给。endpoint_id 与 model 可只改一项；两项都空则清成空钉。thinking_level 钉补全的思考等级，JSON null 或空字符串清掉、改回由应用挑。改名须未删除名唯一。不能删或归档自己。不要为这次改人设再发一条聊天消息。",
    en: "Change your own name, duties, boundaries, avatar, pinned endpoint+model, and/or thinking level. Provide at least one field. Generate an avatar with avatar_style, or set one from a workspace PNG / JPEG / GIF / WebP via avatar_path; do not pass both. endpoint_id and model may be changed independently; empty values for both clear the pin. thinking_level pins the completion's thinking level; JSON null or an empty string clears it so the app picks again. A new name must be unique among undeleted Bots. You cannot delete or archive yourself. Do not send a chat message about this profile change.",
  },
  properties: {
    name: {
      type: "string",
      description: { zh: "新的名字。未删除名必须唯一。", en: "New name. Undeleted names must be unique." },
    },
    duties: { type: "string", description: { zh: "新的职责说明。", en: "New duties." } },
    boundaries: { type: "string", description: { zh: "新的边界。", en: "New boundaries." } },
    avatar_style: {
      type: "string",
      enum: ["beam", "marble", "pixel", "sunset", "bauhaus", "ring"],
      description: {
        zh: "生成头像的风格：beam、marble、pixel、sunset、bauhaus、ring。",
        en: "Generated avatar style: beam, marble, pixel, sunset, bauhaus, or ring.",
      },
    },
    avatar_seed: {
      type: "integer",
      description: {
        zh: "可选。配合 avatar_style 换一版同一风格。省略则按当前名字生成。",
        en: "Optional. With avatar_style, pick another drawing of the same style. Omit to generate from the current name.",
      },
    },
    avatar_path: {
      type: "string",
      description: {
        zh: "工作区相对 POSIX，或宿主绝对路径，指向一张 PNG / JPEG / GIF / WebP。区内直接执行；区外会停下来等用户批准。拒绝后工具结果是 denied。",
        en: "Workspace-relative POSIX, or a host absolute path, to a PNG / JPEG / GIF / WebP. Runs immediately inside the workspace; outside, it pauses for the user's approval. A denial comes back as denied.",
      },
    },
    endpoint_id: {
      type: "string",
      description: {
        zh: "钉到这个端点。JSON null 或空字符串表示清除。只给这一项则保留现有模型名，新名单没有则清成空钉。",
        en: "Pin to this endpoint. JSON null or an empty string clears it. If this is the only pin field, keep the current model name, or clear the pin if that name is not on the new list.",
      },
    },
    model: {
      type: "string",
      description: {
        zh: "钉到这个模型名。JSON null 或空字符串表示清除。只给这一项则落在当前钉的端点；没有钉则用默认端点。须在目标名单上。",
        en: "Pin to this model name. JSON null or an empty string clears it. If this is the only pin field, it lands on the currently pinned endpoint, or the default endpoint if none is pinned. Must be on the target list.",
      },
    },
    thinking_level: {
      type: "string",
      enum: ["none", "low", "medium", "high"],
      description: {
        zh: "钉的思考等级，即补全的 reasoning_effort。JSON null 或空字符串清掉、改回每条消息由应用挑。钉了模型时须是该模型支持的等级（见 list_endpoints 的 model_catalog.thinking_levels）；没钉模型时任一等级都行，所选模型支持就用。",
        en: "Pinned thinking level, the completion's reasoning_effort. JSON null or an empty string clears it so the app picks per message again. With a pinned model it must be one that model supports (see model_catalog.thinking_levels from list_endpoints); with no pinned model any level is accepted and applies whenever the chosen model supports it.",
      },
    },
  },
};

export const LIST_SKILLS: ToolDef = {
  name: "list_skills",
  description: {
    zh: "列出你自己的技能（含停用）。不含正文。",
    en: "List your own skills, including disabled ones. Does not include the body.",
  },
  properties: {},
};

export const READ_SKILL: ToolDef = {
  name: "read_skill",
  description: {
    zh: "读取你自己一条已启用技能的正文。停用或不属于你的当作找不到。",
    en: "Read the body of one of your enabled skills. Disabled skills and other Bots' skills are not found.",
  },
  properties: {
    id: { type: "string", description: { zh: "技能 id。", en: "Skill id." } },
    name: { type: "string", description: { zh: "技能名。id 与 name 至少给一个。", en: "Skill name. Provide id or name." } },
  },
};

export const CREATE_SKILL: ToolDef = {
  name: "create_skill",
  description: {
    zh: "给自己新建一条技能。可复用工序写成技能，不要塞进人设。不要为这次改技能再发一条聊天消息。",
    en: "Create a skill for yourself. Write reusable procedures as skills, not into the profile. Do not send a chat message about this skill change.",
  },
  properties: {
    name: { type: "string", description: { zh: "技能名。同一 Bot 内不区分大小写唯一。", en: "Skill name. Unique per Bot, case-insensitive." } },
    description: { type: "string", description: { zh: "何时用这条技能。", en: "When to use this skill." } },
    body: { type: "string", description: { zh: "怎么干的 Markdown 正文。", en: "Markdown body for how to do it." } },
    uses: {
      type: "array",
      items: { type: "string" },
      description: {
        zh: "正文依赖的 MCP 服务器名（可选；用 list_mcp_servers 里的 name）。技能目录里会标出本轮未连接的，正文照做不了时直说或提问。",
        en: "MCP server names the body relies on (optional; use the name from list_mcp_servers). The skill catalog marks the ones not connected this turn so you say so or ask instead of forcing the body.",
      },
    },
    enabled: { type: "boolean", description: { zh: "是否启用。默认 true。", en: "Whether it is enabled. Default true." } },
  },
  required: ["name", "description", "body"],
};

export const UPDATE_SKILL: ToolDef = {
  name: "update_skill",
  description: {
    zh: "修改自己的一条技能。不能改别人的。不要为这次改技能再发一条聊天消息。",
    en: "Change one of your skills. You cannot change another Bot's. Do not send a chat message about this skill change.",
  },
  properties: {
    id: { type: "string", description: { zh: "技能 id。", en: "Skill id." } },
    name: { type: "string", description: { zh: "新的技能名。", en: "New skill name." } },
    description: { type: "string", description: { zh: "新的何时用说明。", en: "New when-to-use description." } },
    body: { type: "string", description: { zh: "新的正文。", en: "New body." } },
    uses: {
      type: "array",
      items: { type: "string" },
      description: {
        zh: "新的依赖 MCP 服务器名列表，整表替换；传空数组清掉。",
        en: "New list of MCP server names the body relies on; replaces the whole list. Pass an empty array to clear.",
      },
    },
    enabled: { type: "boolean", description: { zh: "是否启用。", en: "Whether it is enabled." } },
  },
  required: ["id"],
};

export const DELETE_SKILL: ToolDef = {
  name: "delete_skill",
  description: {
    zh: "删除自己的一条技能。不能删别人的。不要为这次改技能再发一条聊天消息。",
    en: "Delete one of your skills. You cannot delete another Bot's. Do not send a chat message about this skill change.",
  },
  properties: {
    id: { type: "string", description: { zh: "技能 id。", en: "Skill id." } },
  },
  required: ["id"],
};
