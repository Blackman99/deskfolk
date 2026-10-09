/** Writing a plan's facts as the lines a turn reads. */
import type { AcceptanceCheckOutcome, Locale, PlanStatus, TicketStage, TicketStatus } from "@real-bot/protocol";
import { codePointCount } from "../text";
import { oneLineClip, quoteTime } from "./common";
import { QUOTE_LAYER_HEAD, QUOTE_LAYER_TAIL, type PlanCheckFact, type PlanFacts, type PlanTicketFact, type QuoteFact, type QuoteLayer, type RequirementFact } from "./plan-facts";

/** Turns elsewhere on the same plan the block names. */
export const ELSEWHERE_LINES = 6;
/** This Bot's other live turns the block names. */
export const OTHER_WORK_LINES = 3;

/** Tickets the situation block lists; a plan past this says how many more there are. */
export const PLAN_TICKET_LINES = 20;
/** Checks the situation block lists; matches the store's own cap on active checks per plan. */
export const PLAN_CHECK_LINES = 10;
/**
 * Requirements said once that the block lists besides those said twice or more, which are always
 * all there: at most this many lines, and this many code points between them.
 */
export const REQUIREMENT_LINES = 20;
export const REQUIREMENT_BUDGET = 2000;
/** Proposed entries, and old unverified rules, the block lists, each. */
export const REQUIREMENT_ASIDE_LINES = 10;

/** The lines a large job adds to the situation: lay it out first, the sample first, and what waits for what. */
function largeJobLines(large: NonNullable<PlanFacts["large"]>, locale: Locale): string[] {
  const en = locale === "en";
  const n = (seq: number) => String(seq).padStart(2, "0");
  const lines: string[] = [];
  if (!large.laid_out) {
    lines.push(en
      ? `This is a large job${large.why ? ` (the user: 「${large.why}」)` : ""}. Lay it out before making anything: the plan's lead calls plan_items with the units${large.unit ? ` (${large.unit} each)` : ""}, `
        + "one of them sample: true — made first, to the full standard the whole job needs, for the user to approve — the rest waiting for it, and a last one that puts them together. "
        + "Until then the app refuses generating calls (images, video and other MCP calls with side effects) and hand-overs; reading, notes, scripts and local commands go on."
      : `这是件大活${large.why ? `（用户说的「${large.why}」）` : ""}。先拆再做：规划负责人用 plan_items 拆成几件${large.unit ? `（每件${large.unit}）` : ""}，`
        + "其中一件标 sample: true 作样片——先做、按整件事要的水准做足、交给用户放行——其余各件等它，最后一件负责组装。"
        + "拆好之前，应用会拒绝出图、出视频这类有副作用的外部调用和交付；读文件、写笔记和脚本、跑本地命令照常。");
  }
  if (large.sample) {
    const approved = large.sample.stage === "approved";
    lines.push(en
      ? `Sample: ticket #${n(large.sample.seq)} "${large.sample.title}" — ${approved ? "approved by the user; every other unit is compared with it when handed over" : "not approved yet; the units waiting for it do not start until the user approves it"}.`
      : `样片：任务 #${n(large.sample.seq)}「${large.sample.title}」——${approved ? "用户已放行；其余各件交上来时拿它对照水准" : "还没放行；等它的各件在用户放行前不开工"}。`);
  }
  if (large.waiting_on) {
    lines.push(en
      ? `This turn's ticket waits for ticket #${n(large.waiting_on.seq)} "${large.waiting_on.title}"${large.waiting_on.sample ? " (the sample)" : ""}: generating and handing over on it are refused until that one is through.`
      : `这一轮的任务在等任务 #${n(large.waiting_on.seq)}「${large.waiting_on.title}」${large.waiting_on.sample ? "（样片）" : ""}：它过了之前，这张任务上出图出视频和交付都会被拒。`);
  }
  return lines;
}

const PLAN_STATUS_LABEL: Record<PlanStatus, { zh: string; en: string }> = {
  active: { zh: "进行中", en: "active" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

const TICKET_STATUS_LABEL: Record<TicketStatus, { zh: string; en: string }> = {
  todo: { zh: "待做", en: "to do" },
  doing: { zh: "进行中", en: "doing" },
  review: { zh: "待验收", en: "review" },
  done: { zh: "已完成", en: "done" },
  parked: { zh: "搁置", en: "parked" },
};

/** The stages a status does not say (ADR 0046), named in their place. */
const TICKET_STAGE_LABEL: Partial<Record<TicketStage, { zh: string; en: string }>> = {
  submitted: { zh: "已交付，待审查", en: "submitted, awaiting review" },
  in_review: { zh: "审查中", en: "in review" },
  rework: { zh: "返工", en: "rework" },
  approved: { zh: "已通过", en: "approved" },
  dropped: { zh: "作废", en: "dropped" },
};

/** A part's stage, as the line naming the turn's ticket's parts says it. */
const PART_STAGE_LABEL: Record<string, { zh: string; en: string }> = {
  todo: { zh: "待做", en: "to do" },
  in_progress: { zh: "进行中", en: "in progress" },
  submitted: { zh: "已交付", en: "handed over" },
  approved: { zh: "已通过", en: "approved" },
  rework: { zh: "返工", en: "rework" },
  blocked: { zh: "卡住", en: "stuck" },
  waived: { zh: "不要了", en: "waived" },
};

function ticketWord(ticket: Pick<PlanTicketFact, "status" | "stage">, locale: Locale): string {
  return (ticket.stage ? TICKET_STAGE_LABEL[ticket.stage]?.[locale] : undefined) ?? TICKET_STATUS_LABEL[ticket.status][locale];
}

function ticketLine(ticket: PlanTicketFact, locale: Locale): string {
  const en = locale === "en";
  const number = String(ticket.seq).padStart(2, "0");
  const bits = [ticketWord(ticket, locale)];
  // Who is on it only while it is open: an approved one says who made it, one set aside nobody's.
  const closed = ticket.stage === "approved" || (!ticket.stage && ticket.status === "done");
  if (ticket.worker && closed) bits.push(en ? `made by ${ticket.worker}` : `${ticket.worker}做的`);
  else if (ticket.worker && ticket.status !== "parked") bits.push(en ? `${ticket.worker} on it` : `${ticket.worker}在做`);
  if (ticket.artifacts.length > 0) bits.push(ticket.artifacts.join(en ? ", " : "、"));
  return en ? `${number} ${ticket.title} (${bits.join("; ")})` : `${number} ${ticket.title}（${bits.join("；")}）`;
}

const CHECK_OUTCOME_LABEL: Record<AcceptanceCheckOutcome, { zh: string; en: string }> = {
  pass: { zh: "通过", en: "pass" },
  fail: { zh: "不通过", en: "fail" },
  blocked: { zh: "受阻", en: "blocked" },
  error: { zh: "出错", en: "error" },
};

/** 「item」what：outcome（detail；N 分钟前）— or, unrun, just 「item」what：未跑. */
function checkLine(check: PlanCheckFact, locale: Locale): string {
  const en = locale === "en";
  // Information for the reviewer, never a block: the user has not confirmed it.
  if (check.unconfirmed) return en ? `"${check.item}" ${check.unconfirmed}` : `「${check.item}」${check.unconfirmed}`;
  if (!check.outcome || check.ageMinutes === null) {
    return en ? `"${check.item}" ${check.what}: not run yet` : `「${check.item}」${check.what}：未跑`;
  }
  const outcome = CHECK_OUTCOME_LABEL[check.outcome][locale];
  const age = en ? `${check.ageMinutes}min ago` : `${check.ageMinutes} 分钟前`;
  const reference = check.reference ? (en ? " — judged by a model looking at pictures: for reference only, not a block" : "——看图判定，只作参考，不挡交付") : "";
  return en
    ? `"${check.item}" ${check.what}: ${outcome} (${check.detail}; ${age})${reference}`
    : `「${check.item}」${check.what}：${outcome}（${check.detail}；${age}）${reference}`;
}

/** A turn that is not simply done says so on its trace line; a completed one needs no label. */
export function traceStateLabel(status: string, locale: Locale): string {
  const labels: Record<string, { zh: string; en: string }> = {
    running: { zh: "（进行中）", en: " (running)" },
    waiting_ask: { zh: "（等用户回答）", en: " (waiting on the user)" },
    waiting_approval: { zh: "（等批准）", en: " (waiting for approval)" },
    interrupted: { zh: "（中断）", en: " (interrupted)" },
    stopped: { zh: "（已停止）", en: " (stopped)" },
    redirected: { zh: "（改道）", en: " (redirected)" },
  };
  const label = labels[status];
  return label ? label[locale] : "";
}

/** The plan's lines of the situation block, after the group facts and before the work dir. */
export function planLines(facts: PlanFacts, locale: Locale): string[] {
  const en = locale === "en";
  const sep = en ? "; " : "；";
  const lines: string[] = [];
  if (facts.goal) {
    const tags = [facts.kind, PLAN_STATUS_LABEL[facts.status][locale]].filter((tag): tag is string => Boolean(tag));
    lines.push(
      en
        ? `Plan "${facts.title}": ${facts.goal} (${tags.join(", ")})`
        : `规划「${facts.title}」：${facts.goal}（${tags.join("，")}）`,
    );
    if (facts.goal_before_rename) {
      lines.push(en
        ? "The user renamed this job after its goal was written: where the goal disagrees with the name or with their own words, their words win."
        : "用户在目标写下之后给这件事改了名：目标和名字、用户原话对不上时，以用户原话为准。");
    }
    if (facts.process.length > 0) lines.push(`${en ? "Process: " : "流程与分工："}${facts.process.join(sep)}`);
    if (facts.progress) {
      const parts: string[] = [];
      if (facts.progress.done.length > 0) parts.push(`${en ? "done: " : "已完成 "}${facts.progress.done.join(en ? ", " : "、")}`);
      if (facts.progress.open.length > 0) parts.push(`${en ? "open: " : "待做 "}${facts.progress.open.join(en ? ", " : "、")}`);
      if (facts.progress.blocked.length > 0) parts.push(`${en ? "blocked: " : "卡住 "}${facts.progress.blocked.join(en ? ", " : "、")}`);
      if (parts.length > 0) lines.push(`${en ? "Progress: " : "进展："}${parts.join(sep)}`);
    }
  } else if (facts.first_turn) {
    lines.push(
      en ? `This is the first turn of this job (plan "${facts.title}").` : `这是这件事的第一轮（规划「${facts.title}」）。`,
    );
  } else if (facts.brief) {
    lines.push(
      en
        ? `What this job was asked for (plan "${facts.title}"): ${facts.brief}`
        : `这件事最初的要求（规划「${facts.title}」）：${facts.brief}`,
    );
  }
  // The user's own words and what they asked, before anything the app or a Bot made of them. The
  // plan's rules and Done-when lines are in the ledger now, typed on the board or taken in as old rules.
  if (facts.quotes) lines.push(quoteLines(facts.quotes, locale));
  if (facts.large) lines.push(...largeJobLines(facts.large, locale));
  lines.push(...requirementLines(facts.requirements, locale));
  if (facts.calibration.length > 0) {
    const rows = facts.calibration.map((miss) => en
      ? `- "${miss.ticket}" (${quoteTime(miss.at)}): the user said "${miss.quote}"`
      : `- 「${miss.ticket}」（${quoteTime(miss.at)}）：用户说「${miss.quote}」`);
    lines.push(`${en
      ? "Your calibration record — approvals of yours the user overturned here; weigh the same kind of thing harder before passing it:"
      : "你的校准记录——你放行后被用户推翻的；再审同类问题时要更严："}\n${rows.join("\n")}`);
  }
  if (facts.checklist && facts.checklist.length > 0) {
    const moment = { before_review: en ? "before passing it" : "放行前", before_submit: en ? "before handing it over" : "交付前", before_generate: en ? "before generating" : "生成前" };
    const rows = facts.checklist.map((item) => `- ${moment[item.hook]}${en ? ": " : "："}${item.text}`);
    lines.push(`${en ? "Your own checklist — from your reflections the user adopted; go through it at that moment:" : "你自己的清单——用户采用了的你的反思；到那个时机逐条过一遍："}\n${rows.join("\n")}`);
  }
  if (facts.checks.length > 0) {
    const rows = facts.checks.map((check) => `- ${checkLine(check, locale)}`);
    lines.push(`${en ? "Acceptance checks (the app runs these itself, on this machine):" : "验收检查（应用在本机自己跑）："}\n${rows.join("\n")}`);
  }
  if (facts.home) {
    lines.push(en ? `This plan was opened in ${facts.home}.` : `这件事是在${facts.home}里开的。`);
  }
  if (facts.elsewhere.length > 0) {
    const who = facts.elsewhere.map((turn) =>
      en ? `${turn.self ? "you" : turn.bot} (${turn.where})` : `${turn.self ? "你" : turn.bot}（${turn.where}）`,
    );
    lines.push(en ? `Also working on this plan elsewhere: ${who.join(", ")}.` : `这件事别处进行中的轮：${who.join("、")}。`);
    const heard = facts.elsewhere.filter((turn) => turn.heard);
    if (heard.length > 0) {
      const names = [...new Set(heard.map((turn) => (turn.self ? (en ? "you" : "你") : turn.bot)))];
      const mine = heard.some((turn) => turn.self);
      lines.push(
        en
          ? `The line that opened this turn has been passed to ${names.join(", ")}.${mine ? " Your turn there got it too and does any work it calls for; here, answer the user and do not make the same change twice." : ""}`
          : `触发这一轮的那句已经转给了${names.join("、")}。${mine ? "你在那边的那一轮也收到了，要动手的由它接着做；这里回应用户就好，不要重复做同样的改动。" : ""}`,
      );
    }
  }
  if (facts.other_work.length > 0) {
    const rows = facts.other_work.map((work) => {
      const ticket = work.ticket ? (en ? ` · ticket ${work.ticket}` : `· 任务 ${work.ticket}`) : "";
      return en ? `plan "${work.plan}"${ticket} in ${work.where}` : `${work.where}里的规划「${work.plan}」${ticket}`;
    });
    lines.push(en ? `Your other live turns: ${rows.join("; ")}.` : `你同时在干的别的事：${rows.join("；")}。`);
  }
  // A dropped ticket is no task (the job's opening ticket, folded once the lead laid the job out,
  // read 「搁置；设计师在做」 here), unless it is this turn's own.
  const listed = facts.tickets.filter((ticket) => ticket.stage !== "dropped" || ticket.id === facts.ticket?.id);
  if (listed.length > 0) {
    const shown = listed.slice(0, PLAN_TICKET_LINES);
    const rest = listed.length - shown.length;
    const rows = shown.map((ticket) => `- ${ticketLine(ticket, locale)}`);
    if (rest > 0) rows.push(en ? `- … and ${rest} more` : `- …还有 ${rest} 条`);
    lines.push(`${en ? "Tickets:" : "任务清单："}\n${rows.join("\n")}`);
  }
  if (facts.rework_asked && facts.rework_asked.length > 0) {
    const named = facts.rework_asked.map((ticket) => `${String(ticket.seq).padStart(2, "0")}${en ? ` "${ticket.title}"` : `「${ticket.title}」`}`).join(en ? ", " : "、");
    lines.push(en
      ? `(App) The line that opened this turn reads as a complaint about ${named}, already handed over: a card is asking the user whether to send it back to rework. That is theirs to decide — do not change it or hand the fix to anyone meanwhile; if they send it back, the app wakes its maker with these words.`
      : `（应用）叫醒这一轮的那句话读成了对已交出的 ${named}的意见：卡片正在问用户要不要转回返工。这由用户定——定之前别改它，也别另派人改；用户选了返工，应用会带着这句话叫做的 Bot 改。`);
  }
  if (facts.rework_sent && facts.rework_sent.length > 0) {
    const named = facts.rework_sent.map((ticket) => `${String(ticket.seq).padStart(2, "0")}${en ? ` "${ticket.title}"` : `「${ticket.title}」`}`).join(en ? ", " : "、");
    lines.push(en
      ? `(App) The line that opened this turn reads as a complaint about ${named}, already handed over, and sent it back to rework: the app has told its maker, with these words. Do not hand the fix to anyone else.`
      : `（应用）叫醒这一轮的那句话读成了对已交出的 ${named}的意见，已经转回返工：应用已带着这句话告诉做它的 Bot。别另派人改它。`);
  }
  if (facts.ticket) {
    const number = String(facts.ticket.seq).padStart(2, "0");
    const head = en
      ? `This turn's ticket: ${number} ${facts.ticket.title} (${ticketWord(facts.ticket, "en")})`
      : `本轮任务：${number} ${facts.ticket.title}（${ticketWord(facts.ticket, "zh")}）`;
    lines.push(facts.ticket.spec ? `${head}${en ? " — " : "——"}${oneLineClip(facts.ticket.spec, 600)}` : head);
    if (facts.ticket.parts && facts.ticket.parts.length > 0) {
      const named = facts.ticket.parts.map((part) => {
        const stage = PART_STAGE_LABEL[part.stage]?.[en ? "en" : "zh"] ?? part.stage;
        return en ? `${part.key} (${part.title}, ${stage})` : `${part.key}（${part.title}·${stage}）`;
      }).join(en ? ", " : "、");
      lines.push(en
        ? `Its parts: ${named}. Name the ones a hand-over covers in submit's parts; without them it is the whole ticket's.`
        : `它的分件：${named}。交其中几个时在 submit 的 parts 里写明；不写就算整张任务的。`);
    }
  }
  if (facts.artifacts.length > 0) {
    lines.push(
      en ? `Handed over so far: ${facts.artifacts.join(", ")}` : `这件事已交出：${facts.artifacts.join("、")}`,
    );
  }
  if (facts.trace.length > 0) {
    lines.push(`${en ? "So far:" : "经过："}\n${facts.trace.map((line) => `- ${line}`).join("\n")}`);
  }
  if (facts.check_back) {
    lines.push(
      en
        ? `Your check-back: in ${facts.check_back.in_minutes} min (${facts.check_back.note})`
        : `你约的回看：${facts.check_back.in_minutes} 分钟后（${facts.check_back.note}）`,
    );
  }
  return lines;
}

/** The quote layer as block text: the first lines, how many between, the latest. */
function quoteLines(layer: QuoteLayer, locale: Locale): string {
  const en = locale === "en";
  const row = (quote: QuoteFact) => (en ? `- ${quote.at} ${quote.where}: ${quote.body}` : `- ${quote.at} ${quote.where}：${quote.body}`);
  const rows = layer.head.map(row);
  if (layer.omitted > 0) rows.push(en ? `- … ${layer.omitted} more in between` : `- …中间还有 ${layer.omitted} 条`);
  rows.push(...layer.tail.map(row));
  const head = layer.omitted > 0
    ? en
      ? `What the user said in this job (verbatim; the first ${QUOTE_LAYER_HEAD} and the latest ${QUOTE_LAYER_TAIL}):`
      : `用户在这件事里的话（原文，最早 ${QUOTE_LAYER_HEAD} 条和最新 ${QUOTE_LAYER_TAIL} 条）：`
    : en
      ? "What the user said in this job (verbatim):"
      : "用户在这件事里的话（原文）：";
  return `${head}\n${rows.join("\n")}`;
}

/** R-31｜「words」（转述：…）｜用户已说 7 次（跨 3 个规划）｜适用：…｜挂检查：… */
function requirementLine(entry: RequirementFact, locale: Locale): string {
  const en = locale === "en";
  const bits = [en ? `R-${entry.seq} | "${entry.quote}"` : `R-${entry.seq}｜「${entry.quote}」`];
  if (entry.restated) bits[0] += en ? ` (restated: ${entry.restated})` : `（转述：${entry.restated}）`;
  if (entry.replaces) bits.push(en ? `would replace R-${entry.replaces.seq} "${entry.replaces.quote}"` : `要取代 R-${entry.replaces.seq}「${entry.replaces.quote}」`);
  if (entry.times >= 2) {
    const across = entry.plans >= 2 ? (en ? ` (across ${entry.plans} plans)` : `（跨 ${entry.plans} 个规划）`) : "";
    bits.push(en ? `the user said it ${entry.times} times${across}` : `用户已说 ${entry.times} 次${across}`);
  }
  bits.push(en ? `holds for: ${entry.appliesTo}` : `适用：${entry.appliesTo}`);
  if (entry.check) bits.push(en ? `check: ${entry.check}` : `挂检查：${entry.check}`);
  return bits.join(en ? " | " : "｜");
}

/**
 * The requirements section (ADR 0040 P3): the entries in force, nearest to this turn first and then
 * the most often and most recently said, every one said twice or more and the rest up to
 * {@link REQUIREMENT_LINES} lines and {@link REQUIREMENT_BUDGET} code points; then the proposed ones
 * and the old unverified rules, each in a section of its own, since neither is a requirement yet.
 */
function requirementLines(entries: RequirementFact[], locale: Locale): string[] {
  const en = locale === "en";
  const more = (n: number) => (en ? `- … and ${n} more` : `- …还有 ${n} 条`);
  const order = (a: RequirementFact, b: RequirementFact) =>
    a.nearness - b.nearness || b.times - a.times || (a.lastRaisedAt < b.lastRaisedAt ? 1 : a.lastRaisedAt > b.lastRaisedAt ? -1 : 0) || a.seq - b.seq;
  const lines: string[] = [];
  const open = entries.filter((entry) => entry.status === "open").sort(order);
  if (open.length > 0) {
    const rows: string[] = [];
    let once = 0;
    let spent = 0;
    let left = 0;
    for (const entry of open) {
      const row = `- ${requirementLine(entry, locale)}`;
      if (entry.times >= 2) {
        rows.push(row);
        continue;
      }
      const cost = codePointCount(row);
      if (once < REQUIREMENT_LINES && spent + cost <= REQUIREMENT_BUDGET) {
        rows.push(row);
        once += 1;
        spent += cost;
      } else {
        left += 1;
      }
    }
    if (left > 0) rows.push(more(left));
    lines.push(`${en ? "User requirements (nearest first):" : "用户要求（按适用范围由近到远）："}\n${rows.join("\n")}`);
  }
  const aside = (status: RequirementFact["status"], head: string): void => {
    const listed = entries.filter((entry) => entry.status === status).sort(order);
    if (listed.length === 0) return;
    const rows = listed.slice(0, REQUIREMENT_ASIDE_LINES).map((entry) => `- ${requirementLine(entry, locale)}`);
    if (listed.length > REQUIREMENT_ASIDE_LINES) rows.push(more(listed.length - REQUIREMENT_ASIDE_LINES));
    lines.push(`${head}\n${rows.join("\n")}`);
  };
  aside(
    "proposed",
    en ? "Waiting for the user to confirm (not in force; do not act on these as requirements):" : "待用户确认的取代或建议（还没生效，不要当要求执行）：",
  );
  aside("unverified", en ? "Old rules (source unverified; for reference only):" : "旧规则（出处未核实，只作参考）：");
  return lines;
}
