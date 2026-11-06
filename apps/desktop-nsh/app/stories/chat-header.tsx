/**
 * The bar above a conversation and what sits around the transcript's edges: the header (desktop and
 * phone), a pane's compact bar, tab labels, "elsewhere", the welcome, the line editor, the message
 * index, the replying row, Bot↔Bot and subagent entries, quotes, reactions and the interface chip.
 * Sessions come from the fixture runtime's snapshot (Writer, Editor, 周报小组); what the runtime cannot
 * be asked for cheaply (a Bot working in the group, task lists) is props or a local overlay.
 */
import { Scroll, signal, Text, View } from "nsh";
import { FILE_DROP_SESSION_ID, USER_MEMBER, type AgentRunTask, type Bot, type InterfaceRevisionHead, type Message, type SessionSummary, type Turn } from "@real-bot/protocol";
import { buildMessageLookup } from "../src/m/chat/chat-view";
import { messageIndexMarks } from "../src/m/chat/message-index";
import { classifySession } from "../src/m/sidebar/session-groups";
import { copy, runtime } from "../src/runtime";
import { BotDmEntry } from "../src/ui/chat/BotDmEntry";
import { BotElsewhere } from "../src/ui/chat/BotElsewhere";
import { ChatHeader } from "../src/ui/chat/ChatHeader";
import { ChatTabLabel } from "../src/ui/chat/ChatTabLabel";
import { ChatWelcome } from "../src/ui/chat/ChatWelcome";
import { InterfaceChangeChip } from "../src/ui/chat/InterfaceChangeChip";
import { MessageEditor } from "../src/ui/chat/MessageEditor";
import { MessageIndex } from "../src/ui/chat/MessageIndex";
import { PaneChatBar, type PaneBarAction } from "../src/ui/chat/PaneChatBar";
import { ProjectSubagentEntry } from "../src/ui/chat/ProjectSubagentEntry";
import { QuoteRef } from "../src/ui/chat/QuoteRef";
import { ReactionRow } from "../src/ui/chat/ReactionRow";
import { ReplyingIndicator } from "../src/ui/chat/ReplyingIndicator";
import { statusLabelsOf, rosterLabelsOf } from "../src/ui/chat/labels";

/** The runtime's snapshot, with Writer's turn in the group added while `busyElsewhere` is on. */
const busyElsewhere = signal(false);
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "snapshot")!;
const real = descriptor.get!;
Object.defineProperty(runtime, "snapshot", {
  configurable: true,
  set: descriptor.set,
  get() {
    const snap = real.call(runtime);
    if (!busyElsewhere()) return snap;
    const group = snap.sessions.find((s: SessionSummary) => s.kind === "group");
    const writer = snap.bots.find((b: Bot) => b.name === "Writer");
    if (!group || !writer) return snap;
    const turn = {
      id: "turn-story",
      session_id: group.id,
      bot_id: writer.id,
      status: "running",
      trigger_message_id: "m-story",
      last_activity_at: "2026-11-01T02:00:01.000Z",
      created_at: "2026-11-01T02:00:00.000Z",
      updated_at: "2026-11-01T02:00:01.000Z",
    } as unknown as Turn;
    return { ...snap, turns: [...snap.turns, turn] };
  },
});

const sessions = () => runtime.snapshot.sessions;
const directSession = () => sessions().find((s) => classifySession(s) === "you-bot");
const groupSession = () => sessions().find((s) => classifySession(s) === "group");
const projectSession = (): SessionSummary | undefined => {
  const base = groupSession();
  return base ? ({ ...base, id: "project-story", kind: "project", title: "Deskfolk", project_dir: "/Users/dev/my-projects/real-bot", agent: "claude-code" } as unknown as SessionSummary) : undefined;
};
const fileDropSession = (): SessionSummary | undefined => {
  const base = directSession();
  return base ? ({ ...base, id: FILE_DROP_SESSION_ID, participants: [{ member: USER_MEMBER, joined_at: "2026-11-01T00:00:00.000Z", left_at: null }] } as unknown as SessionSummary) : undefined;
};

const log = signal<string[]>([]);
const say = (line: string) => log.set([...log(), line]);

const MARK_BODIES = ["选题定下来了", "周报第一版", "加一段数据", "好的，改好了", "图表也更新", "再看一眼标题", "发给大家吧", "收到", "还有一处错别字", "已修"];
const marks = () =>
  messageIndexMarks(
    MARK_BODIES.map((body, i) => ({
      type: "message" as const,
      message: {
        id: `m${i}`,
        session_id: "s",
        turn_id: null,
        parent_id: null,
        kind: i % 2 === 0 ? "user" : "bot",
        author: i % 2 === 0 ? USER_MEMBER : "bot-writer",
        body,
        source_turn_id: null,
        created_at: `2026-11-01T0${i % 9}:00:00.000Z`,
        attachments: [],
        reactions: [],
      } as unknown as Message,
    })),
  );

const TASKS = [
  { id: "t1", kind: "subagent", status: "running", description: "查周报数据来源", agent_type: "Explore", run_id: "r" },
  { id: "t2", kind: "subagent", status: "failed", description: "校对图表", agent_type: "general-purpose", run_id: "r" },
  { id: "t3", kind: "subagent", status: "completed", description: "汇总", agent_type: null, run_id: "r" },
] as unknown as AgentRunTask[];

const HEAD = (over: Partial<InterfaceRevisionHead> = {}): InterfaceRevisionHead =>
  ({ id: "r1", revision: 1, op: "edit", actor: "bot", bot_id: "b1", turn_id: "turn-1", approval_id: null, message_id: null, reason: null, app_version: null, created_at: "", changes: ["专注模式 开", "第二处"], undoable: true, ...over }) as InterfaceRevisionHead;

function Section(props: { title: string; children?: unknown }) {
  return (
    <View class="gap-2">
      <Text class="text-[12px] font-semibold text-ink-muted">{props.title}</Text>
      {props.children as never}
    </View>
  );
}

export default function ChatHeaderStory() {
  const pinned = signal<string[]>([]);
  const settings = signal(false);
  const editing = signal("片长 30 秒");
  const saving = signal(false);
  const line = (id: string, body: string, over: Partial<Message> = {}): Message =>
    ({ id, session_id: "s", turn_id: null, parent_id: null, kind: "user", author: USER_MEMBER, body, source_turn_id: null, created_at: "2026-11-01T01:00:00.000Z", attachments: [], reactions: [], ...over }) as unknown as Message;
  const quoted = line("q1", "周报先写本周的数据");
  const reply = line("q2", "好的，已经加上", { parent_id: "q1", kind: "bot", author: "bot-writer" });
  const reacted = line("q3", "收到", { reactions: [{ emoji: "👍", actor: "bot-x" } as never] });
  const paneActions = (s: SessionSummary): PaneBarAction[] => [
    { id: "pin", label: copy().top.pin, icon: "pin", active: pinned().includes(s.id), run: () => (pinned().includes(s.id) ? pinned.set(pinned().filter((x) => x !== s.id)) : pinned.set([...pinned(), s.id])) },
    { id: "trace", label: copy().trace.topAction, icon: "hierarchy", run: () => say("bar:trace") },
    { id: "settings", label: copy().top.botSettings, icon: "settings", active: settings(), run: () => settings.set(!settings()) },
  ];
  const lookup = () => buildMessageLookup([quoted, reply]);
  const bots = () => new Map<string, Bot>(runtime.snapshot.bots.map((b) => [b.id, b] as const));
  const replyEntries = () => [...runtime.snapshot.bots].slice(0, 2).map((b, i) => ({ bot_id: b.id, created_at: "", judgement_id: `j${i}` }));

  return (
    <Scroll class="flex-1 bg-bg">
      <If when={directSession() && groupSession() && projectSession() && fileDropSession()}>
        <View class="gap-5 p-5">
          <Text testID="log" class="text-[12px] text-ink-muted">{log().join(" | ") || "—"}</Text>
          <Text testID="state" class="text-[12px] text-ink-muted">{`settings:${settings() ? "on" : "off"} pinned:${pinned().length} elsewhere:${busyElsewhere() ? "on" : "off"}`}</Text>

          <Section title="ChatHeader">
            <View testID="header-direct" class="border border-line">
              <ChatHeader
                selected={directSession()!}
                pinnedSessionIds={pinned()}
                onTogglePin={(id) => pinned.set(pinned().includes(id) ? pinned().filter((x) => x !== id) : [...pinned(), id])}
                onToggleSessionSettings={() => settings.set(!settings())}
                settingsOpen={settings()}
                onCreateBot={() => say("create-bot")}
                onShowOnboarding={() => say("onboarding")}
              />
            </View>
            <View testID="header-group" class="border border-line">
              <ChatHeader selected={groupSession()!} pinnedSessionIds={[]} onTogglePin={() => {}} onToggleSessionSettings={() => say("group-settings")} onCreateBot={() => {}} onShowOnboarding={() => {}} />
            </View>
            <View testID="header-file" class="border border-line">
              <ChatHeader selected={fileDropSession()!} pinnedSessionIds={[]} onTogglePin={() => {}} onToggleSessionSettings={() => {}} onCreateBot={() => {}} onShowOnboarding={() => {}} />
            </View>
            <View testID="header-none" class="border border-line">
              <ChatHeader selected={null} pinnedSessionIds={[]} onTogglePin={() => {}} onToggleSessionSettings={() => {}} onCreateBot={() => say("create-bot")} onShowOnboarding={() => say("onboarding")} />
            </View>
          </Section>

          <Section title="PaneChatBar · ChatTabLabel">
            <View testID="bar-direct" class="border border-line">
              <PaneChatBar session={directSession()!} actions={paneActions(directSession()!)} />
            </View>
            <View testID="bar-project" class="border border-line">
              <PaneChatBar session={projectSession()!} actions={paneActions(projectSession()!)} />
            </View>
            <View class="flex-row flex-wrap gap-4 items-center">
              <View testID="tab-direct" class="max-w-[200px]"><ChatTabLabel session={directSession()!} title="Writer" /></View>
              <View testID="tab-group" class="max-w-[200px]"><ChatTabLabel session={groupSession()!} title="周报小组" /></View>
              <View testID="tab-project" class="max-w-[200px]"><ChatTabLabel session={projectSession()!} title="Deskfolk" /></View>
              <View testID="tab-file" class="max-w-[200px]"><ChatTabLabel session={fileDropSession()!} title={copy().sidebar.fileDrop} /></View>
            </View>
          </Section>

          <Section title="BotElsewhere">
            <View class="flex-row items-center gap-3">
              <View role="button" testID="toggle-elsewhere" onPress={() => busyElsewhere.set(!busyElsewhere())} class="px-3 py-1 border border-line rounded-(--radius-sm)">
                <Text class="text-[12px] text-ink">Writer 在群里工作</Text>
              </View>
              <If when={runtime.snapshot.bots.find((b) => b.name === "Writer")}>
                {(writer) => <BotElsewhere botId={writer().id} here={directSession()!} />}
              </If>
            </View>
          </Section>

          <Section title="ChatWelcome">
            <View class="flex-row gap-4">
              <View testID="welcome-direct" class="flex-1">
                <ChatWelcome
                  selected={directSession()!}
                  selectedKind="you-bot"
                  selectedPeerBot={runtime.snapshot.bots.find((b) => b.name === "Writer") ?? null}
                  locale="zh"
                  fileDrop={false}
                  lockedComposer={false}
                  onOpenProfile={(id) => say(`profile:${id === runtime.snapshot.bots.find((b) => b.name === "Writer")?.id ? "writer" : id}`)}
                  pickStarterPrompt={(prompt) => say(`starter:${prompt.slice(0, 12)}`)}
                  titleOf={() => "Writer"}
                />
              </View>
              <View testID="welcome-group" class="flex-1">
                <ChatWelcome selected={groupSession()!} selectedKind="group" selectedPeerBot={null} locale="zh" fileDrop={false} lockedComposer={false} onOpenProfile={() => {}} pickStarterPrompt={() => {}} titleOf={() => "周报小组"} />
              </View>
              <View testID="welcome-file" class="flex-1">
                <ChatWelcome selected={fileDropSession()!} selectedKind="file-drop" selectedPeerBot={null} locale="zh" fileDrop lockedComposer={false} onOpenProfile={() => {}} pickStarterPrompt={() => {}} titleOf={() => ""} />
              </View>
            </View>
          </Section>

          <Section title="MessageEditor">
            <View class="p-3 border border-line rounded-(--radius-md) max-w-[520px]">
              <MessageEditor
                value={editing()}
                saving={saving()}
                error={editing().includes("错") ? copy().chat.editNotEditable : null}
                onInput={(v) => editing.set(v)}
                onSave={() => say(`save:${editing()}`)}
                onCancel={() => say("cancel")}
              />
            </View>
            <View role="button" testID="toggle-saving" onPress={() => saving.set(!saving())} class="px-3 py-1 border border-line rounded-(--radius-sm) self-start">
              <Text class="text-[12px] text-ink">保存中</Text>
            </View>
          </Section>

          <Section title="MessageIndex">
            <View testID="index-stage" class="relative h-[240px] border border-line">
              <MessageIndex
                marks={marks()}
                activeId="m2"
                locale="zh"
                label="消息索引"
                emptyLabel="无文字"
                sender={(m) => (m.author === USER_MEMBER ? "你" : "Writer")}
                hasEarlier
                earlierLabel="更早的消息"
                onLoadEarlier={() => say("earlier")}
                onJump={(m) => say(`jump:${m.id}`)}
                maxHeight={200}
              />
            </View>
          </Section>

          <Section title="ReplyingIndicator · BotDmEntry · ProjectSubagentEntry">
            <View class="gap-3 items-start">
              <View testID="replying-one"><ReplyingIndicator entries={replyEntries().slice(0, 1)} botsById={bots()} thinkingText={copy().sidebar.statusRunning} onOpenProfile={(id) => say(`reply-profile:${id === runtime.snapshot.bots[0]?.id ? "first" : "other"}`)} /></View>
              <View testID="replying-many"><ReplyingIndicator entries={replyEntries()} botsById={bots()} thinkingText={copy().sidebar.statusRunning} /></View>
              <View testID="dm-one" class="self-stretch">
                <BotDmEntry
                  sessions={[directSession()!]}
                  botsById={bots()}
                  turns={runtime.snapshot.turns}
                  statusLabels={statusLabelsOf(copy())}
                  rosterLabels={rosterLabelsOf(copy())}
                  openedText={copy().chat.botDmOpened}
                  onOpen={(id) => say(`open:${id === directSession()?.id ? "direct" : id}`)}
                  onShowTrace={() => say("trace")}
                  traceLabel={copy().trace.title}
                />
              </View>
              <View testID="dm-many" class="self-stretch">
                <BotDmEntry
                  sessions={[directSession()!, groupSession()!, projectSession()!, fileDropSession()!]}
                  botsById={bots()}
                  turns={runtime.snapshot.turns}
                  statusLabels={statusLabelsOf(copy())}
                  rosterLabels={rosterLabelsOf(copy())}
                  openedText={copy().chat.botDmOpened}
                  inlineLimit={2}
                  onOpen={(id) => say(`open:${id}`)}
                />
              </View>
              <View testID="subagent-one"><ProjectSubagentEntry tasks={[TASKS[0]!]} onOpen={(task) => say(`subagent:${task.id}`)} /></View>
              <View testID="subagent-many"><ProjectSubagentEntry tasks={TASKS} onOpen={(task) => say(`subagent:${task.id}`)} /></View>
            </View>
          </Section>

          <Section title="QuoteRef · ReactionRow · InterfaceChangeChip">
            <View class="gap-3 items-start max-w-[420px]">
              <QuoteRef message={reply} selected={directSession()!} messageLookup={lookup()} who={(m) => (m.author === USER_MEMBER ? "你" : "Writer")} />
              <ReactionRow message={reacted} lockedComposer={false} />
              <View testID="chip-ok">
                <InterfaceChangeChip turnIds={["turn-1"]} recent={[HEAD(), HEAD({ id: "r2", undoable: false, changes: ["换了主题"] })]} api={{ undoInterfaceRevision: async (id: string) => void say(`undo:${id}`) } as never} />
              </View>
            </View>
          </Section>
        </View>
      </If>
    </Scroll>
  );
}
