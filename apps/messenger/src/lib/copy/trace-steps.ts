import type { CallRunVerdict } from "@real-bot/protocol";
import type { CopyShape } from "./shape.ts";

/** What one of the app's calls concluded, as a step on the flow board says it (ADR 0083). */
function zhVerdict(verdict: CallRunVerdict): string {
  switch (verdict.kind) {
    case "user_line": {
      const read = verdict.control === "stop" ? "读成：停下"
        : verdict.control === "go_on" ? "读成：继续"
          : verdict.control === "both" ? "读成：停下又继续"
            : verdict.status_only ? "读成：只问进度"
              : verdict.objections.length > 0 ? `读出 ${verdict.objections.length} 处不满`
                : verdict.passes?.length ? `读成：放行 ${verdict.passes.length} 份交付`
                  : "读成：普通的一句";
      return verdict.by_words ? `${read}（按词表）` : read;
    }
    case "bot_line": {
      const read = verdict.later ? `说还在做：「${verdict.later}」`
        : verdict.go_ahead ? "只问能不能接着做"
          : verdict.no_work ? "说没有要做的"
            : verdict.bare_status ? "只报了个状态"
              : verdict.claims_verified ? "说验证过了"
                : "没什么要处理的";
      return verdict.by_words ? `${read}（按词表）` : read;
    }
    case "filing":
      return verdict.about === "jobs" ? (verdict.task_ids.length > 1 ? `归到 ${verdict.task_ids.length} 件事` : "归到一件事")
        : verdict.about === "new" ? "是新的一件事"
          : verdict.about === "in_place" ? "就地办，不开事"
            : "说不清归哪件";
    case "scale":
      return verdict.large ? `是大活${verdict.unit ? `：按「${verdict.unit}」拆` : ""}` : "不是大活";
    case "scribe":
      return verdict.added === 0 && verdict.changed === 0 ? "没记新的要求"
        : [verdict.added ? `记下 ${verdict.added} 条` : "", verdict.changed ? `改了 ${verdict.changed} 条` : ""].filter(Boolean).join("，");
    case "organizer": {
      if (verdict.mode === "settle") return verdict.applied ? "整理好了" : `没整理成${verdict.reject_reason ? `：${verdict.reject_reason}` : ""}`;
      const what = verdict.decision === "new" ? "开一件新事"
        : verdict.decision === "continue" ? "接着这件事"
          : verdict.decision === "resume" ? "接回搁置的事"
            : verdict.decision === "join" ? "并入另一件事"
              : "没读成";
      return verdict.applied ? what : `${what}，没落地${verdict.reject_reason ? `：${verdict.reject_reason}` : ""}`;
    }
    case "judgement":
      return verdict.decision === "join" ? "接下" : `不下场${verdict.reason ? `：${verdict.reason}` : ""}`;
    case "composer":
      return `拟了 ${verdict.suggestions} 句`;
    case "compaction":
      return `留下 ${verdict.kept_hops}/${verdict.hops} 跳`;
    case "judge": {
      const said = verdict.passed === true ? "通过" : verdict.passed === false ? "没过" : "看不出";
      return verdict.note ? `${said} ${verdict.note}` : said;
    }
    case "reflection":
      return verdict.proposed ? `提了一条${verdict.note ? `：${verdict.note}` : ""}` : "没有要改的";
    case "retrospective":
      return `找到 ${verdict.findings} 条，改了 ${verdict.changes} 处`;
  }
}

function enVerdict(verdict: CallRunVerdict): string {
  switch (verdict.kind) {
    case "user_line": {
      const read = verdict.control === "stop" ? "Read as: stop"
        : verdict.control === "go_on" ? "Read as: go on"
          : verdict.control === "both" ? "Read as: stop, then go on"
            : verdict.status_only ? "Read as: only asks where it stands"
              : verdict.objections.length > 0 ? `Read ${verdict.objections.length} objection${verdict.objections.length === 1 ? "" : "s"}`
                : verdict.passes?.length ? `Read as: lets ${verdict.passes.length} hand-over${verdict.passes.length === 1 ? "" : "s"} through`
                  : "Read as: an ordinary line";
      return verdict.by_words ? `${read} (word lists)` : read;
    }
    case "bot_line": {
      const read = verdict.later ? `Says it is still at it: “${verdict.later}”`
        : verdict.go_ahead ? "Only asks to go on"
          : verdict.no_work ? "Says there is nothing to do"
            : verdict.bare_status ? "Only a status"
              : verdict.claims_verified ? "Says it verified"
                : "Nothing to act on";
      return verdict.by_words ? `${read} (word lists)` : read;
    }
    case "filing":
      return verdict.about === "jobs" ? (verdict.task_ids.length > 1 ? `Filed under ${verdict.task_ids.length} jobs` : "Filed under a job")
        : verdict.about === "new" ? "New work"
          : verdict.about === "in_place" ? "Done in place, no job"
            : "Unclear which job";
    case "scale":
      return verdict.large ? `A large job${verdict.unit ? `, by the ${verdict.unit}` : ""}` : "Not a large job";
    case "scribe":
      return verdict.added === 0 && verdict.changed === 0 ? "No new requirement"
        : [verdict.added ? `Wrote down ${verdict.added}` : "", verdict.changed ? `changed ${verdict.changed}` : ""].filter(Boolean).join(", ");
    case "organizer": {
      if (verdict.mode === "settle") return verdict.applied ? "Settled" : `Not settled${verdict.reject_reason ? `: ${verdict.reject_reason}` : ""}`;
      const what = verdict.decision === "new" ? "Opened a new job"
        : verdict.decision === "continue" ? "Goes on with this job"
          : verdict.decision === "resume" ? "Picked a parked job back up"
            : verdict.decision === "join" ? "Joined another job"
              : "Did not read";
      return verdict.applied ? what : `${what}, not filed${verdict.reject_reason ? `: ${verdict.reject_reason}` : ""}`;
    }
    case "judgement":
      return verdict.decision === "join" ? "Takes it up" : `Stays out${verdict.reason ? `: ${verdict.reason}` : ""}`;
    case "composer":
      return `Drafted ${verdict.suggestions}`;
    case "compaction":
      return `Kept ${verdict.kept_hops} of ${verdict.hops} hops`;
    case "judge": {
      const said = verdict.passed === true ? "Passed" : verdict.passed === false ? "Failed" : "Could not tell";
      return verdict.note ? `${said} ${verdict.note}` : said;
    }
    case "reflection":
      return verdict.proposed ? `Proposed one${verdict.note ? `: ${verdict.note}` : ""}` : "Nothing to change";
    case "retrospective":
      return `Found ${verdict.findings}, changed ${verdict.changes}`;
  }
}

const ZH_FAIL: Record<string, string> = {
  timeout: "超时",
  first_byte: "超时",
  no_model: "没设模型",
  unreadable: "回答读不懂",
  unparseable: "回答读不懂",
  truncated: "回答被截断",
  call_error: "调用出错",
  endpoint_error: "端点出错",
  claude_unavailable: "Claude Code 用不了",
  claude_failed: "Claude Code 出错",
  draining: "应用在退出",
  ablated: "关掉了",
  context_full: "超出上下文",
  empty: "什么也没写",
  aborted: "被打断",
};

const EN_FAIL: Record<string, string> = {
  timeout: "timed out",
  first_byte: "timed out",
  no_model: "no model set",
  unreadable: "answer did not read",
  unparseable: "answer did not read",
  truncated: "answer cut off",
  call_error: "the call failed",
  endpoint_error: "endpoint error",
  claude_unavailable: "Claude Code unavailable",
  claude_failed: "Claude Code failed",
  draining: "app shutting down",
  ablated: "switched off",
  context_full: "over the context",
  empty: "wrote nothing",
  aborted: "cut short",
};

export const zh = {
  lineTitle: "这句话",
  show: "显示环节",
  hide: "隐藏环节",
  showHint: "流程里画出应用自己的调用：读句、归档、书记员、判断下场、看图判定、整理、复盘",
  anomalies: "环节有异常",
  anomaliesCount: (count: number) => `${count} 处异常`,
  roundSteps: (count: number) => `${count} 个环节`,
  verdict: zhVerdict,
  failed: (kind: string | null) => `没成：${kind ? (ZH_FAIL[kind] ?? kind) : "原因不明"}`,
  times: (count: number) => `×${count}`,
  variant: {
    "call.read_user_line": "读你的话",
    "call.read_bot_line": "读 Bot 的话",
    "call.read_filing": "读归属",
    "call.read_scale": "读规模",
    "call.seams_image": "看图判定 · 衔接",
    "call.seams_text": "看图判定 · 衔接",
    "call.seams_digest": "看图判定 · 全片",
    "call.standard": "看图判定 · 照样片",
  } as Record<string, string>,
  organizerMessage: "归档",
  organizerSettle: "整理",
  model: "模型",
  thinking: "思考",
  prompt: "提示词",
  promptDefault: "默认",
  promptEdited: "改过的版本",
  took: (ms: number) => (ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`),
  cached: "沿用同一段话的上一次读法，没有再调模型",
  raw: "原始回答",
  rawLoading: "正在取原始回答…",
  rawNone: "没有回答",
  rawFailed: "取不到原始回答",
  jump: "跳到这句",
  edit: "改这个调用",
  close: "收起",
  useOf: (index: number, count: number) => `第 ${index}/${count} 次`,
};

export const en: CopyShape<typeof zh> = {
  lineTitle: "This line",
  show: "Show steps",
  hide: "Hide steps",
  showHint: "Draw the app's own calls in the flow: reading, filing, the scribe, joining in, picture checks, the organizer, retrospectives",
  anomalies: "Steps that went wrong",
  anomaliesCount: (count: number) => (count === 1 ? "1 went wrong" : `${count} went wrong`),
  roundSteps: (count: number) => (count === 1 ? "1 step" : `${count} steps`),
  verdict: enVerdict,
  failed: (kind: string | null) => `Did not work: ${kind ? (EN_FAIL[kind] ?? kind) : "no reason given"}`,
  times: (count: number) => `×${count}`,
  variant: {
    "call.read_user_line": "Reading your line",
    "call.read_bot_line": "Reading the Bot's line",
    "call.read_filing": "Reading where it goes",
    "call.read_scale": "Reading the job's size",
    "call.seams_image": "Picture checks · seams",
    "call.seams_text": "Picture checks · seams",
    "call.seams_digest": "Picture checks · whole set",
    "call.standard": "Picture checks · against the sample",
  },
  organizerMessage: "Filing",
  organizerSettle: "Settling",
  model: "Model",
  thinking: "Thinking",
  prompt: "Prompt",
  promptDefault: "Default",
  promptEdited: "Your edited version",
  took: (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`),
  cached: "Reused the earlier reading of the same words; no new call",
  raw: "Raw answer",
  rawLoading: "Fetching the raw answer…",
  rawNone: "No answer",
  rawFailed: "Couldn’t fetch the raw answer",
  jump: "Jump to the line",
  edit: "Change this call",
  close: "Put away",
  useOf: (index: number, count: number) => `Use ${index} of ${count}`,
};
