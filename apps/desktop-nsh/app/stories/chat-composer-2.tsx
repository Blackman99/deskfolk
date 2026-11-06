/**
 * The whole composer (`Composer`) on the fixture runtime: Writer's direct, the group 周报小组, a
 * file conversation and an archived (locked) group, picked by buttons. What the runtime cannot be
 * asked for cheaply is a local overlay on its snapshot (a Bot at work, the daemon's stops, a speech
 * endpoint); the microphone is a fake recorder with a fake transcript, and dropped local files are
 * read by a fake reader (NSH cannot `fetch` a `file:` URL); sending goes to the runtime
 * and `story-read` reads the line back from `runtime.snapshot.messages`. Sending goes into a scratch group
 * the story makes and deletes (a line sent into the fixture's Writer direct would leave it unfinished
 * for every test after).
 */
import { Scroll, signal, Text, View } from "nsh";
import { FILE_DROP_SESSION_ID, type Bot, type SessionSummary, type Turn } from "@real-bot/protocol";
import type { Recording, RecorderHooks } from "../src/m/chat/voice-recorder";
import { classifySession, youBotPeer } from "../src/m/sidebar/session-groups";
import { runtime } from "../src/runtime";
import { Composer } from "../src/ui/chat/Composer";
import type { HiddenWaiting } from "../src/ui/chat/waiting-jump";

const which = signal<"direct" | "group" | "file-drop" | "locked" | "scratch">("direct");
/** A group the story makes to send into, so the fixture's own conversations keep their state; `story-cleanup` deletes it. */
const scratchId = signal("");
const working = signal(false);
const speechOn = signal(false);
const narrow = signal(false);
const fakeMic = signal(false);
const waiting = signal(false);
const scrollShown = signal(false);

/** The runtime's snapshot with what the story switches on: a speech endpoint, a Bot at work, the daemon's stops. */
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "snapshot")!;
const real = descriptor.get!;
Object.defineProperty(runtime, "snapshot", {
  configurable: true,
  set: descriptor.set,
  get() {
    const snap = real.call(runtime);
    const settings = speechOn() ? { ...snap.settings, speech: { enabled: true, preset: "custom", base_url: "http://127.0.0.1:1/v1", model: "story", key_set: true } } : snap.settings;
    const here = selectedSession();
    const writer = snap.bots.find((b: Bot) => b.name === "Writer");
    const turns: Turn[] = [...snap.turns];
    if (working() && here && writer) {
      turns.push({
        id: "turn-story",
        session_id: here.id,
        bot_id: writer.id,
        status: "running",
        trigger_message_id: "m-story",
        last_activity_at: "2026-11-01T02:00:01.000Z",
        created_at: "2026-11-01T02:00:00.000Z",
        updated_at: "2026-11-01T02:00:01.000Z",
      } as unknown as Turn);
    }
    return { ...snap, settings, turns, holdsOn: true };
  },
});

const sessions = (): SessionSummary[] => real.call(runtime).sessions;
const writerBot = () => real.call(runtime).bots.find((b: Bot) => b.name === "Writer");
const direct = () => sessions().find((s) => classifySession(s) === "you-bot" && youBotPeer(s) === writerBot()?.id);
const group = () => sessions().find((s) => classifySession(s) === "group" && s.id !== scratchId());

function selectedSession(): SessionSummary | null {
  const base = direct();
  const grp = group();
  switch (which()) {
    case "direct":
      return base ?? null;
    case "group":
      return grp ?? null;
    case "file-drop":
      return sessions().find((s) => s.id === FILE_DROP_SESSION_ID) ?? (base ? { ...base, id: FILE_DROP_SESSION_ID } : null);
    case "scratch":
      return sessions().find((s) => s.id === scratchId()) ?? null;
    case "locked":
      return grp ? { ...grp, archived_at: "2026-11-01T00:00:00.000Z" } : null;
  }
}

/** A microphone that records nothing and hands back four bytes. */
class FakeRecorder {
  async start(hooks: RecorderHooks = {}): Promise<void> {
    hooks.onTick?.(1);
  }
  async stop(): Promise<Recording> {
    return { blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }), mime: "audio/webm", seconds: 1 };
  }
  cancel(): void {}
}

const heard = signal("");
const sentLog = signal("sent:0");
const readBack = signal("");
const jumped = signal("");
let sentCount = 0;

export default function ChatComposer2Story() {
  const session = () => selectedSession();
  const view = () => {
    const s = session();
    return s ? runtime.sessionView(s.id) : null;
  };
  const hidden = (): HiddenWaiting => ({ items: waiting() ? [{ id: "ap1", kind: "approval" }] : [], above: true });

  /** Sends the way the stage does, and says what went to the runtime. */
  async function onSend(files: File[], paths: string[]): Promise<boolean> {
    const sent = await runtime.send({ attachments: files.length > 0 ? files : undefined, paths: paths.length > 0 ? paths : undefined, sessionId: session()?.id });
    sentCount += 1;
    sentLog.set(`sent:${sentCount} files:${files.map((f) => f.name).join(",")} ok:${sent}`);
    return sent;
  }

  /** The lines of the story's scratch group (else Writer's direct) as the runtime's snapshot holds them: it loads the selected conversation's, and the event stream brings new ones. */
  async function read(): Promise<void> {
    const id = scratchId() || direct()?.id;
    if (!id) return;
    if (runtime.selectedId !== id) await runtime.selectSession(id);
    readBack.set(
      runtime.snapshot.messages
        .filter((m) => m.session_id === id)
        .map((m) => m.body)
        .join("|"),
    );
  }

  async function makeScratch(): Promise<void> {
    const api = runtime.client;
    const bots = real.call(runtime).bots as Bot[];
    if (!api || scratchId()) return;
    const made = await api.createGroup({ name: "composer scratch", members: bots.map((b) => b.id) });
    scratchId.set(made.id);
    which.set("scratch");
  }

  async function cleanup(): Promise<void> {
    const id = scratchId();
    which.set("direct");
    scratchId.set("");
    if (id) await runtime.deleteSession(id);
    readBack.set("");
  }

  const button = (testID: string, label: string, onPress: () => void) => (
    <View role="button" testID={testID} onPress={onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{label}</Text>
    </View>
  );

  return (
    <Scroll class="flex-1 bg-bg">
      <View class="p-4 gap-3">
        <View class="flex-row flex-wrap gap-2">
          {button("story-direct", "direct", () => which.set("direct"))}
          {button("story-group", "group", () => which.set("group"))}
          {button("story-file-drop", "file drop", () => which.set("file-drop"))}
          {button("story-locked", "locked", () => which.set("locked"))}
          {button("story-working", "working", () => working.set(!working()))}
          {button("story-narrow", "narrow", () => narrow.set(!narrow()))}
          {button("story-speech", "speech", () => speechOn.set(!speechOn()))}
          {button("story-fake-mic", "fake mic", () => fakeMic.set(true))}
          {button("story-waiting", "waiting", () => waiting.set(!waiting()))}
          {button("story-scroll", "scroll", () => scrollShown.set(!scrollShown()))}
          {button("story-quote", "quote", () => {
            const v = view();
            const first = runtime.snapshot.messages.find((m) => m.session_id === session()?.id);
            if (v && first) v.replyingToId = first.id;
          })}
          {button("story-suggest", "suggestions", () => {
            const v = view();
            if (v) v.composerSuggestions = [{ id: "a", label: "继续写第二节", prompt: "继续写第二节" }, { id: "b", label: "换个语气", prompt: "换个更轻松的语气" }];
          })}
          {button("story-suggest-empty", "nothing to suggest", () => {
            const v = view();
            if (v) v.suggestionsEmpty = true;
          })}
          {button("story-refused", "refused", () => {
            const v = view();
            if (v) v.sendRefused = "too_many_files";
          })}
          {button("story-heard", "fake transcript", () => {
            const api = runtime.client as unknown as { transcribe: (...args: unknown[]) => Promise<{ text: string }> } | null;
            if (api) api.transcribe = async () => ({ text: "你好，世界" });
            heard.set("你好，世界");
          })}
          {button("story-scratch", "scratch group", () => void makeScratch())}
          {button("story-read", "read back", () => void read())}
          {button("story-cleanup", "clean up", () => void cleanup())}
        </View>
        <Text testID="story-session" class="text-[12px] text-ink-muted">{`session:${which()}`}</Text>
        <Text testID="story-draft" class="text-[12px] text-ink-muted">{`draft:${view()?.draft ?? ""}`}</Text>
        <Text testID="story-staged" class="text-[12px] text-ink-muted">{`staged:${(view()?.stagedAttachments ?? []).map((a) => a.name).join(",")}`}</Text>
        <Text testID="story-sent" class="text-[12px] text-ink-muted">{sentLog()}</Text>
        <Text testID="story-readback" class="text-[12px] text-ink-muted">{`read:${readBack()}`}</Text>
        <Text testID="story-jumped" class="text-[12px] text-ink-muted">{`jumped:${jumped()}`}</Text>
        <View class="h-[260px] justify-end bg-pane border border-line rounded-(--radius-md)" style={{ width: narrow() ? 400 : undefined }}>
          <Composer
            selected={session()}
            onSend={onSend}
            onPickPrompt={(prompt) => {
              const v = view();
              if (v) v.draft = prompt;
            }}
            showScrollBottom={scrollShown()}
            onScrollToBottom={() => scrollShown.set(false)}
            hiddenWaiting={hidden()}
            onJumpWaiting={(id) => {
              jumped.set(id);
              waiting.set(false);
            }}
            readFiles={async (uris) => uris.map((uri) => new File([new Uint8Array([104, 105])], decodeURIComponent(uri.split("/").pop() ?? "file"), { type: "text/plain" }))}
            makeRecorder={fakeMic() ? () => new FakeRecorder() as never : undefined}
          />
        </View>
      </View>
    </Scroll>
  );
}
