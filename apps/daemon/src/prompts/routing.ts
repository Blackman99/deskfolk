/**
 * The two prompts behind agent routing: one picks what a turn runs on, one decides afterwards
 * whether that pick was the thing the user was unhappy about.
 *
 * Both run as short, tool-less completions. The picking one sits between the user's message and the
 * reply, so it stays deliberately small: this message, the shortlist, and what went wrong before.
 */
import type { EndpointModel } from "@real-bot/protocol";

export const ROUTE_PICK_SYSTEM = `你在为一条刚到的消息挑模型，不是回答它。没有工具，不能发言，不能读工作区。

根据用户消息这份 JSON 里的 message、bot、candidates、previous、past_reviews 决定。

只输出一个 JSON 对象。不要 markdown 围栏，不要前言后语，不要 tool-call。

- model：必须原样抄 candidates 里的一个 model 值，不要改写、不要自己造名字。
- thinking_level：必须是该 model 的 thinking_levels 里的一个值。该数组为空时任何一档都可以。
- reason：一句话，写给会话详情里的模型选择记录看，说明你为什么这样挑。
- continues_previous：true 或 false。JSON 里有 previous 时，判断这条 message 是不是还在说 previous 那件事（接着改、指出不对、补充要求），是就 true；换了新话题就 false。没有 previous 时填 false。

策略：先看这条 message 本身要做什么——写代码、推理证明、长文写作、随口一句，还是普通请求。难的、要多步推理或要写长东西的，挑更强的模型和更重的思考等级；一句寒暄或一行确认，挑最轻的，别浪费。candidates 里的 strengths 是这个模型擅长什么，price 是相对价格，thinking_levels 是它认的档位名（越靠后越重）。bot 是这个 Bot 的职责和边界，挑得和它平时干的活相称。

previous 是这个 Bot 上一轮的触发消息和当时选的模型，只用来判 continues_previous，不要因为它改变这一条的挑法。

past_reviews 是这个 Bot 以前选错时的复盘结论，按时间倒序。每一条都带 message（当时那条触发消息的摘录）、signature（消息类别：coding 写代码 / writing 写作 / reasoning 推理 / simple 闲聊 / general 普通）、model 和 thinking_level（当时选的）、direction（当时该往哪边调：stronger 更强 / lighter 更轻 / faster 更快 / cheaper 更便宜 / same 不动）、rounds（用户为此纠正了几轮）和 reason（一句说明）。只有 message 和 signature 都对得上现在这条 message，才按 direction 调整；对不上就当没看见。

clean_completions 是这个 Bot 最近干净做完的选择：终态完成、工具没有报错、用户没有追问。每一条是 message、signature、model、thinking_level，每个类别最多一条。这是「这种消息这样选已经做完」的记录。没有对得上的 past_reviews 时，保持这个量级，不要为了保险升到更强的模型和更重的档。`;

/**
 * The one call after a review that may write. It sees the closed chain and may only call remember,
 * forget, or update_skill. Saying nothing writes nothing.
 */
export const ROUTE_LEARN_SYSTEM = `你在替这个 Bot 记下一条以后同类任务用得上的结论，不是回答用户，也不能在会话里发言。

根据用户消息这份 JSON 里的 chain 决定。chain.trigger 是当初那条消息，chain.reply 是 Bot 的回复，chain.follow_ups 是用户随后说的，chain.execution 是实际做了什么（null 表示没数到，不是 0），chain.verdict 是刚才的复盘结论，chain.skills 是这个 Bot 已有的技能。

只能调用 remember、forget、update_skill。不要调用别的工具，不要输出正文。

- 一次事故写成一条记忆：remember 的 subject 一眼能认出，body 是一句可执行的结论，写清下次先做什么、不要再做什么。
- 凭据、密钥、只在这一轮成立的状态，不记。没有真正能让下一轮同类任务更短的东西，就什么都不调用。
- 记忆满了会报错并点名最久没更新的一条。那时先 forget 那一条，再 remember。写不进去就停，不要改别的主题。
- 不新建技能。只有 chain.skills 里已有一条技能的说明和这件事重合，才用 update_skill 改它的正文。用户在 follow_ups 里明说「以后都这样」时也只改已有技能，没有就记成记忆。`;

export const ROUTE_REVIEW_SYSTEM = `你在复盘一次模型选择，不是回答用户，也不是评价 Bot 的人品。没有工具，不能发言。

根据用户消息这份 JSON 里的 bot、turn、follow_ups 决定：那一轮之后用户接着说的这些话，到底是不是在说「这个模型不行」。

只输出一个 JSON 对象。不要 markdown 围栏，不要前言后语，不要 tool-call。

- fault：必须是英文字面 model、task、prompt 或 none 之一。
  - model：模型本身不行——答得浅、绕不过去、反复改不对、慢得离谱、贵得不值。
  - task：事情本身就难或中途变了需求，换个模型也一样。
  - prompt：用户一开始没说清、点名写错、给错了文件或前提，问题出在输入不在模型。
  - none：用户没有不满，只是继续聊、追加新需求或道谢。
- direction：必须是 stronger、lighter、faster、cheaper 或 same 之一。fault 不是 model 时填 same。
- rounds：用户为同一件事纠正了几轮，整数。
- confidence：0 到 1 的小数，你对这个判断的把握。
- reason：一句话说明。

策略：看的是整段而不是最后一句。用户连着几轮说「这里不对」「还是不行」「算了我自己改」，而每轮指出的都是同一类毛病（理解错了、漏了要求、答得太浅），才是 model。用户越说越具体、补充了一开始没讲的前提，那是 prompt。用户换了要求、加了新功能，那是 task。

turn.execution 是这一链实际做了什么：hops 是补全跳数，tool_calls / tool_errors 是工具调用和其中失败的次数，repeated_failures 是跟更早一次失败完全相同的调用，files_written 是写出的文件数，fail_kind 是补全失败的种类，cost_usd_ticks 是花费。某一项是 null 表示当时没数到，把它当成不知道，不要当成 0。工具反复同一错误、fail_kind 是 incomplete（回复不完整）或 refused（端点拒绝），可以作为 model 的依据。拿不准就把 confidence 压低，不要硬凑一个 model。`;

export type RoutePickPayload = {
  message: string;
  bot: { name: string; duties: string; boundaries: string };
  candidates: (EndpointModel & { model: string })[];
  /** The Bot's previous trigger here, so the same call can say whether this message continues it. */
  previous?: { message: string; model: string; thinking_level: string };
  past_reviews: {
    message: string;
    signature: string;
    model: string;
    thinking_level: string;
    direction: string;
    rounds: number;
    reason: string;
  }[];
  clean_completions: {
    message: string;
    signature: string;
    model: string;
    thinking_level: string;
  }[];
};

/** Reviews the picker is shown; older conclusions fall out of the window rather than decaying. */
export const PAST_REVIEW_WINDOW = 6;

/** Clean finishes the picker is shown, at most one per message kind. */
export const CLEAN_COMPLETION_LIMIT = 4;

/** How much of the previous trigger the picker sees; it only has to recognise the topic. */
export const PREVIOUS_MESSAGE_LIMIT = 400;

/** The reply shown to the reviewer; enough to judge the answer without paying for the whole turn. */
export const REVIEW_REPLY_LIMIT = 1200;

export function routePickPayload(input: {
  message: string;
  bot: { name: string; duties: string; boundaries: string };
  candidates: readonly EndpointModel[];
  previous?: { message: string; model: string; thinkingLevel: string } | null;
  pastReviews: readonly {
    message: string;
    signature: string;
    model: string;
    thinkingLevel: string;
    direction: string;
    rounds: number;
    reason: string;
  }[];
  cleanCompletions?: readonly {
    message: string;
    signature: string;
    model: string;
    thinkingLevel: string;
  }[];
}): RoutePickPayload {
  return {
    message: input.message,
    bot: input.bot,
    candidates: input.candidates.map((row) => ({ ...row, model: row.name })),
    ...(input.previous
      ? {
          previous: {
            message: input.previous.message.slice(0, PREVIOUS_MESSAGE_LIMIT),
            model: input.previous.model,
            thinking_level: input.previous.thinkingLevel,
          },
        }
      : {}),
    past_reviews: input.pastReviews.slice(0, PAST_REVIEW_WINDOW).map((row) => ({
      message: row.message.slice(0, PREVIOUS_MESSAGE_LIMIT),
      signature: row.signature,
      model: row.model,
      thinking_level: row.thinkingLevel,
      direction: row.direction,
      rounds: row.rounds,
      reason: row.reason,
    })),
    clean_completions: (input.cleanCompletions ?? [])
      .slice(0, CLEAN_COMPLETION_LIMIT)
      .map((row) => ({
        message: row.message.slice(0, PREVIOUS_MESSAGE_LIMIT),
        signature: row.signature,
        model: row.model,
        thinking_level: row.thinkingLevel,
      })),
  };
}

/** What the chain actually did. Null is "not counted", which the reviewer must not read as zero. */
export type ReviewExecution = {
  hops: number | null;
  tool_calls: number | null;
  tool_errors: number | null;
  repeated_failures: number | null;
  files_written: number | null;
  fail_kind: string | null;
  cost_usd_ticks: number | null;
};

export type RouteLearnPayload = {
  chain: {
    trigger: string;
    model: string;
    thinking_level: string;
    reply: string;
    outcome: string;
    follow_ups: string[];
    execution: ReviewExecution;
    verdict: { fault: string; direction: string; reason: string };
    skills: { name: string; description: string }[];
  };
};

/** What the learning hop sees. The reply stays short; the skills are names and descriptions only. */
export function routeLearnPayload(input: {
  message: string;
  model: string;
  thinkingLevel: string;
  reply: string;
  outcome: string;
  followUps: readonly string[];
  execution: ReviewExecution;
  verdict: { fault: string; direction: string; reason: string };
  skills: readonly { name: string; description: string }[];
}): RouteLearnPayload {
  return {
    chain: {
      trigger: input.message,
      model: input.model,
      thinking_level: input.thinkingLevel,
      reply: input.reply.slice(0, REVIEW_REPLY_LIMIT),
      outcome: input.outcome,
      follow_ups: [...input.followUps],
      execution: input.execution,
      verdict: input.verdict,
      skills: input.skills.map((skill) => ({ name: skill.name, description: skill.description })),
    },
  };
}

export type RouteReviewPayload = {
  bot: { name: string; duties: string };
  turn: {
    message: string;
    model: string;
    thinking_level: string;
    reply: string;
    outcome: string;
    execution: ReviewExecution;
  };
  follow_ups: string[];
};

export function routeReviewPayload(input: {
  bot: { name: string; duties: string };
  message: string;
  model: string;
  thinkingLevel: string;
  reply: string;
  outcome: string;
  followUps: readonly string[];
  execution: ReviewExecution;
}): RouteReviewPayload {
  return {
    bot: input.bot,
    turn: {
      message: input.message,
      model: input.model,
      thinking_level: input.thinkingLevel,
      reply: input.reply.slice(0, REVIEW_REPLY_LIMIT),
      outcome: input.outcome,
      execution: input.execution,
    },
    follow_ups: [...input.followUps],
  };
}
