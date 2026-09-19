import { type ToolDef } from "../tool-schema";

export const REMEMBER: ToolDef = {
  name: "remember",
  description: {
    zh: "记住一件跨会话仍然成立的事实。同一个 subject 再写一次是覆盖旧正文，不新增一条；要改或纠正已有记忆就用同一个 subject。只记你以后某一轮真会用上的：用户给的长期偏好、口径和称呼；你踩过的坑和最后对的做法；只有你这边知道、以后还要用的环境事实；以及用户明说要你记住的事。不要记这一轮就过期的状态、转录里翻得到的原话、可复用工序（那是技能，用 create_skill）、别的 Bot 的活，也不要写进凭据、密钥或用户没打算留存的私事。写成一句可执行的结论，不是流水账。一轮最多记一条；没有真正需要跨会话的东西就一条都不记。记满了会直接报错并告诉你哪一条最久没更新，先用 forget 删一条再记。不要为这次记忆再发一条聊天消息。",
    en: "Remember one fact that still holds in later sessions. Writing the same subject again replaces the old body instead of adding a row; to revise or correct a memory, reuse its subject. Keep only what you will actually need again: long-term preferences, wording and names the user gave you; a trap you hit and the approach that finally worked; facts about this setup only you learned and will need again; and anything the user explicitly asked you to remember. Do not store state that expires this turn, quotes you can still find in the transcript, a reusable procedure (that is a skill — use create_skill), or another Bot's work, and never store credentials, keys, or private details the user did not ask you to keep. Write one actionable conclusion, not a log. At most one memory per turn; when nothing has to outlive this session, write none. A full memory fails loudly and names the entry longest without an update, so forget one first. Do not send a chat message about this memory.",
  },
  properties: {
    subject: {
      type: "string",
      description: {
        zh: "这条记忆讲的是什么，同一 Bot 内不区分大小写唯一。写成一眼能认出的短句，如「用户的时区」「发布脚本的坑」。",
        en: 'What this memory is about; unique per Bot, case-insensitive. Keep it recognisable at a glance, e.g. "the user\'s time zone".',
      },
    },
    body: {
      type: "string",
      description: {
        zh: "结论正文。一句话说清这件事，以及它在什么条件下成立。",
        en: "The conclusion. One sentence: the fact, and the condition under which it holds.",
      },
    },
  },
  required: ["subject", "body"],
};

export const FORGET: ToolDef = {
  name: "forget",
  description: {
    zh: "删掉自己的一条记忆。它不再成立、或者一开始就不该记，就删掉。不能删别人的。subject 与 id 至少给一个。不要为这次记忆再发一条聊天消息。",
    en: "Delete one of your own memories. Delete one when it no longer holds, or should never have been stored. You cannot delete another Bot's. Provide subject or id. Do not send a chat message about this memory.",
  },
  properties: {
    subject: {
      type: "string",
      description: { zh: "记忆的 subject。id 与 subject 至少给一个。", en: "The memory's subject. Provide id or subject." },
    },
    id: { type: "string", description: { zh: "记忆 id。", en: "Memory id." } },
  },
};
