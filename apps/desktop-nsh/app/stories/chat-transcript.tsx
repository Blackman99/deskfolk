/**
 * The transcript's message groups: a run of your own lines (bubbles, quote, edit in place, a line
 * waiting to be read, a taken-back one, earlier versions, annotation cards), a run of a Bot's replies
 * (the hover pill, the foot, reactions, the working bubble), the system lines (a stop, a failure, a
 * hand-over's card, a work question) and the project subagent's popup. One part at a time; each
 * group reads a stage built here from signals and records what the stage is asked to do in a line.
 */
import { Scroll, signal, Text, View } from "nsh";
import {
  USER_MEMBER,
  type AgentRunTask,
  type AgentTaskDetail,
  type Annotation,
  type Bot,
  type Message,
  type MessageControl,
  type SessionSummary,
  type Turn,
} from "@real-bot/protocol";
import { buildMessageLookup, type TranscriptGroup } from "../src/m/chat/chat-view.ts";
import { queuedLine } from "../src/m/chat/queued-line.ts";
import type { TranscriptStage } from "../src/m/chat/transcript-stage.ts";
import { runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { ProjectSubagentDialog } from "../src/ui/chat/ProjectSubagentDialog";
import { TranscriptBotGroup } from "../src/ui/chat/TranscriptBotGroup";
import { TranscriptSystem } from "../src/ui/chat/TranscriptSystem";
import { TranscriptUserGroup } from "../src/ui/chat/TranscriptUserGroup";
import { rosterLabelsOf, statusLabelsOf } from "../src/ui/chat/labels";
import { copy } from "../src/runtime";

const T0 = "2026-10-20T09:30:00.000Z";
const T1 = "2026-10-20T09:30:40.000Z";
const T2 = "2026-10-20T09:31:10.000Z";
const NOW_MS = new Date("2026-10-20T09:32:00.000Z").getTime();
const WRITER = { id: "bot-writer", name: "Writer", avatar: null, model: "claude-sonnet" } as unknown as Bot;
const EDITOR = { id: "bot-editor", name: "Editor", avatar: null, model: null } as unknown as Bot;
const SESSION = { id: "sess-story", kind: "direct", archived_at: null } as unknown as SessionSummary;

function msg(over: Partial<Message> & { id: string }): Message {
  return {
    session_id: SESSION.id,
    turn_id: null,
    parent_id: null,
    kind: "user",
    author: USER_MEMBER,
    body: "",
    source_turn_id: null,
    created_at: T0,
    attachments: [],
    reactions: [],
    ...over,
  } as Message;
}

const ANNOTATION = {
  id: "ann-1",
  status: "open",
  relpath: "docs/weekly.md",
  anchor_kind: "text_range",
  anchor: { start_line: 3, start_col: 1, end_line: 4, end_col: 5, quote: "const x", prefix: "", suffix: "" },
  content_sha256: "0".repeat(64),
  target_message_id: "bot-1",
  target_session_id: SESSION.id,
  target_turn_id: null,
  bot_id: WRITER.id,
  session_id: SESSION.id,
  message_id: "you-annotated",
  body: "这里换个名字",
  crop_mime: null,
  resolved_by: null,
  resolved_note: null,
  resolved_at: null,
  created_at: T0,
  updated_at: T0,
} as unknown as Annotation;

const M = {
  botFirst: msg({
    id: "bot-1",
    kind: "bot",
    author: WRITER.id,
    turn_id: "turn-done",
    body: "周报的**第一部分**写好了：\n\n- 本周进展\n- 下周计划",
    created_at: T1,
    reactions: [{ emoji: "👍", members: [USER_MEMBER] }] as never,
  }),
  botSecond: msg({ id: "bot-2", kind: "bot", author: WRITER.id, turn_id: "turn-done", body: "第二部分补在文末，请看一下。", created_at: T2 }),
  you1: msg({ id: "you-1", body: "帮我整理一下**本周**周报", created_at: T0, reactions: [{ emoji: "🎉", members: [USER_MEMBER] }] as never }),
  you2: msg({ id: "you-2", body: "再加一段风险", created_at: T1, edited_at: T2 }),
  you3: msg({ id: "you-3", body: "还有一句等着被读", created_at: T2, delivery: { bot_id: WRITER.id, state: "queued", hop: null, note: null } }),
  youQuote: msg({ id: "you-quote", body: "按这一条改", parent_id: "bot-1", created_at: T2 }),
  youWithdrawn: msg({ id: "you-withdrawn", body: "撤回的话", withdrawn_at: T2 }),
  youEdit: msg({ id: "you-edit", body: "待改的一句", created_at: T2 }),
  youAnnotated: msg({ id: "you-annotated", body: "批注发出去了", created_at: T2 }),
  interrupt: msg({ id: "sys-interrupt", kind: "system", author: WRITER.id, turn_id: "turn-int", body: "中断", created_at: T2 }),
  unreachable: msg({ id: "sys-unreachable", kind: "system", author: WRITER.id, turn_id: "turn-un", body: "这一轮没写完：连不上端点", created_at: T2 }),
  app: msg({
    id: "sys-app",
    kind: "system",
    author: WRITER.id,
    body: "已停下 Writer 的这一轮。",
    created_at: T2,
    control: { kind: "receipt", verb: "stop", hold_ids: ["hold-1"], offer: ["undo"], scopes: [{ scope: "bot", id: WRITER.id }], plans: [] } as unknown as MessageControl,
  }),
  work: msg({
    id: "sys-work",
    kind: "system",
    author: WRITER.id,
    body: "",
    created_at: T2,
    control: { kind: "work_question", work_item_id: "work-1", task_id: "plan-1", ticket_id: null, question: "预告片用哪一版配乐？", offer: [] } as unknown as MessageControl,
  }),
};

const TURNS = [
  { id: "turn-done", session_id: SESSION.id, bot_id: WRITER.id, status: "completed", trigger_message_id: "you-1", created_at: T0, updated_at: T1, last_activity_at: T1 },
  { id: "turn-int", session_id: SESSION.id, bot_id: WRITER.id, status: "interrupted", trigger_message_id: "you-1", created_at: T0, updated_at: T1, last_activity_at: T1 },
  { id: "turn-un", session_id: SESSION.id, bot_id: WRITER.id, status: "completed", trigger_message_id: "you-1", created_at: T0, updated_at: T1, last_activity_at: T1 },
  { id: "turn-live", session_id: SESSION.id, bot_id: WRITER.id, status: "running", trigger_message_id: "you-1", partial_text: "先把数据**读一遍**，", created_at: "2026-10-20T09:31:30.000Z", updated_at: T2, last_activity_at: T2 },
  { id: "turn-quiet", session_id: SESSION.id, bot_id: WRITER.id, status: "running", trigger_message_id: "you-1", partial_text: "", created_at: "2026-10-20T09:31:50.000Z", updated_at: T2, last_activity_at: T2 },
] as unknown as Turn[];

const ALL = Object.values(M);

const TASK = { id: "task-1", kind: "subagent", status: "running", description: "查周报数据来源", agent_type: "Explore", run_id: "run-1", tool_uses: 2, tokens: 1200, started_at: "2026-10-20T09:31:00.000Z", activity: null } as unknown as AgentRunTask;
const TASK_DONE = { ...TASK, id: "task-2", status: "completed", description: "汇总" } as AgentRunTask;
const TASK_LOST = { ...TASK, id: "task-3", status: "completed", description: "读不到的" } as AgentRunTask;
/** Running and nothing to read yet: no prompt, no model, no calls (the flat card it once was). */
const TASK_EMPTY = { ...TASK, id: "task-4", description: "Wait for the full screen test run and total it", agent_type: null, tool_uses: null, tokens: null } as AgentRunTask;
/** Empty on its first read, its trail there on the next. */
const TASK_LATE = { ...TASK, id: "task-5", description: "后来才有动作" } as AgentRunTask;
const DETAIL = {
  task: TASK,
  output: null,
  output_bytes: null,
  prompt: "把周报用到的数据来源列一下",
  model: "claude-sonnet",
  steps: [
    { kind: "say", text: "先看一下 **notes** 目录。" },
    { kind: "call", id: "c1", tool: "Read", label: "读取 notes/weekly.md", ok: true, duration_ms: 40, output: null },
    { kind: "call", id: "c2", tool: "Bash", label: "pnpm build", ok: null, duration_ms: 0, output: null },
  ],
} as unknown as AgentTaskDetail;

function group(kind: TranscriptGroup["kind"], ...items: TranscriptGroup["items"]): TranscriptGroup {
  const first = items[0]!;
  const author = first.type === "message" ? first.message.author : first.type === "streaming" ? first.turn.bot_id : "";
  return { id: `g-${kind}-${items.length}-${Math.random().toString(36).slice(2, 6)}`, kind, author, created_at: T0, items } as unknown as TranscriptGroup;
}
const inMsg = (m: Message, replying?: { bot_id: string; created_at: string; judgement_id: string }[]) => ({ type: "message" as const, message: m, replying });

const SECTIONS = ["user", "bot", "system", "dialog"] as const;
type Section = (typeof SECTIONS)[number];

export default function ChatTranscript() {
  const section = signal<Section>("user");
  const said = signal("—");
  const note = (line: string) => said.set(line);
  const copied = signal<string | null>(null);
  const editing = signal<string | null>(null);
  const editDraft = signal("");
  const focus = signal(false);
  const locked = signal(false);
  const versions = signal<Record<string, never>>({});
  const open = signal<AgentRunTask | null>(null);
  const openSteps = signal<string | null>(null);

  const view = {
    get editDraft() {
      return editDraft();
    },
    set editDraft(value: string) {
      editDraft.set(value);
    },
    editSaving: false,
    editError: null,
    sending: false,
  };
  const annotations = new Map<string, Annotation[]>([["you-annotated", [ANNOTATION]]]);
  const stage = {
    snapshot: { turns: TURNS, approvals: [], holds: [], messages: ALL, interface: { recent: [] }, pendingJudgements: [], queuedLineActions: true },
    view,
    selected: SESSION,
    selectedKind: "you-bot",
    botsById: new Map([[WRITER.id, WRITER], [EDITOR.id, EDITOR]]),
    locale: "zh",
    connected: true,
    get lockedComposer() {
      return locked();
    },
    fileDrop: false,
    sidesSayWho: false,
    get focus() {
      return focus();
    },
    highlightedId: null,
    selectedMessageId: null,
    get copiedMessageId() {
      return copied();
    },
    statusLabels: statusLabelsOf(copy()),
    rosterLabels: rosterLabelsOf(copy()),
    liveTurnsHere: [],
    announced: new Set<string>(),
    messageLookup: buildMessageLookup(ALL),
    commandHosts: new Set<string>(),
    annotationIndex: annotations,
    botDmIndex: new Map(),
    cardErrors: {},
    get versionsShown() {
      return versions() as never;
    },
    editErrorText: null,
    nowMs: NOW_MS,
    arriving: new Set<string>(),
    approvalKeys: {},
    approvalKeyErrors: {},
    get openStepsTurn() {
      return openSteps();
    },
    set openStepsTurn(value: string | null) {
      openSteps.set(value);
    },
    onOpenProfile: (id: string) => note(`profile:${id}`),
    onOpenArtifact: (path: string) => note(`artifact:${path}`),
    who: (m: Message) => (m.author === USER_MEMBER ? "你" : m.author === EDITOR.id ? EDITOR.name : WRITER.name),
    whoAuthor: (a: string) => (a === EDITOR.id ? EDITOR.name : WRITER.name),
    botNameOf: (id: string) => (id === EDITOR.id ? EDITOR.name : WRITER.name),
    markdownOpts: () => ({}),
    messageBody: (m: Message) => m.body,
    messageShowsAttachments: (m: Message) => m.attachments.length > 0,
    loadBodyImage: async () => new Blob([]),
    openBodyImage: () => undefined,
    openInlineImage: () => undefined,
    openInlineFile: () => undefined,
    openAnnotation: (row: Annotation) => note(`annotation:${row.id}`),
    toggleAnnotation: async (id: string, row: Annotation, status: string) => note(`toggle:${row.id}:${status}`),
    annotationSourceLabel: () => null,
    openAnnotationSource: () => undefined,
    editable: (m: Message) => m.author === USER_MEMBER && !m.withdrawn_at,
    editingHere: (m: Message) => editing() === m.id,
    startEdit: (m: Message) => {
      editDraft.set(m.body);
      editing.set(m.id);
    },
    queuedLine: (m: Message) =>
      queuedLine(m, { queuedLineActions: true, connected: true, lockedComposer: locked(), turnsHere: [TURNS[3]!] }),
    withdrawLine: async (m: Message) => note(`withdraw:${m.id}`),
    reEditLine: (m: Message) => note(`re-edit:${m.id}`),
    insertLine: (m: Message) => note(`insert:${m.id}`),
    lineBusy: () => false,
    insertTitle: () => "",
    lineNoteText: () => null,
    toggleVersions: async (m: Message) => {
      versions.set({ ...versions(), [m.id]: { at: m.edited_at ?? "", loading: false, failed: false, versions: [{ created_at: T0, body: "再加一段" }] } } as never);
    },
    copyMessageBody: (id: string, text: string) => {
      copied.set(id);
      note(`copy:${text}`);
    },
    startQuoteReply: (m: Message) => note(`quote:${m.id}`),
    handleMessageMouseDown: () => undefined,
    handleMessageTouchStart: () => undefined,
    handleMessageContextMenu: () => undefined,
    pressControl: async () => null,
    replyAsk: async () => undefined,
    showMessageTrace: (m: Message) => note(`trace:${m.id}`),
  } as unknown as TranscriptStage;

  const menu = (m: Message, at: { x: number; y: number }) => note(`menu:${m.id}@${Math.round(at.x) >= 0 ? "ok" : ""}`);

  // The popup reads the subagent through the runtime's client; the story answers for its tasks.
  const show = (task: AgentRunTask) => {
    const client = runtime.client as unknown as { agentTaskDetail: (run: string, id: string) => Promise<AgentTaskDetail> } | null;
    let lateReads = 0;
    if (client) {
      client.agentTaskDetail = async (_run, id) => {
        if (id === TASK_LOST.id) throw new Error("gone");
        if (id === TASK_DONE.id) return { ...DETAIL, task: TASK_DONE, steps: [] } as AgentTaskDetail;
        const empty = { ...DETAIL, task, prompt: null, model: null, steps: [] } as AgentTaskDetail;
        if (id === TASK_EMPTY.id) return empty;
        if (id === TASK_LATE.id) return (lateReads += 1) === 1 ? empty : { ...DETAIL, task };
        return DETAIL;
      };
    }
    open.set(task);
  };

  return (
    <View class="flex-1 bg-bg">
      <View class="flex-row flex-wrap gap-2 p-3 border-b border-line items-center">
        <Each of={[...SECTIONS]}>
          {(name) => (
            <Button testID={`show-${name()}`} size="sm" variant={section() === name() ? "primary" : "secondary"} onPress={() => section.set(name())}>
              {name()}
            </Button>
          )}
        </Each>
        <Button testID="toggle-focus" size="sm" variant="secondary" onPress={() => focus.set(!focus())}>
          focus
        </Button>
        <Button testID="toggle-locked" size="sm" variant="secondary" onPress={() => locked.set(!locked())}>
          locked
        </Button>
        <Text testID="said" class="ml-auto text-[12px] text-ink-muted">
          {said()}
        </Text>
      </View>
      <Scroll class="flex-1" contentClass="p-4 gap-6">
        <If when={section() === "user"}>
          <View testID="run-you" class="w-full">
            <TranscriptUserGroup group={group("user", inMsg(M.you1), inMsg(M.you2), inMsg(M.you3, [{ bot_id: WRITER.id, created_at: T2, judgement_id: "j1" }]))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="run-quote" class="w-full">
            <TranscriptUserGroup group={group("user", inMsg(M.youQuote))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="run-withdrawn" class="w-full">
            <TranscriptUserGroup group={group("user", inMsg(M.youWithdrawn))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="run-edit" class="w-full">
            <TranscriptUserGroup group={group("user", inMsg(M.youEdit))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="run-annotated" class="w-full">
            <TranscriptUserGroup group={group("user", inMsg(M.youAnnotated))} stage={stage} onContextMenu={menu} />
          </View>
        </If>
        <If when={section() === "bot"}>
          <View testID="run-bot" class="w-full">
            <TranscriptBotGroup group={group("bot", inMsg(M.botFirst), inMsg(M.botSecond))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="run-stream" class="w-full">
            <TranscriptBotGroup group={group("bot", { type: "streaming", turn: TURNS[3]! })} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="run-stream-quiet" class="w-full">
            <TranscriptBotGroup group={group("bot", { type: "streaming", turn: TURNS[4]! })} stage={stage} onContextMenu={menu} />
          </View>
        </If>
        <If when={section() === "system"}>
          <View testID="row-interrupt" class="w-full">
            <TranscriptSystem group={group("system", inMsg(M.interrupt))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="row-unreachable" class="w-full">
            <TranscriptSystem group={group("system", inMsg(M.unreachable))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="row-app" class="w-full">
            <TranscriptSystem group={group("system", inMsg(M.app))} stage={stage} onContextMenu={menu} />
          </View>
          <View testID="row-work" class="w-full">
            <TranscriptSystem group={group("system", inMsg(M.work))} stage={stage} onContextMenu={menu} />
          </View>
        </If>
        <If when={section() === "dialog"}>
          <View class="flex-row gap-2">
            <Button testID="open-running" size="sm" onPress={() => show(TASK)}>
              running
            </Button>
            <Button testID="open-done" size="sm" variant="secondary" onPress={() => show(TASK_DONE)}>
              done
            </Button>
            <Button testID="open-lost" size="sm" variant="secondary" onPress={() => show(TASK_LOST)}>
              lost
            </Button>
            <Button testID="open-empty" size="sm" variant="secondary" onPress={() => show(TASK_EMPTY)}>
              empty
            </Button>
            <Button testID="open-late" size="sm" variant="secondary" onPress={() => show(TASK_LATE)}>
              late
            </Button>
          </View>
        </If>
      </Scroll>
      <If when={open()}>
        {(task: () => AgentRunTask) => <ProjectSubagentDialog task={task()} onClose={() => open.set(null)} onOpenPath={(path) => note(`path:${path}`)} />}
      </If>
    </View>
  );
}
