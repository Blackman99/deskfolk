/** The composer's parts: the message box with its @ list, the suggestions, the quote, voice, send, stop, the waiting chip and the model pickers. */
import { signal, Scroll, Text, View } from "nsh";
import { USER_MEMBER, type Bot, type ClaudeCodeCommand, type ClaudeCodeModel, type Message } from "@real-bot/protocol";
import { ComposerVoice } from "../src/m/chat/composer-voice.svelte";
import type { ComposerAction } from "../src/m/chat/composer-mode";
import { copy } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { AgentTune } from "../src/ui/chat/AgentTune";
import { BotTune } from "../src/ui/chat/BotTune";
import { ComposerEditor } from "../src/ui/chat/ComposerEditor";
import { ComposerQuote } from "../src/ui/chat/ComposerQuote";
import { ComposerSuggestions } from "../src/ui/chat/ComposerSuggestions";
import { ProjectCommandMenu } from "../src/ui/chat/ProjectCommandMenu";
import { ScrollBottomButton } from "../src/ui/chat/ScrollBottomButton";
import { SendButton } from "../src/ui/chat/SendButton";
import { StopMenu } from "../src/ui/chat/StopMenu";
import { VoiceButton } from "../src/ui/chat/VoiceButton";
import { VoiceStatus } from "../src/ui/chat/VoiceStatus";
import { WaitingJump } from "../src/ui/chat/WaitingJump";

const BOTS = [
  { id: "bot-writer", name: "Writer", duties: "写东西、改东西" },
  { id: "bot-editor", name: "Editor", duties: "审稿" },
] as Bot[];

const COMMANDS: ClaudeCodeCommand[] = [
  { name: "compact", description: "Clear history but keep a summary", argument_hint: "", aliases: [] },
  { name: "review", description: "Review a pull request", argument_hint: "<pr>", aliases: [] },
];

const MODELS: ClaudeCodeModel[] = [
  { value: "gpt-5.6", display_name: "GPT-5.6", description: "The big one", resolved_model: null, efforts: ["low", "medium", "high"] },
  { value: "gpt-5.6-mini", display_name: "GPT-5.6 mini", description: "Quick", resolved_model: null, efforts: [] },
];

const QUOTED = { id: "m1", author: USER_MEMBER, body: "把周报第二段再收一收" } as unknown as Message;

export default function ChatComposer() {
  const draft = signal("");
  const sent = signal(0);
  const editable = signal(true);
  const picked = signal("—");
  const stopped = signal("—");
  const tune = signal({ account: "", model: "", effort: "" });
  const shown = signal(false);
  const jumped = signal("—");
  const sendKind = signal<ComposerAction>({ kind: "send", disabled: false });
  const quote = signal(true);
  const hasWaiting = signal(true);
  const voice = new ComposerVoice({ api: () => null, t: () => copy(), sessionId: () => "s1", markCaret: () => {}, insert: () => {} });
  return (
    <Scroll class="flex-1 bg-bg" contentStyle={{ padding: 24 }}>
      <View class="gap-4 max-w-[760px]">
        <View class="gap-1 p-3 rounded-(--radius-md) bg-pane border border-line">
          <If when={quote()}>
            <ComposerQuote message={QUOTED} botsById={new Map()} onCancel={() => quote.set(false)} />
          </If>
          <ComposerSuggestions
            suggestions={[
              { id: "a", label: "继续写第二节", prompt: "继续写第二节" },
              { id: "b", label: "换个语气", prompt: "换个更轻松的语气" },
            ]}
            onPickPrompt={(prompt) => draft.set(prompt)}
          />
          <VoiceStatus voice={voice} />
          <View class="flex-row items-end gap-2">
            <ComposerEditor
              value={draft()}
              onChange={(text) => draft.set(text)}
              placeholder="写点什么…"
              editable={editable()}
              isGroup
              mentionBots={BOTS}
              onSend={() => {
                if (!draft().trim()) return;
                sent.set(sent() + 1);
                draft.set("");
              }}
            />
            <VoiceButton voice={voice} disabled={!editable()} />
            <SendButton
              connected
              primaryAction={sendKind()}
              directStop={false}
              stepsAside={false}
              sending={false}
              upload={undefined}
              onStop={() => stopped.set("stop")}
              onSend={() => sent.set(sent() + 1)}
            />
          </View>
        </View>
        <Text testID="draft" class="text-[12px] text-ink-muted">{`draft:${draft()}`}</Text>
        <Text testID="sent" class="text-[12px] text-ink-muted">{`sent:${sent()}`}</Text>
        <View class="flex-row gap-2 flex-wrap">
          <Button testID="toggle-editable" variant="secondary" onPress={() => editable.set(!editable())}>lock</Button>
          <Button testID="send-as-stop" variant="secondary" onPress={() => sendKind.set({ kind: "stop", disabled: false })}>as stop</Button>
          <Button testID="send-disabled" variant="secondary" onPress={() => sendKind.set({ kind: "send", disabled: true })}>send disabled</Button>
          <Button testID="voice-set-recording" variant="secondary" onPress={() => ((voice.phase = "recording"), (voice.seconds = 5))}>recording</Button>
          <Button testID="voice-set-transcribing" variant="secondary" onPress={() => (voice.phase = "transcribing")}>transcribing</Button>
          <Button testID="voice-set-notice" variant="secondary" onPress={() => ((voice.phase = "idle"), (voice.notice = "没听清"))}>notice</Button>
          <Button testID="show-scroll-bottom" variant="secondary" onPress={() => shown.set(!shown())}>scroll</Button>
        </View>

        <View class="flex-row items-center gap-3">
          <StopMenu
            items={[
              { key: "bot", label: "停下 Writer" },
              { key: "global", label: "停下所有 Bot" },
            ]}
            onPick={async (item) => stopped.set(item.key)}
          />
          <Text testID="stopped" class="text-[12px] text-ink-muted">{`stopped:${stopped()}`}</Text>
        </View>

        <View class="relative h-[80px] rounded-(--radius-md) bg-pane border border-line">
          <ScrollBottomButton shown={shown()} onScrollToBottom={() => shown.set(false)} />
        </View>

        <View class="flex-row items-center gap-3">
          <WaitingJump
            hidden={{ items: hasWaiting() ? [{ id: "ap1", kind: "approval" }, { id: "ask1", kind: "ask" }] : [], above: true }}
            onJump={(id) => {
              jumped.set(id);
              hasWaiting.set(false);
            }}
          />
          <Text testID="jumped" class="text-[12px] text-ink-muted">{`jumped:${jumped()}`}</Text>
        </View>

        <View class="flex-row items-center gap-3">
          <AgentTune
            agent="codex"
            agentName="Codex"
            tune={tune()}
            models={MODELS}
            accounts={null}
            accountLocked={false}
            disabled={false}
            client={null}
            onPick={(change) => {
              picked.set(JSON.stringify(change));
              tune.set({ account: "", model: change.model ?? tune().model, effort: change.effort ?? tune().effort });
            }}
          />
          <Text testID="picked" class="text-[12px] text-ink-muted">{`picked:${picked()}`}</Text>
          <BotTune bot={BOTS[0]!} disabled={false} onPick={(change) => picked.set(JSON.stringify(change))} />
        </View>

        <ProjectCommandMenu agentName="Claude Code" status={COMMANDS} matches={COMMANDS} active={0} onHover={() => {}} onPick={(c) => picked.set(`cmd:${c.name}`)} />
      </View>
    </Scroll>
  );
}
