/**
 * The organizer (整理跳): one tool-less short completion that keeps a session's plan and tickets
 * in order. It runs after the user speaks and before any turn opens — deciding whether the line
 * continues the current plan, starts another, goes back to an earlier one or is about a job the
 * Bots here are doing in another session, and which ticket it is about — and again once a plan's
 * turns have all ended, to file what was handed over.
 *
 * The prompt and the payload live here; the engine-side orchestration is in `organizer.ts`.
 */
import { USER_MEMBER, type AcceptanceCheckKind, type Message, type Ticket, type TicketStatus } from "@real-bot/protocol";
import { describeCheck } from "../acceptance-eval";
import { sessionLabel } from "../context";
import { extractJsonObject } from "../route-agent";
import {
  CHECK_KINDS,
  CHECKS_MAX,
  isTicketStatus,
  normalizePlanSpec,
  parsePlanSpec,
  type OrganizerCheckInput,
  titleKey,
  type OrganizerResult,
  type OrganizerTicketInput,
  type PlanSpec,
  type PlanStatus,
  type Store,
  type Task,
} from "../store";
import { takeCodePoints } from "../text";

export const ORGANIZER_SYSTEM = `你在替这个会话整理「规划」和「任务」，不是回答用户，也不能发言。没有工具，不能读工作区。

规划是一个会话里正在推进的一件事，有要点：kind（类别，用来找先例）、goal（现在到底要做什么）、acceptance（怎么算完成）、rules（用户自己定的口径、约束、改善意见）、process（这件事定下来的做法、谁负责哪段；Bot 自己定的做法和限制也写在这里，写明是谁定的）、progress（done / open / blocked）、status（active / done / parked）。任务是规划下能独立交付的一块：title、spec（要交出什么、怎么算完成）、status（todo / doing / review / done / parked）、worker（谁负责，写 Bot 名字：建任务时按分工先填，之后按 trace 里实际在做的人改；没人就 null）。

根据用户消息这份 JSON 决定。mode 是 message（用户刚发了一句，message 就是那句）或 settle（这件事的轮都结束了，只更新要点和任务，decision 必须是 continue）。current_plan 是这个会话当前的规划及其任务（可能为 null）；current_plan.checks 是这个规划当前的验收检查——应用自己在本机跑出来的证据，每条有 id、item（对应哪条 acceptance）、kind、what（人话描述）、source（organizer 还是 user）、ticket（任务序号或 null）、last（上一次运行：outcome、detail、at、output，或 null 表示还没跑过）；current_plan.user_lines 是这件事里用户说过、但不在 since_last_revision.messages 里的话，早的在前（via 是 message 的是用户发的话，answer 是用户对 Bot 提问的回答，asked 是那个问题；太多时省掉中间的，user_lines_omitted 是省了几条）；current_plan.goal_user_typed 为 true 的 goal、acceptance_user_typed 里的验收、rules_user_typed 里的规则，是用户在流程图里亲手写的，tickets[].spec_user_typed 为 true 的任务说明也是；recent_plans 是这个会话之前推进过的规划，只有 resume 会用到；elsewhere_plans 是这个会话里的 Bot 正在别的会话推进的事（home 是它开在哪，working 是此刻谁在哪做它，said_here 是这个会话里之前归到它的几句），只有 join 会用到；kinds 是已有的类别标签，能对上就原样用，对不上才起一个短的；since_last_revision 是上一版要点之后发生的事：messages（谁说了什么：from 是 user 的是用户说的，bot 是 Bot 说的，app 是应用的提示；kind 是 ask 的是 Bot 的提问，answer 是用户的回答）、user_spoke（上一版之后用户有没有说过话或回答过提问）、artifacts（谁交出了什么文件，归在哪个任务）、trace（谁做了什么、停在哪）、commands（这些轮真正跑过的命令和工具，带退出码和实际跑的目录 cwd）；current_plan.tickets[].files 是落在各任务目录里、被消息引用过的文件；precedents 是同类做完的规划的要点，只作参考，它们的 rules 不抄进这件事。

只输出一个 JSON 对象，不要 markdown 围栏，不要前言后语，不要 tool-call：
{"decision": "continue" | "new" | "resume" | "join", "resume_plan_id": "…或 null", "join_plan_id": "…或 null", "plan": {"kind": "…", "goal": "…", "acceptance": ["…"], "rules": ["…"], "process": ["…"], "progress": {"done": ["…"], "open": ["…"], "blocked": ["…"]}, "status": "active"}, "tickets": [{"id": "已有任务的 id 或 new-1、new-2…", "title": "…", "spec": "…", "status": "todo", "worker": "Bot 名字或 null"}], "message_ticket": "这条消息在说哪个任务的 id 或 new-N，或 null", "checks": [{"id": "已有检查的 id 或 new-1、new-2…", "remove": true, "item": "对应哪条 acceptance", "ticket": "任务 id、new-N 或 null", "kind": "exists" | "contains" | "matches" | "command" | "continuity", "path": "…", "pattern": "…", "negate": false, "command": "…", "cwd": "…", "expect_exit": 0, "expect_stdout": "…", "timeout_sec": 120}]}

策略：
- decision：同一件事的后续、追问、改要求、问进度，都是 continue；明显换了一件不相干的事才 new；用户说回到之前那件、且 recent_plans 里有对得上的，才 resume 并给 resume_plan_id；这句明显在说 elsewhere_plans 里的某件事（说到它的内容、产物、进展、做法，或接着 said_here 往下说），而不是 current_plan，才 join 并给 join_plan_id。current_plan 为 null 时只能 new 或 join。拿不准就 continue。
- plan：在你选中的那个规划的 spec 上改（continue 是 current_plan，join 是 elsewhere_plans 里那件），不要重写没变的部分。goal 写用户要做成的事，用户改了才改；怎么算完成进 acceptance；定下来的做法和分工进 process；progress 按 artifacts、commands 和 trace 更新。progress.open 只写还没做的事；已经交出、只等用户看或验收的不写，谁问过什么、此刻有没有人在做也不写。status 只在这件事明确做完时 done，用户明确说搁置时 parked。
- rules 只收用户自己的话：message、user_lines、messages 里 from 是 user 的话和 answer、rules_user_typed。可以精简，不能加用户没说的意思；提问、催进度、「继续」本身不是规则；回答只是选了下一步先做什么的，写进 process 或 progress。
- Bot 说的决定和给自己定的限制不是规则，也不写进 goal、acceptance 或任务 spec，分三种放：Bot 自己决定的暂停、冻结、不再重试、只做一部分，写进 process 并写明是谁定的，因此停着的写进 progress.blocked，写清等什么能解开；要用户给的东西（授权、密钥、确认花钱）才能往下做的，写进 progress.blocked，写清要用户做什么；做法上的约束（不覆盖原文件、交付放哪个目录），写进 process。
- 用户新说的话和已有规则冲突或盖过它时，改写或删掉那条旧的，不要把新的并列追加：用户说过「只做第一部分」、现在说「第二部分也做」，就改成「第一、第二部分都做」。用户说「继续推进」「不要停下来」「尽可能做好」时，Bot 自己决定的暂停、冻结、不再重试、只做一部分都撤掉，不管写在 rules、process、progress、acceptance 还是任务 spec 里，因此停着的挪回 progress.open，因此搁置的任务改回 todo；等用户给东西的那种，用户给了才撤（「不用考虑金额」撤掉因为花钱停着的）；做法上的约束不撤。
- 叫停：用户叫停（停下、停掉、暂停、先别做、不要再生成……）就把这件事标 parked，rules 里写一句「用户叫停，没说继续之前不再做」。用户说「你没停」「还在进行」「私聊里的没停」「怎么还在做」，是在催 Bot 真的停下，不是让接着做：保持或改成 parked，不要写「接着做完」「不要搁置」这类规则。已经 parked 的事，只有用户明说继续、接着做、恢复，才改回 active；settle 时不要把 parked 改回 active。
- mode 是 message、user_lines_omitted 是 0 时：current_plan 里在用户的话和 rules_user_typed 里都找不到出处的规则、acceptance 里 Bot 自己加的限制（acceptance_user_typed 里的不动），按上面三种挪走；goal 只剩 Bot 眼下推进的一块、比用户要的窄时，按用户的话放回去（goal_user_typed 是 true 的不动）；spec_user_typed 不是 true 的任务 spec 写成了进展流水或禁令的，改回要交出什么。user_lines_omitted 大于 0 时不做这一步。
- join 时看不到那件事的 user_lines：只按这句改它的要点，它已有的规则不挪。
- settle 且 user_spoke 是 false 时：goal、acceptance、rules 原样照抄，已有任务的 spec 不改，规划不改成 parked；只记交出了什么、进展到哪、谁在做、做法和因此卡住的事。改了前面这几项，应用也会退回。
- acceptance 写用户自己能检查的结果，不写「产出某某文档」「给出结论」这种谁写一份就算的话。要做出能用的东西（软件、网站、脚本、工具）时，必须有一条：「有启动方式（一条命令或一个文件），照着能在本机跑起来并走通主流程」。
- tickets：把要交付的东西拆成任务，一个任务是能独立交出的一块，不要把一句话拆成好几个，也不要每条消息都新建。几个人各做一部分、合起来才是一个能用的东西时，另开一个「联调并给出启动方式」的任务，并在 process 里写明最终交付放在哪个目录。已有任务用它的 id 引用（join 时是那件事的任务），只写 id 和变了的字段，例如 {"id": "…", "status": "review"}；没变的任务不用列，不列的不动。新任务用 new-1、new-2，要写 title。不能删任务，只能改成 done 或 parked。spec 写这个任务要交出什么、怎么算完成；不写进展（进 progress），也不写 Bot 给自己定的禁令（进 process）。交付物没变就不改 spec；spec_user_typed 是 true 的，除非用户这句就在改它，不改。
- 依据：Bot 说「已完成」「测试通过」「验收通过」不算依据。任务标 review 要有这个任务交出的文件；标 done 要有文件，而且说跑过、测过的要在 commands 里找得到（退出码 0）。只有文档、报告、没有能跑的东西，不能把「做出能用的东西」的任务标 done。有人交出了属于某任务的文件，至少标 review，并写上 worker。
- checks（可选，缺省当空数组）：current_plan.checks 是应用自己跑出来的证据，比 Bot 自称「测试通过」「验收通过」更可信，也比 commands 里的命令记录更可信。只要有一条 checks 是 fail，这个规划就不能标 done，它对应的那个任务也不能标 done（已经是 done 的这次改回 doing）；blocked 或 error 既不算通过也不算失败，算卡住，写进 progress.blocked，不要据此判定完成或失败。只在确定的情况下才提议新检查（id 写 new-1、new-2…），一条 acceptance 最多配 0～2 条：exists/contains/matches 的 path 要能在 files、artifacts 或规则里找到出处；command 必须原样抄自 since_last_revision.commands 里退出码是 0 的那条，连 cwd 一起抄，不能凭空编；也可以是用户自己在消息里写下的命令或文件路径。交付物是由几个 Bot 分头做出的几部分拼起来的（章节、镜头、图片、幻灯片……），而 acceptance 或 rules 里提到「连贯」「衔接」「风格一致」「前后一致」这类跨部分的要求时，可以提一条 continuity（衔接一致）：path 是那份交付物，或者是能匹配到各部分的通配（同样要能在 files、artifacts 或规则里找到出处），或者 command 是能按顺序列出各部分的命令（同样必须抄自 commands 里跑成功过的那条），二者至少一个；不要凭空写一个从没出现过的文件或命令。代码要联调，仍然按前面「联调并给出启动方式」的做法开一条 command 检查，不用 continuity。只能新增，或者按 id 改动、删除 source 是 organizer 的检查（remove: true 是删除，其余字段不写就是不变）；source 是 user 的检查不要碰，也不要用同样的定义再开一条新的。这次答案如果新增或改了 checks，这次就不要把规划或它对应的任务标成 done——等它跑出结果再决定。改写了某条 acceptance 的措辞、而这条正好挂着检查，把这条检查的 item 也一起改成新措辞。
- plan.status 标 done 时，每个任务也要在这次答案里标成 done 或 parked；还有待做或进行中的任务，这件事就没做完。
- message_ticket：mode 是 message 时，这条消息在说哪个任务；一句泛泛的话或问进度就 null。settle 时 null。
- 一切都写短：goal 一句话，列表每条一句。`;

export const ORGANIZER_MESSAGES_LIMIT = 30;
export const ORGANIZER_BODY_LIMIT = 600;
export const ORGANIZER_TICKETS_LIMIT = 40;
export const ORGANIZER_ARTIFACTS_LIMIT = 30;
export const ORGANIZER_TRACE_LIMIT = 12;
export const ORGANIZER_RECENT_PLANS = 8;
/** Runs since the last version the organizer sees: enough to tell a test run from a claim. */
export const ORGANIZER_RUNS_LIMIT = 40;
/** Files listed under each ticket, newest cited first. */
export const ORGANIZER_TICKET_FILES = 8;
const RUN_COMMAND_PREVIEW = 160;
export const ORGANIZER_KINDS_LIMIT = 50;
const TICKET_SPEC_PREVIEW = 300;
/** Code points of a check's last run's output the payload keeps — a failure's tail, not its head. */
const ORGANIZER_CHECK_OUTPUT_PREVIEW = 300;
/** Entries a `checks` answer may hold; matches the store's own cap on active checks per plan. */
const ORGANIZER_CHECKS_PAYLOAD_MAX = CHECKS_MAX;

/** The last `limit` code points, marked when something was cut — a run's tail explains a failure, not its head. */
function tailCodePoints(text: string, limit: number): string {
  const chars = [...text];
  return chars.length > limit ? `…${chars.slice(-(limit - 1)).join("")}` : text;
}

/**
 * Your lines about the plan the organizer reads beyond its window of recent ones: the rules are
 * held against them. Lines, code points per line, and code points of text and question together;
 * with the dates and keys around them the worst case is about 6k characters.
 */
export const ORGANIZER_USER_LINES = 40;
export const ORGANIZER_USER_LINE_MAX = 300;
export const ORGANIZER_USER_LINES_BUDGET = 4000;
/** The first few you said are kept when the rest has to be cut: the job's opening terms. */
export const ORGANIZER_USER_LINES_EARLIEST = 4;
/** Your newest lines read before repeats and caps are applied. */
export const ORGANIZER_USER_LINES_SCAN = 200;
/** As much of the question behind an answer of yours as the organizer sees. */
const ASKED_PREVIEW = 120;

/** A ticket's description as the organizer is shown it: one line, clipped. */
export function ticketSpecPreview(spec: string): string {
  return clipBody(spec, TICKET_SPEC_PREVIEW).text;
}

/** One thing you said about the plan, as the organizer reads it: a line you sent, or your answer and the question it answers. */
export type OrganizerUserLine = { via: "message" | "answer"; at: string; text: string; asked?: string; truncated?: true };

export type OrganizerPayload = {
  mode: "message" | "settle";
  session: { id: string; kind: "direct" | "group"; name: string | null; members: string[] };
  message: { id: string; author: string; body: string; attachments: string[]; truncated?: true } | null;
  current_plan: {
    id: string;
    kind: string | null;
    status: PlanStatus;
    brief: string | null;
    revision: number;
    spec: PlanSpec | null;
    tickets: Array<{
      id: string;
      seq: number;
      title: string;
      status: TicketStatus;
      worker: string | null;
      spec: string;
      /** You wrote this description yourself on the board, and nobody has changed it since. */
      spec_user_typed?: true;
      artifacts: number;
      /** Cited files filed under it or sitting in its folder, newest first. */
      files: string[];
    }>;
    /** This plan's active acceptance checks — the app's own evidence, ahead of a Bot's own say-so. */
    checks: Array<{
      id: string;
      item: string;
      kind: AcceptanceCheckKind;
      /** One line describing what it verifies, e.g. "文件存在：report.md". */
      what: string;
      source: "organizer" | "user";
      ticket: number | null;
      /** Its most recent finished run; null when it has never run. */
      last: { outcome: "pass" | "fail" | "blocked" | "error"; detail: string; at: string; output: string | null } | null;
    }>;
    /**
     * What you said about the plan that is not among the lines since the last version, oldest
     * first: the rules rest on these. Bounded; the middle goes first.
     */
    user_lines: OrganizerUserLine[];
    user_lines_omitted: number;
    /** Whether the goal as it stands is one you typed on the board yourself. */
    goal_user_typed: boolean;
    /** The plan's Done when lines you typed on the board yourself. */
    acceptance_user_typed: string[];
    /** The plan's rules you typed on the board yourself. */
    rules_user_typed: string[];
  } | null;
  recent_plans: Array<{ id: string; goal: string; kind: string | null; status: PlanStatus; last_activity_at: string }>;
  /** Jobs the Bots here are on in other sessions: a line here can be about one of them. Message runs only. */
  elsewhere_plans: Array<{
    id: string;
    title: string;
    /** Where it was opened; null once that session is gone. */
    home: string | null;
    /** Who is working on it right now, and where. */
    working: string[];
    status: PlanStatus;
    brief: string | null;
    spec: PlanSpec | null;
    tickets: Array<{ id: string; seq: number; title: string; status: TicketStatus; worker: string | null }>;
    /** The last lines in this session filed under it, oldest first. */
    said_here: Array<{ author: string; body: string }>;
  }>;
  kinds: string[];
  since_last_revision: {
    messages: Array<{
      id: string;
      author: string;
      /** Who said it: you, a Bot, or the app. A Bot's line is never a rule. */
      from: "user" | "bot" | "app";
      kind: string;
      body: string;
      /** Your answer to a Bot's question, apart from the question: the answer is yours. */
      answer?: string;
      ticket_id: string | null;
      created_at: string;
      truncated?: true;
    }>;
    /** Whether you said anything, or answered a question, since the last version. Always true on a message run. */
    user_spoke: boolean;
    artifacts: Array<{ path: string; by: string; ticket_id: string | null; cited_at: string }>;
    trace: string[];
    /** What the plan's turns actually ran, oldest first: who, under which ticket, where, and how it exited. */
    commands: Array<{ by: string; ticket: number | null; command: string; cwd: string | null; exit_code: number | null; ok: boolean; error?: string }>;
  };
  precedents: Array<{ goal: string; process: string[]; rules: string[]; outcome: string[] }>;
};

function nameOf(store: Store, id: string): string {
  if (id === USER_MEMBER) return "user";
  try {
    return store.getBot(id).name;
  } catch {
    return id;
  }
}

function clipBody(body: string, limit: number): { text: string; truncated: boolean } {
  const clipped = takeCodePoints(body.replace(/\s+/g, " ").trim(), limit);
  return { text: clipped.text, truncated: clipped.truncated };
}

/** Who said a line, as the organizer is told it: rules are only taken from yours. */
function speakerOf(row: { kind: string; author: string }): "user" | "bot" | "app" {
  if (row.kind === "system") return "app";
  return row.kind === "user" && row.author === USER_MEMBER ? "user" : "bot";
}

/**
 * Your lines about the plan beyond the ones since the last version, bounded: a line said again
 * counts once, where it was said last; each is clipped; and past the caps the first few you said
 * are kept with the newest, and the middle is counted instead of shown.
 */
function userLinesOf(
  store: Store,
  planId: string,
  shown: ReadonlySet<string>,
): Pick<NonNullable<OrganizerPayload["current_plan"]>, "user_lines" | "user_lines_omitted"> {
  const { lines, total } = store.taskUserLines(planId, {
    earliest: ORGANIZER_USER_LINES_EARLIEST,
    newest: ORGANIZER_USER_LINES_SCAN,
    bodyMax: ORGANIZER_USER_LINE_MAX + 1,
  });
  const candidates = lines.filter((line) => !shown.has(line.id) && line.body.trim());
  // An answer means what it means under its question, so it repeats only under the same one.
  const keyOf = (line: (typeof candidates)[number]) => `${line.body.replace(/\s+/g, " ").trim()}\u0000${line.asked ?? ""}`;
  const last = new Map(candidates.map((line, index) => [keyOf(line), index]));
  const kept: OrganizerUserLine[] = [];
  candidates.forEach((line, index) => {
    if (last.get(keyOf(line)) !== index) return;
    const text = clipBody(line.body, ORGANIZER_USER_LINE_MAX);
    const item: OrganizerUserLine = { via: line.via, at: line.at, text: text.text };
    if (line.asked !== null) item.asked = clipBody(line.asked, ASKED_PREVIEW).text;
    // A body the query already cut is clipped even when collapsing its spaces brought it under the cap.
    if (text.truncated || [...line.body].length > ORGANIZER_USER_LINE_MAX) item.truncated = true;
    kept.push(item);
  });
  const cost = (line: OrganizerUserLine) => [...line.text].length + [...(line.asked ?? "")].length;
  let chosen = kept;
  if (kept.length > ORGANIZER_USER_LINES || kept.reduce((sum, line) => sum + cost(line), 0) > ORGANIZER_USER_LINES_BUDGET) {
    const head = kept.slice(0, ORGANIZER_USER_LINES_EARLIEST);
    let spent = head.reduce((sum, line) => sum + cost(line), 0);
    const tail: OrganizerUserLine[] = [];
    for (let index = kept.length - 1; index >= head.length; index -= 1) {
      const line = kept[index]!;
      if (head.length + tail.length >= ORGANIZER_USER_LINES || spent + cost(line) > ORGANIZER_USER_LINES_BUDGET) break;
      spent += cost(line);
      tail.unshift(line);
    }
    chosen = [...head, ...tail];
  }
  return { user_lines: chosen, user_lines_omitted: total - lines.length + (kept.length - chosen.length) };
}

/** What the organizer reads. Everything is capped so a long plan costs a bounded call. */
export function organizerPayload(
  store: Store,
  input: {
    mode: "message" | "settle";
    sessionId: string;
    message: Message | null;
    current: Task | null;
    trace?: string[];
    /** A settle's reading, taken before the call, of whether you said anything since the last version. */
    userSpoke?: boolean;
  },
): OrganizerPayload {
  const session = store.getSession(input.sessionId);
  const members = store
    .presentParticipants(input.sessionId)
    .map((row) => nameOf(store, row.member))
    .filter((name) => name !== "user");
  const current = input.current;
  const since = current ? store.lastSpecRevisionAt(current.id) : "";
  const messages = current
    ? store.taskMessagesSince(current.id, since, ORGANIZER_MESSAGES_LIMIT).map((row) => {
        const body = clipBody(row.body, ORGANIZER_BODY_LIMIT);
        const answer = row.answer !== null ? clipBody(row.answer, ORGANIZER_BODY_LIMIT) : null;
        const item: OrganizerPayload["since_last_revision"]["messages"][number] = {
          id: row.id,
          author: nameOf(store, row.author),
          from: speakerOf(row),
          kind: row.kind,
          body: body.text,
          ...(answer ? { answer: answer.text } : {}),
          ticket_id: row.ticket_id,
          created_at: row.created_at,
        };
        if (body.truncated || answer?.truncated) item.truncated = true;
        return item;
      })
    : [];
  const artifacts = current
    ? store.taskArtifactsSince(current.id, since, ORGANIZER_ARTIFACTS_LIMIT).map((row) => ({
        path: row.path,
        by: nameOf(store, row.author),
        ticket_id: row.ticket_id,
        cited_at: row.cited_at,
      }))
    : [];
  const artifactCounts = new Map<string, number>();
  const ticketFiles = new Map<string, string[]>();
  const currentTickets = current ? store.listTickets(current.id) : [];
  if (current) {
    for (const row of store.taskArtifacts(current.id, () => true, 500)) {
      if (row.ticket_id) artifactCounts.set(row.ticket_id, (artifactCounts.get(row.ticket_id) ?? 0) + 1);
      // A file belongs to a ticket by the message that cited it, or by the folder it sits in: a
      // handoff can land a turn on another ticket while it writes where the work really is.
      for (const ticket of currentTickets) {
        if (row.ticket_id !== ticket.id && !row.path.startsWith(`${ticket.dir}/`)) continue;
        const files = ticketFiles.get(ticket.id) ?? [];
        if (files.length < ORGANIZER_TICKET_FILES && !files.includes(row.path)) files.push(row.path);
        ticketFiles.set(ticket.id, files);
      }
    }
  }
  const seqOf = new Map(currentTickets.map((ticket) => [ticket.id, ticket.seq]));
  const commands: OrganizerPayload["since_last_revision"]["commands"] = current
    ? store.taskRunsSince(current.id, since, ORGANIZER_RUNS_LIMIT).map((run) => {
        const item: OrganizerPayload["since_last_revision"]["commands"][number] = {
          by: nameOf(store, run.bot_id),
          ticket: run.ticket_id ? (seqOf.get(run.ticket_id) ?? null) : null,
          command: clipBody(run.command, RUN_COMMAND_PREVIEW).text,
          cwd: run.cwd,
          exit_code: run.exit_code,
          ok: run.ok === 1,
        };
        if (run.error) item.error = clipBody(run.error, 120).text;
        return item;
      })
    : [];
  const spec = current ? parsePlanSpec(current.spec) : null;
  const typed = current ? store.userWrittenSpec(current.id) : { goal: false, acceptance: [], rules: [], ticketIds: [] };
  const precedents: OrganizerPayload["precedents"] = [];
  if (spec?.kind && current) {
    for (const earlier of store.precedentTasks(spec.kind, current.id, 3)) {
      const done = parsePlanSpec(earlier.spec);
      if (done) precedents.push({ goal: done.goal, process: done.process, rules: done.rules, outcome: done.progress.done });
    }
  }
  // A line here can be about a job the Bots here are doing somewhere else; a settle files one plan's own work.
  const elsewhere = input.mode === "message" ? store.elsewherePlans(input.sessionId) : [];
  let message: OrganizerPayload["message"] = null;
  if (input.message) {
    const body = clipBody(input.message.body, ORGANIZER_BODY_LIMIT * 2);
    message = {
      id: input.message.id,
      author: nameOf(store, input.message.author),
      body: body.text,
      attachments: input.message.attachments.map((att) => att.workspace_relpath),
    };
    if (body.truncated) message.truncated = true;
  }
  return {
    mode: input.mode,
    session: { id: session.id, kind: session.kind, name: session.name, members },
    message,
    current_plan: current
      ? {
          id: current.id,
          kind: current.kind,
          status: current.status,
          brief: current.brief ? clipBody(current.brief, ORGANIZER_BODY_LIMIT).text : null,
          revision: store.currentRevision(current.id),
          spec,
          goal_user_typed: typed.goal,
          acceptance_user_typed: typed.acceptance,
          rules_user_typed: typed.rules,
          tickets: currentTickets
            .slice(0, ORGANIZER_TICKETS_LIMIT)
            .map((ticket) => ({
              id: ticket.id,
              seq: ticket.seq,
              title: ticket.title,
              status: ticket.status,
              worker: ticket.worker ? nameOf(store, ticket.worker) : null,
              spec: ticketSpecPreview(ticket.spec),
              ...(typed.ticketIds.includes(ticket.id) ? { spec_user_typed: true as const } : {}),
              artifacts: artifactCounts.get(ticket.id) ?? 0,
              files: ticketFiles.get(ticket.id) ?? [],
            })),
          checks: store.listChecks(current.id)
            .slice(0, CHECKS_MAX)
            .map((check) => ({
              id: check.id,
              item: check.item,
              kind: check.kind,
              what: describeCheck(check, "zh"),
              source: check.source,
              ticket: check.ticket_id ? (seqOf.get(check.ticket_id) ?? null) : null,
              last: check.last_run
                ? {
                    outcome: check.last_run.outcome ?? "error",
                    detail: check.last_run.detail,
                    at: check.last_run.finished_at ?? check.last_run.started_at,
                    output: check.last_run.output ? tailCodePoints(check.last_run.output, ORGANIZER_CHECK_OUTPUT_PREVIEW) : null,
                  }
                : null,
            })),
          // Each line is shown once: the one this run files, and those since the last version, are already there.
          ...userLinesOf(store, current.id, new Set([...messages.map((row) => row.id), ...(input.message ? [input.message.id] : [])])),
        }
      : null,
    recent_plans: store
      .sessionRecentTasks(input.sessionId, ORGANIZER_RECENT_PLANS)
      .filter((task) => !elsewhere.some((plan) => plan.id === task.id))
      .map((task) => {
        const earlier = parsePlanSpec(task.spec);
        return {
          id: task.id,
          goal: earlier?.goal ?? (task.brief ? clipBody(task.brief, 200).text : task.title),
          kind: task.kind,
          status: task.status,
          last_activity_at: store.taskLastActivityAt(task.id),
        };
      }),
    elsewhere_plans: elsewhere.map((plan) => elsewherePlan(store, input.sessionId, plan)),
    kinds: store.distinctTaskKinds(ORGANIZER_KINDS_LIMIT),
    since_last_revision: {
      messages,
      // A message run is you speaking; a settle says whether you did, as the app will hold it to.
      user_spoke: input.mode === "message" || (input.userSpoke ?? false),
      artifacts,
      trace: (input.trace ?? []).slice(-ORGANIZER_TRACE_LIMIT),
      commands,
    },
    precedents,
  };
}

/** Lines of this session already filed under a plan elsewhere that the organizer reads. */
export const ORGANIZER_SAID_HERE = 3;

/**
 * A job the Bots here are on elsewhere, whole enough to be revised: a line filed there rewrites its
 * spec the way a continue rewrites the current plan's, so the organizer needs the spec it builds on.
 */
function elsewherePlan(store: Store, sessionId: string, plan: Task): OrganizerPayload["elsewhere_plans"][number] {
  const locale = store.settingsCached().locale;
  const working = store
    .listLiveTurns()
    .filter((turn) => turn.task_id === plan.id)
    .map((turn) => `${nameOf(store, turn.bot_id)}（${sessionLabel(store, turn.session_id, null, locale) ?? "?"}）`);
  const said_here = store
    .listMainMessages(sessionId, 40)
    .filter((row) => row.task_id === plan.id)
    .slice(0, ORGANIZER_SAID_HERE)
    .reverse()
    .map((row) => ({ author: nameOf(store, row.author), body: clipBody(row.body, 200).text }));
  return {
    id: plan.id,
    title: plan.title,
    home: plan.session_id ? sessionLabel(store, plan.session_id, null, locale) : null,
    working: [...new Set(working)],
    status: plan.status,
    brief: plan.brief ? clipBody(plan.brief, ORGANIZER_BODY_LIMIT).text : null,
    spec: parsePlanSpec(plan.spec),
    tickets: store
      .listTickets(plan.id)
      .slice(0, ORGANIZER_TICKETS_LIMIT)
      .map((ticket) => ({
        id: ticket.id,
        seq: ticket.seq,
        title: ticket.title,
        status: ticket.status,
        worker: ticket.worker ? nameOf(store, ticket.worker) : null,
      })),
    said_here,
  };
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const NEW_TICKET = /^new-\d+$/;

/**
 * The optional top-level `checks` array of an organizer answer: proposed, edited or removed
 * acceptance checks. Pure and lossy on purpose — malformed entries are dropped, not fixed up.
 * `existing` is this plan's own check ids as the payload showed them; an id the model was never
 * shown (hallucinated, or another plan's) is dropped here, the same way an unlisted ticket id is.
 * Everything else the store's own rules cover: only an `organizer` check may be touched by id, a
 * command needs evidence in this plan (`commandSeenInPlan`), and the caps on how many are active
 * and how many a single run may add.
 */
export function parseOrganizerChecks(raw: unknown, existing: ReadonlySet<string>): OrganizerCheckInput[] {
  if (!Array.isArray(raw)) return [];
  const out: OrganizerCheckInput[] = [];
  for (const entry of raw) {
    if (out.length >= ORGANIZER_CHECKS_PAYLOAD_MAX) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const opening = NEW_TICKET.test(id);
    if (!opening && !(ULID.test(id) && existing.has(id))) continue;
    if (row.remove === true) {
      if (!opening) out.push({ id, remove: true });
      continue;
    }
    const check: OrganizerCheckInput = { id };
    if (typeof row.item === "string") check.item = row.item.replace(/\s+/g, " ").trim();
    if (typeof row.kind === "string" && (CHECK_KINDS as readonly string[]).includes(row.kind)) {
      check.kind = row.kind as AcceptanceCheckKind;
    }
    if (typeof row.path === "string") check.path = row.path;
    if (typeof row.pattern === "string") check.pattern = row.pattern;
    if (typeof row.negate === "boolean") check.negate = row.negate;
    if (typeof row.command === "string") check.command = row.command;
    if (typeof row.cwd === "string") check.cwd = row.cwd;
    if (typeof row.expect_exit === "number" && Number.isFinite(row.expect_exit)) check.expect_exit = row.expect_exit;
    if (typeof row.expect_stdout === "string") check.expect_stdout = row.expect_stdout;
    if (typeof row.timeout_sec === "number" && Number.isFinite(row.timeout_sec)) check.timeout_sec = row.timeout_sec;
    if (row.ticket === null) check.ticket = null;
    else if (typeof row.ticket === "string") check.ticket = row.ticket.trim();
    out.push(check);
  }
  return out;
}

/**
 * The organizer's answer, checked field by field. Null means "not usable": the engine then leaves
 * the plan as it was. Never throws.
 */
export function parseOrganizerResult(
  raw: string,
  ctx: {
    mode: "message" | "settle";
    recentPlanIds: ReadonlySet<string>;
    /** Plans the Bots here are on elsewhere; a join names one of them. */
    elsewherePlanIds?: ReadonlySet<string>;
    roster: ReadonlyArray<{ id: string; name: string }>;
    /** This plan's own check ids, as shown in the payload; a `checks` entry naming any other id is dropped. */
    existingCheckIds?: ReadonlySet<string>;
  },
): OrganizerResult | null {
  const parsed = extractJsonObject(raw);
  if (!parsed) return null;
  const spec = normalizePlanSpec(parsed.plan);
  if (!spec) return null;
  let decision: OrganizerResult["decision"] = "continue";
  let resumePlanId: string | null = null;
  let joinPlanId: string | null = null;
  const decisionRaw = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  // What the answer named, before the candidate-set checks below can downgrade it — but only where
  // it bears on the decision it wrote: a resume target beside `resume`, a join target beside
  // `join`, a message ticket on a message filing. The format asks for every field each time
  // (「…或 null」), and a stray id beside `continue` kept here would put this run on that plan's
  // debug trail as if the answer had asked for it.
  const named = (value: unknown): string | null => (typeof value === "string" ? value.trim() || null : null);
  const rawResumePlanId = ctx.mode === "message" && decisionRaw === "resume" ? named(parsed.resume_plan_id) : null;
  const rawJoinPlanId = ctx.mode === "message" && decisionRaw === "join" ? named(parsed.join_plan_id) : null;
  const rawMessageTicket = ctx.mode === "message" ? named(parsed.message_ticket) : null;
  // Why the decision that applies is not the one the answer wrote; null when it is.
  let downgradeReason: string | null = null;
  if (ctx.mode === "message") {
    if (decisionRaw === "new") decision = "new";
    else if (decisionRaw === "resume") {
      if (rawResumePlanId && ctx.recentPlanIds.has(rawResumePlanId)) {
        decision = "resume";
        resumePlanId = rawResumePlanId;
      } else {
        // A target the payload offered can stop qualifying by the time the call returns and this set
        // is re-read. The decision reads continue only because it has to be one of the four: the
        // organizer files nothing for such an answer (ADR 0040 P1), and the reason says why. A
        // target that is the session's current plan (never a candidate) is filed as that continue.
        downgradeReason = rawResumePlanId
          ? `named resume target ${rawResumePlanId} is not (or no longer) a recent plan of this session`
          : "resume named no resume_plan_id";
      }
    } else if (decisionRaw === "join") {
      if (rawJoinPlanId && ctx.elsewherePlanIds?.has(rawJoinPlanId)) {
        decision = "join";
        joinPlanId = rawJoinPlanId;
      } else {
        downgradeReason = rawJoinPlanId
          ? `named join target ${rawJoinPlanId} is not (or no longer) a job the Bots here are on elsewhere`
          : "join named no join_plan_id";
      }
    } else if (decisionRaw && decisionRaw !== "continue") {
      downgradeReason = `decision "${decisionRaw}" is not one of continue, new, resume, join; fell back to continue`;
    }
  } else if (decisionRaw && decisionRaw !== "continue") {
    downgradeReason = `a settle only continues; decision "${decisionRaw}" was ignored`;
  }
  const byName = new Map(ctx.roster.map((bot) => [bot.name.trim().toLowerCase(), bot.id]));
  const tickets: OrganizerTicketInput[] = [];
  if (Array.isArray(parsed.tickets)) {
    for (const entry of parsed.tickets) {
      if (tickets.length >= ORGANIZER_TICKETS_LIMIT) break;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (!ULID.test(id) && !NEW_TICKET.test(id)) continue;
      const opening = NEW_TICKET.test(id);
      const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
      // A new ticket needs a name. An existing one is referenced by id with only what changed, so
      // a missing title, status or worker there means "as it was" — not blank, todo or nobody.
      if (opening && !title) continue;
      const workerName = typeof row.worker === "string" ? row.worker.trim().toLowerCase() : "";
      const worker = workerName ? (byName.get(workerName) ?? null) : null;
      const ticket: OrganizerTicketInput = { id, spec: typeof row.spec === "string" ? row.spec.trim() : "" };
      if (title) ticket.title = title;
      if (isTicketStatus(row.status)) ticket.status = row.status;
      else if (opening) ticket.status = "todo";
      if (worker || opening) ticket.worker = worker;
      tickets.push(ticket);
    }
  }
  let messageTicket: string | null = null;
  if (ctx.mode === "message" && typeof parsed.message_ticket === "string") {
    const id = parsed.message_ticket.trim();
    if (ULID.test(id) || NEW_TICKET.test(id)) messageTicket = id;
  }
  const checks = parseOrganizerChecks(parsed.checks, ctx.existingCheckIds ?? new Set());
  return {
    decision,
    resumePlanId,
    joinPlanId,
    spec,
    tickets,
    messageTicket,
    checks,
    raw: { decision: decisionRaw, resumePlanId: rawResumePlanId, joinPlanId: rawJoinPlanId, messageTicket: rawMessageTicket },
    downgradeReason,
  };
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * What a settle may change when you have said nothing since the version it builds on: it files the
 * handover. With no word of yours to go on, a changed goal, rule or Done when, or a rewritten
 * ticket spec, is a Bot's decision written up as yours — a freeze a coordinator put on itself
 * becoming a rule every Bot then obeys, a ticket's description turning into a list of what not to
 * do. So those stay exactly as they were (a plan with no spec yet gets no rules), the plan is not
 * parked, and an existing ticket keeps a description it already has; process, progress, a plan
 * called done, ticket status and worker, and new tickets still land. `held` names what was kept,
 * for the log.
 */
export function holdSettle(
  result: OrganizerResult,
  ctx: { before: PlanSpec | null; tickets: readonly Ticket[]; userSpoke: boolean },
): { result: OrganizerResult; held: string[] } {
  if (ctx.userSpoke) return { result, held: [] };
  const before = ctx.before;
  const held: string[] = [];
  const spec: PlanSpec = {
    ...result.spec,
    kind: before?.kind ?? result.spec.kind,
    goal: before?.goal ?? result.spec.goal,
    acceptance: before ? before.acceptance : result.spec.acceptance,
    rules: before ? before.rules : [],
    status: result.spec.status === "parked" && before?.status !== "parked" ? (before?.status ?? "active") : result.spec.status,
  };
  if (spec.goal !== result.spec.goal) held.push("kept the goal as it was");
  if (!sameLines(spec.acceptance, result.spec.acceptance)) held.push("kept Done when as it was");
  if (!sameLines(spec.rules, result.spec.rules)) held.push("kept the rules as they were");
  if (spec.status !== result.spec.status) held.push("did not park the plan");
  const byId = new Map(ctx.tickets.map((ticket) => [ticket.id, ticket]));
  const byTitle = new Map(ctx.tickets.map((ticket) => [titleKey(ticket.title), ticket]));
  const tickets = result.tickets.map((entry) => {
    // Matched the way the store will match it: by id, or a new-N named like an existing ticket.
    const known = byId.get(entry.id) ?? (NEW_TICKET.test(entry.id) && entry.title ? byTitle.get(titleKey(entry.title)) : undefined);
    // A ticket renamed in this answer is found by its new title too, as the store will find it.
    if (known && entry.title) byTitle.set(titleKey(entry.title), known);
    if (!known?.spec.trim() || !entry.spec || entry.spec === known.spec) return entry;
    // Echoing the one-line preview it was shown is no rewrite, but it would still cut the spec short.
    const echo = entry.spec === ticketSpecPreview(known.spec) || entry.spec.replace(/\s+/g, " ") === known.spec.replace(/\s+/g, " ").trim();
    if (!echo) held.push(`kept ticket ${String(known.seq).padStart(2, "0")}'s spec`);
    return { ...entry, spec: "" };
  });
  return { result: { ...result, spec, tickets }, held };
}
