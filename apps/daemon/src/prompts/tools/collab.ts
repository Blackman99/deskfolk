import type { ToolDef } from "../tool-schema";

export const SEND_MESSAGE: ToolDef = {
  name: "send_message",
  description: {
    zh: "在你已在场的会话里发言或交接。省略 session_id 即本轮所在会话。正文里的 @Name 会点名并让对方必须下场（群里已有活轮则听进那一轮）；只在对方有尚未看见的新工作要接手时点名。用户已经向全员说过的请求不要再 @ 一遍。对方已经在场并同意时不要再点名。要针对某一条主线消息说话时传 parent_id（只能一层）；引用 Bot 时正文会自动加上 @对方。群里点到名册已有但不在场的 Bot 会先拉入。名册没有的名字不新建 Bot。群里 @ 的名字必须与在场成员逐字一致，写错会返回 unknown_mention 且消息不会发出。本轮写入的工作区文件会自动变成可点链接，正文里直接写路径即可。不要把已经提出的请求再广播一遍。没有新工作、介绍已经发出、无其他事项、本轮结束这类收尾或状态汇报不要发：直接结束本轮。成功发送会结束本轮；先解决可恢复的障碍并验证结果，不要用它预告排查或把可自行处理的技术问题交给用户。",
    en: "Speak or hand off in a session you currently belong to. Omit session_id for this turn's session. @Name in the body mentions a teammate and forces them to take the floor (in a group, into their existing live turn if they have one); mention someone only when they have new work they have not already seen. Do not re-mention a request the user already made to the group. Do not mention someone who is already present and in agreement. To speak to a specific main-transcript line, pass parent_id (one level only); quoting a Bot prepends @them. In a group, a roster Bot who is not a member is pulled in first. Unknown names do not create a Bot. In a group, an @ that matches no member exactly fails with unknown_mention and nothing is sent. Workspace files written this turn become clickable links automatically; just write the path in the body. Do not rebroadcast a request already in the transcript. Do not post a closer or status note such as \"no new work\", \"introduction posted\", or \"nothing else\"; end the turn instead. A successful send_message ends this turn; resolve recoverable obstacles and verify results first, rather than announcing an investigation or handing technical work back to the user.",
  },
  properties: {
    body: { type: "string", description: { zh: "消息正文。", en: "Message text." } },
    paths: {
      type: "array",
      items: { type: "string" },
      description: {
        zh: "要挂在这条消息上的工作区相对路径。不复制文件。区外路径不会挂上，列入 unresolved_paths。省略则只扫正文里的 Markdown 链接和反引号路径。",
        en: "Workspace-relative paths to cite on this message. Files are not copied. Outside-workspace paths are not attached and appear in unresolved_paths. Omit to scan Markdown links and backtick paths in the body only.",
      },
    },
    session_id: {
      type: "string",
      description: {
        zh: "目标会话 id。必须是你当前在场的会话。省略则本轮所在会话。",
        en: "Target session id. Must be a session you currently belong to. Omit for this turn's session.",
      },
    },
    parent_id: {
      type: "string",
      description: {
        zh: "要引用回复的主线消息 id。省略则发在主转录。只能一层。引用 Bot 时正文会自动加上 @对方（已有 @ 或 @everyone 则不重复）；对方必须下场。只在需要针对那一条说话时用。",
        en: "Id of the main-transcript message to quote-reply to. Omit to post on the main transcript. Threads are one level only. Quoting a Bot prepends @them unless the body already mentions them or @everyone; that mention forces them to take the floor. Use only when speaking to that specific line.",
      },
    },
  },
  required: ["body"],
};

export const CREATE_BOT: ToolDef = {
  name: "create_bot",
  description: {
    zh: "在名册新建一个 Bot，并建立用户与它的私聊。不开群，不拉入当前会话。",
    en: "Create a Bot on the roster and a direct session between the user and that Bot. Does not create a group or add them to the current session.",
  },
  properties: {
    name: {
      type: "string",
      description: { zh: "Bot 的名字。未删除名必须唯一。", en: "Bot name. Undeleted names must be unique." },
    },
    duties: { type: "string", description: { zh: "职责说明。", en: "Duties." } },
    boundaries: { type: "string", description: { zh: "边界。", en: "Boundaries." } },
    endpoint_id: {
      type: "string",
      description: {
        zh: "钉到这个端点。省略则空钉，由应用挑选。须是 list_endpoints 返回的 id。",
        en: "Pin to this endpoint. Omit for an empty pin so the app chooses. Must be an id from list_endpoints.",
      },
    },
    model: {
      type: "string",
      description: {
        zh: "钉到这个模型名。须在该端点名单上。省略则空钉。",
        en: "Pin to this model name. Must be on that endpoint's list. Omit for an empty pin.",
      },
    },
    thinking_level: {
      type: "string",
      description: {
        zh: "钉的思考等级，即补全的 reasoning_effort（以该模型名单为准，可能含 xhigh / max）。省略则每条消息由应用挑。钉了模型时须是该模型支持的等级。",
        en: "Pinned thinking level, the completion's reasoning_effort (whatever the model lists, including xhigh / max). Omit to let the app pick per message. With a pinned model it must be one that model supports.",
      },
    },
  },
  required: ["name", "duties", "boundaries"],
};

export const LIST_BOTS: ToolDef = {
  name: "list_bots",
  description: {
    zh: "列出名册上未删除的 Bot，包括已归档的。",
    en: "List undeleted Bots on the roster, including archived ones.",
  },
  properties: {},
};

export const LIST_SESSIONS: ToolDef = {
  name: "list_sessions",
  description: {
    zh: "列出你当前在场的会话。",
    en: "List sessions you currently belong to.",
  },
  properties: {},
};

export const CREATE_GROUP: ToolDef = {
  name: "create_group",
  description: {
    zh: "新建一个群。你和用户都会在群里。members 里的名字必须已在名册且未删除；建完至少两个 Bot。",
    en: "Create a group. You and the user will be in it. Names in members must exist on the roster and not be deleted; the group must have at least two Bots when created.",
  },
  properties: {
    name: { type: "string", description: { zh: "群名。不必全局唯一。", en: "Group name. Need not be globally unique." } },
    members: {
      type: "array",
      items: { type: "string" },
      description: { zh: "要拉入的 Bot 名字数组。", en: "Array of Bot names to pull in." },
    },
  },
  required: ["name", "members"],
};

export const CREATE_DIRECT: ToolDef = {
  name: "create_direct",
  description: {
    zh: "与另一个 Bot 新开一条私聊，把一件事单独谈完。每次调用都新开一条：叫醒你这一轮的那条消息就是它的来源，入口挂在那条消息下面，不接在上次跟这个 Bot 的私聊后面。同一轮里对同一个 Bot 再调一次仍是这一条。对方看不到你这边的会话，开场消息必须自带背景和要办的事。用户不在这条私聊里，只能看不能发言：不要在里面问用户，要问就回到用户在场的会话。",
    en: "Open a new direct with another Bot to settle one thing there. Every call opens a new one: the message that woke this turn is its source, the entry point hangs under that message, and it does not continue the last direct you had with that Bot. Calling again for the same Bot in the same turn returns the same one. They cannot see the session you are in, so your opening message must carry the background and the request. The user is not in this direct and can only read it: never ask the user anything there; go back to a session they belong to.",
  },
  properties: {
    name: { type: "string", description: { zh: "对方 Bot 的名字。", en: "The other Bot's name." } },
  },
  required: ["name"],
};

export const ADD_MEMBER: ToolDef = {
  name: "add_member",
  description: {
    zh: "把名册上已有的 Bot 拉进你已在场的群。已在场则成功且不重复加入。",
    en: "Pull an existing roster Bot into a group you belong to. Already-a-member is success without duplicating.",
  },
  properties: {
    session_id: { type: "string", description: { zh: "群会话 id。你必须在场。", en: "Group session id. You must belong to it." } },
    name: { type: "string", description: { zh: "要拉入的 Bot 名字。", en: "Bot name to pull in." } },
  },
  required: ["session_id", "name"],
};

export const REMOVE_MEMBER: ToolDef = {
  name: "remove_member",
  description: {
    zh: "从你已在场的群移出一个 Bot。不能移出用户。不能把群降到只剩一个 Bot。",
    en: "Remove a Bot from a group you belong to. Cannot remove the user. Cannot leave the group with only one Bot.",
  },
  properties: {
    session_id: { type: "string", description: { zh: "群会话 id。你必须在场。", en: "Group session id. You must belong to it." } },
    name: { type: "string", description: { zh: "要移出的 Bot 名字。", en: "Bot name to remove." } },
  },
  required: ["session_id", "name"],
};

export const ASK_USER: ToolDef = {
  name: "ask_user",
  description: {
    zh: "向用户问一件需要判断的事。技术障碍先主动排查、尝试可用办法；只有缺少用户独有的信息或决策时才提问，不要让用户代做能用工具完成的工作。不是批准，不要索要聊天正文里的密钥。用户回复后本轮继续。只能在用户在场的会话里问：Bot↔Bot 私聊里用户只能看，问了没人能答。",
    en: "Ask the user something that needs their judgment. Investigate first and try available remedies for technical obstacles; ask only for information or decisions that require the user, not work you can do with tools. This is not an approval; never request secrets in chat text. The turn continues after they reply. Only ask in a session the user belongs to: a Bot↔Bot direct is read-only to them, so a question there reaches nobody.",
  },
  properties: {
    question: { type: "string", description: { zh: "问句。", en: "The question." } },
  },
  required: ["question"],
};

export const CHECK_BACK: ToolDef = {
  name: "check_back",
  description: {
    zh: "约自己稍后在本会话回看一次。到点后你会被一条「回看：<note>」的系统行叫醒，沿用这件事的工作目录；那一轮的局面里有这件事最初的要求、已交出的文件和经过。用在交接出去之后、或在等一个不由你掌控的结果时；note 写清回看时要核对什么、没动静该怎么办。一个会话里同时只有一次待回看，再约就是替换。这不是日程，只响一次。不要为了等而每几分钟约一次；要立刻让别人做事，用 send_message 点名。",
    en: "Book a check-back with yourself in this session. When it is due you are woken by a system line \"Check-back: <note>\", in the same job's work dir, and that turn's situation block carries the job's opening request, the files handed over and who did what. Use it after a handoff, or while waiting for a result you do not control; put in note what to verify and what to do if nothing has moved. One pending check-back per session; booking another replaces it. It is not a routine and fires once. Do not book one every few minutes just to wait; to get someone moving now, mention them with send_message.",
  },
  properties: {
    after_minutes: {
      type: "integer",
      description: {
        zh: "多少分钟后回看：1 到 10080（七天）的整数。",
        en: "Minutes until the check-back: an integer from 1 to 10080 (seven days).",
      },
    },
    note: {
      type: "string",
      description: {
        zh: "回看时给自己的一句话：核对什么、没动静怎么办。",
        en: "One line to your later self: what to verify, and what to do if nothing has moved.",
      },
    },
  },
  required: ["after_minutes", "note"],
};
