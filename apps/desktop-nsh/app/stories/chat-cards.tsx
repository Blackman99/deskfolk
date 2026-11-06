/**
 * The cards inside a conversation's transcript: a Bot's question, an approval (with the prompt and
 * interface diffs), a job's question, the stop buttons, a turn's commands and steps, the delegation
 * records and the plan Claude Code asks you to approve. One part at a time (the buttons on top), each
 * card fed realistic data built from the protocol's types, its actions recorded in a line under it.
 */
import { Scroll, signal, Text, View } from "nsh";
import type {
  AgentRunApproval,
  AgentRunTask,
  Approval,
  Bot,
  ControlOffer,
  DelegationView,
  Hold,
  Message,
  MessageControl,
  Turn,
  WorkQuestionControl,
} from "@real-bot/protocol";
import type { TranscriptGroup } from "../src/m/chat/chat-view.ts";
import type { CommandRow } from "../src/m/chat/command-activity.ts";
import type { TranscriptStage } from "../src/m/chat/transcript-stage.ts";
import type { StepRow } from "../src/m/chat/turn-activity.ts";
import { runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { AskCard } from "../src/ui/chat/AskCard";
import { CommandActivity } from "../src/ui/chat/CommandActivity";
import { ControlActions } from "../src/ui/chat/ControlActions";
import { DelegationRecords } from "../src/ui/chat/DelegationRecords";
import { NewPlanActions } from "../src/ui/chat/NewPlanActions";
import { ProjectPlanCard } from "../src/ui/chat/ProjectPlanCard";
import { ProjectTaskSteps } from "../src/ui/chat/ProjectTaskSteps";
import { TranscriptApproval } from "../src/ui/chat/TranscriptApproval";
import { TranscriptAsk } from "../src/ui/chat/TranscriptAsk";
import { TurnStepList } from "../src/ui/chat/TurnStepList";
import { WorkQuestionCard } from "../src/ui/chat/WorkQuestionCard";

const NOW = "2026-10-20T09:30:00.000Z";
const WRITER = { id: "bot-writer", name: "Writer", avatar: null } as unknown as Bot;
const EDITOR = { id: "bot-editor", name: "Editor", avatar: null } as unknown as Bot;

function message(over: Partial<Message>): Message {
  return {
    id: "msg",
    session_id: "sess-story",
    turn_id: null,
    parent_id: null,
    kind: "bot",
    author: WRITER.id,
    body: "",
    source_turn_id: null,
    created_at: NOW,
    attachments: [],
    reactions: [],
    ...over,
  } as Message;
}

function group(msg: Message, kind: TranscriptGroup["kind"]): TranscriptGroup {
  return { id: msg.id, kind, author: msg.author, created_at: msg.created_at, items: [{ type: "message", message: msg }] } as unknown as TranscriptGroup;
}

// A card of each kind of request a Bot can put to you.
const PROMPT_BODY = [
  "改内置提示词：系统指令 · 中文",
  "理由：交付没有附命令输出",
  "影响：所有 Bot 的每一轮",
  "@@ 第 1 处 · 在「说做过的必须真做过：」之后加",
  ...Array.from({ length: 8 }, (_, n) => `- 旧的第 ${n + 1} 行`),
  ...Array.from({ length: 8 }, (_, n) => `+ 新的第 ${n + 1} 行`),
  "@@ 第 2 处 · 改写结尾",
  "- 结尾旧句",
  "+ 结尾新句",
].join("\n");
const SHORT_PROMPT_BODY = ["改内置提示词：系统指令 · 中文", "理由：交付没有附命令输出", "@@ 第 1 处 · 在「说做过的必须真做过：」之后加", "+ 附上你依据的命令输出。"].join("\n");
const INTERFACE_BODY = ["改界面", "理由：太亮了", "- 专注模式 开", "- 侧栏更窄", "@@patch", '{"behaviour":{"focus_mode":true}}'].join("\n");

function approval(id: string, messageId: string, status: Approval["status"], over: Partial<Approval> = {}): Approval {
  return {
    id,
    turn_id: "turn-approvals",
    message_id: messageId,
    status,
    kind_key: "fs.write",
    summary: null,
    target: null,
    created_at: NOW,
    resolved_at: status === "pending" ? null : NOW,
    requires_api_key: false,
    ...over,
  };
}

const MESSAGES = {
  ask: message({ id: "ask-1", kind: "ask", turn_id: "turn-ask", body: "报告要哪些部分？", ask: { options: [{ label: "摘要（推荐）", description: "开头一段" }, { label: "数据" }, { label: "风险" }], multi_select: true } }),
  askOne: message({ id: "ask-2", kind: "ask", turn_id: "turn-ask-2", body: "用哪一版封面？", ask: { options: [{ label: "A 版" }, { label: "B 版" }], multi_select: false } }),
  askDone: message({
    id: "ask-3",
    kind: "ask",
    turn_id: "turn-gone",
    body: "要不要加英文字幕？",
    ask: { options: [{ label: "要" }, { label: "不要" }], multi_select: false },
    ask_answer: { selected: ["要"], custom: "先做中文，再补英文。", answered_at: NOW },
  } as Partial<Message>),
  askEnded: message({ id: "ask-4", kind: "ask", turn_id: "turn-gone", body: "这一版的标题？", ask: { options: [], multi_select: false } }),
  key: message({ id: "appr-key", kind: "approval", body: "新增模型端点 Studio（https://studio.example/v1）" }),
  plain: message({ id: "appr-plain", kind: "approval", body: "写入 outline/ep-12.md" }),
  prompt: message({ id: "appr-prompt", kind: "approval", body: PROMPT_BODY }),
  promptAllowed: message({ id: "appr-prompt-done", kind: "approval", body: SHORT_PROMPT_BODY }),
  ui: message({ id: "appr-ui", kind: "approval", body: INTERFACE_BODY }),
  denied: message({ id: "appr-denied", kind: "approval", body: "删除 drafts/old.md" }),
};

const TURNS = [
  { id: "turn-ask", status: "waiting_ask", pending_ask_id: "ask-1" },
  { id: "turn-ask-2", status: "waiting_ask", pending_ask_id: "ask-2" },
] as unknown as Turn[];

const APPROVALS: Approval[] = [
  approval("a-key", "appr-key", "pending", { kind_key: "endpoint-add", requires_api_key: true, target: "Studio" }),
  approval("a-plain", "appr-plain", "pending"),
  approval("a-prompt", "appr-prompt", "pending", { kind_key: "prompt-edit", target: "turn.system:zh" }),
  approval("a-prompt-done", "appr-prompt-done", "allowed_once", { kind_key: "prompt-edit", target: "turn.system:zh" }),
  approval("a-ui", "appr-ui", "pending", { kind_key: "ui-edit" }),
  approval("a-denied", "appr-denied", "denied"),
];

/** What a transcript row reads from its stage, with the keys typed so far kept in signals as the stage keeps them. */
function makeStage(): TranscriptStage {
  const keys = signal<Record<string, string>>({});
  const errors = signal<Record<string, boolean>>({});
  const submitted = signal("—");
  const stage = {
    snapshot: { turns: TURNS, approvals: APPROVALS, interface: { recent: [] } },
    view: null,
    selected: null,
    botsById: new Map([[WRITER.id, WRITER], [EDITOR.id, EDITOR]]),
    sidesSayWho: false,
    focus: false,
    lockedComposer: false,
    highlightedId: null,
    selectedMessageId: null,
    get approvalKeys() {
      return keys();
    },
    set approvalKeys(value: Record<string, string>) {
      keys.set(value);
    },
    get approvalKeyErrors() {
      return errors();
    },
    set approvalKeyErrors(value: Record<string, boolean>) {
      errors.set(value);
    },
    onOpenProfile: (id: string) => submitted.set(`profile:${id}`),
    who: (msg: Message) => (msg.author === EDITOR.id ? EDITOR.name : WRITER.name),
    replyAsk: async (askId: string) => {
      const draft = runtime.getAskDraft(askId);
      submitted.set(`reply:${askId}:${(draft?.selected ?? []).join(",")}|${draft?.body ?? ""}`);
    },
    submitted,
  };
  return stage as unknown as TranscriptStage;
}

const HOLD = {
  id: "hold-1",
  scope: "bot",
  scope_id: WRITER.id,
  action: "pause",
  cascade: true,
  source: "user_button",
  source_message_id: null,
  lift_on_next_user_message: false,
  targets: [],
  effect: {},
  created_at: NOW,
  lifted_at: null,
  lifted_by: null,
  lifted_message_id: null,
  plan_title: null,
} as Hold;

const RECEIPT: MessageControl = {
  kind: "receipt",
  verb: "stop",
  hold_ids: ["hold-1"],
  offer: ["undo", "stop_all"],
  scopes: [{ scope: "bot", id: WRITER.id }],
  plans: [{ offer: "only_plan", task_id: "task-1", title: "EP01" }],
} as MessageControl;

const HANDOVER: MessageControl = {
  kind: "review_item",
  submission_id: "sub-1",
  task_id: "task-1",
  ticket_id: "ticket-1",
  requirement_ids: [],
  check_ids: [],
  offer: ["approve", "reject"],
} as MessageControl;

const PLAN_OPENED: MessageControl = {
  kind: "plan_opened",
  task_id: "task-9",
  turn_id: "turn-9",
  quote_message_id: "msg-9",
  merge_targets: [{ task_id: "task-1", title: "EP01 预告片" }, { task_id: "task-2", title: "EP02 正片" }],
  offer: ["undo_plan", "merge_plan"],
} as MessageControl;

const WORK_QUESTION: WorkQuestionControl = { kind: "work_question", work_item_id: "work-1", task_id: "plan-1", ticket_id: "ticket-1", question: "预告片用哪一版配乐？", offer: [] } as WorkQuestionControl;

const COMMANDS: CommandRow[] = [
  { id: "t:1", turnId: "t", name: "shell", command: "pnpm build", running: false, exitCode: 0, durationMs: 4200, text: "vite v5 building…\n✓ 128 modules transformed.\n\u001b[32mdist/index.js\u001b[0m 1.2 kB" },
  { id: "t:2", turnId: "t", name: "shell", command: "pnpm test --filter chat", running: false, exitCode: 1, durationMs: 12_500, text: "FAIL chat.test.ts\n  expected 2, got 3" },
  { id: "t:3", turnId: "t", name: "shell", command: "ls outline", running: false, exitCode: 0, durationMs: 40, text: "" },
  { id: "t:4", turnId: "t", name: "shell", command: "sleep 600", running: false, exitCode: null, endedAs: "stopped", durationMs: 8000, text: "waiting…" },
  { id: "t:5", turnId: "t", name: "shell", command: "tail -f log", running: true, exitCode: null, durationMs: null, text: "" },
];

const STEPS: StepRow[] = [
  { id: "s:1", text: "读取 notes/weekly.md", time: null, shell: false },
  { id: "s:2", text: "运行 pnpm build", time: "12 秒", shell: true },
  { id: "s:3", text: "子任务：整理素材", time: "3 分钟", shell: false, open: () => undefined },
];

const DELEGATIONS: DelegationView[] = [
  {
    id: "del-1",
    task_id: "task-1",
    ticket_id: null,
    thread_session_id: "thread-1",
    from_bot_id: WRITER.id,
    to_bot_id: EDITOR.id,
    ask: "请审一下周报的第三节",
    expects: "review",
    status: "replied",
    part_keys: [],
    requirement_ids: [],
    created_at: "2026-10-20T09:00:00.000Z",
    request_message_id: null,
    result_message_id: "msg-result",
    reply: { body: "第三节**可以**，数据见 `notes/weekly.md`。", created_at: "2026-10-20T09:10:00.000Z", ref: null },
    wait: null,
  },
  {
    id: "del-2",
    task_id: "task-1",
    ticket_id: null,
    thread_session_id: "thread-2",
    from_bot_id: EDITOR.id,
    to_bot_id: "bot-gone",
    ask: "补一张封面图",
    expects: "deliverable",
    status: "open",
    part_keys: [],
    requirement_ids: [],
    created_at: "2026-10-20T09:20:00.000Z",
    request_message_id: null,
    result_message_id: null,
    reply: null,
    wait: { state: "waiting", since: "2026-10-20T09:21:00.000Z", due_at: "2026-10-20T10:00:00.000Z" },
  },
];

const PLAN: AgentRunApproval = {
  kind_key: "plan",
  target: "plan",
  summary: ["## 迁移计划", "", "1. 先读 `notes/weekly.md`", "2. 再改 `src/app.ts`", "", "- 风险：旧数据", "- 回滚：还原提交"].join("\n"),
};

const SECTIONS = ["ask", "approval", "work", "control", "activity", "plan"] as const;
type Section = (typeof SECTIONS)[number];

function Card(props: { id: string; children: import("nsh").JSX.Element }) {
  return (
    <View testID={props.id} class="p-4 rounded-(--radius-md) bg-bot border border-bot-border max-w-[560px] w-full">
      {props.children}
    </View>
  );
}

export default function ChatCards() {
  const section = signal<Section>("ask");
  const stage = makeStage();
  const said = signal("—");
  const note = (line: string) => said.set(line);
  const act = async (action: ControlOffer, taskId?: string, text?: string) => {
    note(`act:${action}:${taskId ?? ""}:${text ?? ""}`);
    return null;
  };
  const failing = async (action: ControlOffer) => {
    note(`act:${action}`);
    return { status: 422 };
  };
  const plan = signal(true);
  const closed = signal(false);
  const answered = signal<string | null>(null);
  const holds = signal<Hold[]>([HOLD]);
  return (
    <View class="flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-3 border-b border-line">
        <Each of={[...SECTIONS]}>
          {(name) => (
            <Button testID={`show-${name()}`} size="sm" variant={section() === name() ? "primary" : "secondary"} onPress={() => section.set(name())}>
              {name()}
            </Button>
          )}
        </Each>
        <Text testID="said" class="ml-auto text-[12px] text-ink-muted">{said()}</Text>
        <Text testID="stage-said" class="text-[12px] text-ink-muted">{(stage as unknown as { submitted: () => string }).submitted()}</Text>
      </View>
      <Scroll class="flex-1" contentClass="p-4 gap-4">
        <If when={section() === "ask"}>
          <Card id="card-ask">
            <TranscriptAsk group={group(MESSAGES.ask, "ask")} stage={stage} />
          </Card>
          <Card id="card-ask-single">
            <TranscriptAsk group={group(MESSAGES.askOne, "ask")} stage={stage} />
          </Card>
          <Card id="card-ask-answered">
            <AskCard message={MESSAGES.askDone} answerable={false} onDraft={() => undefined} onSelect={() => undefined} onSubmit={() => undefined} />
          </Card>
          <Card id="card-ask-ended">
            <AskCard message={MESSAGES.askEnded} answerable={false} onDraft={() => undefined} onSelect={() => undefined} onSubmit={() => undefined} />
          </Card>
        </If>
        <If when={section() === "approval"}>
          <Card id="card-approval-key">
            <TranscriptApproval group={group(MESSAGES.key, "approval")} stage={stage} />
          </Card>
          <Card id="card-approval-plain">
            <TranscriptApproval group={group(MESSAGES.plain, "approval")} stage={stage} />
          </Card>
          <Card id="card-approval-prompt">
            <TranscriptApproval group={group(MESSAGES.prompt, "approval")} stage={stage} />
          </Card>
          <Card id="card-approval-prompt-done">
            <TranscriptApproval group={group(MESSAGES.promptAllowed, "approval")} stage={stage} />
          </Card>
          <Card id="card-approval-ui">
            <TranscriptApproval group={group(MESSAGES.ui, "approval")} stage={stage} />
          </Card>
          <Card id="card-approval-denied">
            <TranscriptApproval group={group(MESSAGES.denied, "approval")} stage={stage} />
          </Card>
        </If>
        <If when={section() === "work"}>
          <Card id="card-work">
            <WorkQuestionCard
              control={WORK_QUESTION}
              botName="Director"
              planName="Trailer"
              ticketName="Cut 1"
              onAnswer={async (body) => {
                note(`answer:${body}`);
                return { message: MESSAGES.ask, work_item_id: "work-1", inbox_state: "queued", answered: false } as never;
              }}
            />
          </Card>
          <Card id="card-work-answered">
            <WorkQuestionCard
              control={{ ...WORK_QUESTION, answer: { body: "用第二版", at: NOW, user_action_id: "a", inbox_seq: 1 } } as WorkQuestionControl}
              botName="Director"
              planName="Trailer"
              ticketName={null}
              onAnswer={async () => {
                throw new Error("unused");
              }}
            />
          </Card>
          <Card id="card-work-lapsed">
            <WorkQuestionCard
              control={{ ...WORK_QUESTION, superseded_at: NOW } as WorkQuestionControl}
              botName="Director"
              planName="Trailer"
              ticketName={null}
              onAnswer={async () => {
                throw new Error("unused");
              }}
            />
          </Card>
          <Card id="card-work-readonly">
            <WorkQuestionCard
              control={WORK_QUESTION}
              botName="Director"
              planName="Trailer"
              ticketName={null}
              readOnly
              onAnswer={async () => {
                throw new Error("unused");
              }}
            />
          </Card>
        </If>
        <If when={section() === "control"}>
          <Card id="card-control-receipt">
            <ControlActions control={RECEIPT} holds={holds()} botName={() => "Writer"} onAct={act} />
          </Card>
          <Card id="card-control-handover">
            <ControlActions control={HANDOVER} holds={[]} botName={() => "Writer"} align="end" onAct={act} />
          </Card>
          <Card id="card-control-refused">
            <ControlActions control={{ ...RECEIPT, offer: ["undo"] } as MessageControl} holds={holds()} botName={() => "Writer"} onAct={failing} />
          </Card>
          <Card id="card-control-done">
            <ControlActions control={{ ...RECEIPT, acted: ["stop_all"] } as MessageControl} holds={holds()} botName={() => "Writer"} onAct={act} />
          </Card>
          <Card id="card-plan-opened">
            <NewPlanActions control={PLAN_OPENED as Extract<MessageControl, { kind: "plan_opened" }>} onAct={act} />
          </Card>
          <Card id="card-plan-acted">
            <ControlActions
              control={{ ...PLAN_OPENED, acted: ["undo_plan"], retained_effects: ["一个文件"] } as MessageControl}
              holds={[]}
              botName={() => "Writer"}
              onAct={act}
            />
          </Card>
          <Card id="card-plan-refused">
            <NewPlanActions control={{ ...PLAN_OPENED, offer: ["undo_plan"] } as Extract<MessageControl, { kind: "plan_opened" }>} onAct={failing} />
          </Card>
        </If>
        <If when={section() === "activity"}>
          <Card id="card-commands">
            <CommandActivity rows={COMMANDS} beside={<Text class="text-[12px] text-ink-muted">Writer · 09:30</Text>} />
          </Card>
          <Card id="card-commands-tools">
            <CommandActivity rows={COMMANDS.slice(0, 1)} countLabel={(n) => `${n} tool calls`} />
          </Card>
          <If when={!closed()}>
            <TurnStepList id="card-steps" title="Writer 正在做 3 件事" rows={STEPS} outputOf={(id) => (id === "s:2" ? "building…\n12 modules" : null)} onClose={() => closed.set(true)} />
          </If>
          <Text testID="steps-closed" class="text-[12px] text-ink-muted">{closed() ? "steps:closed" : "steps:open"}</Text>
          {/* One step list at a time: Escape closes the newest. */}
          <If when={closed()}>
            <ProjectTaskSteps id="card-task-steps" title="后台命令" rows={STEPS.slice(0, 1)} tasks={[] as AgentRunTask[]} onClose={() => undefined} />
          </If>
          <DelegationRecords
            records={DELEGATIONS}
            botsById={new Map([[WRITER.id, WRITER], [EDITOR.id, EDITOR]])}
            onOpenArtifact={(path, id) => note(`open:${path}:${id ?? ""}`)}
          />
        </If>
        <If when={section() === "plan"}>
          <If when={plan()}>
            <ProjectPlanCard
              approval={PLAN}
              disabled={false}
              onAnswer={(allow) => {
                answered.set(allow ? "plan:approved" : "plan:kept");
                plan.set(false);
              }}
              onOpenPath={(path) => answered.set(`path:${path}`)}
            />
          </If>
          <ProjectPlanCard approval={{ ...PLAN, summary: "" }} disabled onAnswer={() => undefined} onOpenPath={() => undefined} />
          <Text testID="plan-said" class="text-[12px] text-ink-muted">{answered() ?? "—"}</Text>
        </If>
      </Scroll>
    </View>
  );
}
