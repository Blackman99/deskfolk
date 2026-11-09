/** What an empty conversation shows: the file drop, the Bot of a direct with its starters, or the conversation's name (`ChatWelcome.svelte`). */
import { Text, View } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { getStarterOptions, handOffStarter } from "../../m/chat/starter-prompts";
import type { SessionGroup } from "../../m/sidebar/session-groups";
import { copy } from "../../runtime";
import { BrandMark } from "../BrandMark";
import { Icon } from "../Icon";
import { shadow } from "../styles";
import { tip } from "../tip";
import { BotFace } from "./BotFace";

export function ChatWelcome(props: {
  selected: SessionSummary;
  selectedKind: SessionGroup | null;
  selectedPeerBot: Bot | null;
  locale: "en" | "zh";
  fileDrop: boolean;
  lockedComposer: boolean;
  onOpenProfile: (botId: string) => void;
  pickStarterPrompt: (prompt: string) => void;
  titleOf: (session: SessionSummary) => string;
}) {
  const t = () => copy();
  const settingsLabel = () => (props.selectedKind === "group" ? t().top.groupSettings : t().top.botSettings);
  // The hand-off comes first: the first thing to try is handing work off, not asking a question.
  const starters = () => {
    const bot = props.selectedPeerBot;
    if (!bot) return [];
    return [
      handOffStarter(props.locale),
      ...getStarterOptions({ name: bot.name, duties: bot.duties, boundaries: bot.boundaries, locale: props.locale }),
    ];
  };

  return (
    <View testID="chat-welcome" class="items-center self-center max-w-[460px] px-[40px] py-[64px] m-auto">
      <If
        when={props.fileDrop}
        else={
          <If
            when={props.selectedKind === "you-bot" ? props.selectedPeerBot : null}
            else={
              <>
                <View class="mb-[10px]" accessible={false}>
                  <BrandMark variant="art" size={64} />
                </View>
                <Text role="header" class="mb-[6px] text-[20px] font-bold text-ink text-center">{props.titleOf(props.selected)}</Text>
              </>
            }
          >
            {(bot) => (
              <>
                <View
                  role="button"
                  testID="welcome-identity"
                  accessibilityLabel={settingsLabel()}
                  tooltip={tip(settingsLabel())}
                  onPress={() => props.onOpenProfile(bot().id)}
                  class="cursor-pointer select-none group items-center px-[16px] py-[8px] rounded-(--radius-lg) hover:bg-line-subtle"
                >
                  <View class="mb-[10px]" style={{ boxShadow: shadow("sm") }}>
                    <BotFace id={bot().id} name={bot().name} avatar={bot().avatar} size={58} border={2} letterSize={24} />
                  </View>
                  <Text class="mb-[6px] text-[18px] font-bold text-ink group-hover:text-brand">{bot().name}</Text>
                </View>
                <View class="flex-row items-center gap-[6px] mb-[24px]">
                  <View class="px-[5px] py-[1px] rounded-(--radius-xs) border border-line">
                    <Text class="text-[10px] font-semibold text-ink-muted">{t().chat.botBadge}</Text>
                  </View>
                  <If when={bot().model}>
                    {(model) => (
                      <View class="px-[6px] py-[1px] rounded-(--radius-xs) bg-chip border border-line">
                        <Text class="font-mono text-[11px] text-ink-muted">{model()}</Text>
                      </View>
                    )}
                  </If>
                </View>
                <If when={bot().duties}>
                  {(duties) => (
                    <View class="w-full mb-[14px] px-[16px] py-[10px] bg-chip border border-line rounded-(--radius-md)">
                      <Text testID="welcome-duties" class="text-[13px] text-ink-secondary text-left">{duties()}</Text>
                    </View>
                  )}
                </If>
                <If when={starters().length > 0}>
                  <View class="w-full gap-[8px] mb-[24px]">
                    <Each of={starters()} key={(s) => s.id}>
                      {(starter) => (
                        <View
                          role="button"
                          testID={`starter-${starter().id}`}
                          disabled={props.lockedComposer}
                          onPress={() => props.pickStarterPrompt(starter().prompt)}
                          class={`cursor-pointer select-none disabled:cursor-default flex-row items-center gap-[12px] pl-[10px] pr-[14px] py-[10px] rounded-(--radius-lg) bg-pane border hover:border-accent-border active:scale-[0.99] disabled:opacity-[0.5] ${
                            starter().id === "hand-off" ? "border-accent-border" : "border-line"
                          }`}
                          style={{ boxShadow: shadow("xs") }}
                        >
                          <View class={`shrink-0 w-[32px] h-[32px] rounded-(--radius-md) items-center justify-center ${starter().id === "hand-off" ? "bg-accent-tint" : "bg-line-subtle"}`}>
                            <Text class="text-[16px]">{starter().icon}</Text>
                          </View>
                          <Text class={`flex-1 min-w-0 text-[13px] text-ink ${starter().id === "hand-off" ? "font-semibold" : ""}`}>{starter().label}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
              </>
            )}
          </If>
        }
      >
        <View class="items-center justify-center w-[60px] h-[60px] mb-[14px] rounded-(--radius-lg) bg-accent-tint" accessible={false}>
          <Icon name="file" size={32} class="tint-brand" />
        </View>
        <Text role="header" class="mb-[6px] text-[20px] font-bold text-ink text-center">{t().sidebar.fileDrop}</Text>
        <Text class="text-ink-muted text-center">{t().sidebar.fileDropEmpty}</Text>
      </If>
      <Text class="text-ink-muted text-center">{t().stream.empty}</Text>
    </View>
  );
}
