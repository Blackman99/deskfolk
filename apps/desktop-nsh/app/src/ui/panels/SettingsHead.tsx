/**
 * The head of a conversation's settings (`SettingsHead.svelte`), in the narrow drawer and beside a
 * workbench pane alike. `nested` is a Bot opened from a group's settings: on a phone its way out is
 * the conversation, a wider window steps back to the group's settings. On a phone the page fills
 * the screen, so the head says whose settings these are.
 */
import { Text, View } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import type { GroupDetailDraft } from "../../m/panels/group-edit";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { GroupIdentity } from "./GroupIdentity";
import { SettingsSubject } from "./SettingsSubject";

export function SettingsHead(props: {
  group: boolean;
  /** A Bot opened from a group's settings. */
  nested: boolean;
  onBack: () => void;
  onClose: () => void;
  groupSession?: SessionSummary | null;
  subjectBot?: Bot | null;
  subjectSession?: SessionSummary | null;
  /** A phone's screen fills with one section at a time; a wider window keeps them beside it. */
  narrow: boolean;
  botsById: ReadonlyMap<string, Bot>;
  detail: GroupDetailDraft;
  onDetailChange: (detail: GroupDetailDraft) => void;
}) {
  const backText = () => (props.group ? copy().detail.backToGroup : copy().detail.backToBot);
  return (
    <View testID="settings-head" class="flex-row items-center justify-between gap-2 mb-[14px]">
      <If
        when={props.nested}
        else={
          <If
            when={props.group && props.groupSession ? props.groupSession : null}
            else={
              <If
                when={props.narrow && (props.subjectBot || props.subjectSession)}
                else={
                  <View class="flex-row items-center gap-5">
                    <View class="w-[28px] h-[28px] rounded-(--radius-sm) bg-accent-tint border border-accent-border items-center justify-center">
                      <Icon name="settings" class="tint-brand" />
                    </View>
                    <Text role="header" class="text-[16px] font-bold text-ink">{copy().detail.titleBot}</Text>
                  </View>
                }
              >
                <SettingsSubject
                  variant="head"
                  bot={props.subjectBot}
                  session={props.subjectBot ? null : props.subjectSession}
                  bots={props.botsById}
                  caption={copy().detail.titleBot}
                />
              </If>
            }
          >
            {(session) => <GroupIdentity session={session()} detail={props.detail} onDetailChange={props.onDetailChange} />}
          </If>
        }
      >
        <View
          role="button"
          testID="sheet-back"
          accessibilityLabel={props.narrow ? copy().common.back : backText()}
          onPress={() => props.onBack()}
          class={`flex-row items-center justify-start rounded-(--radius-sm) hover:bg-accent-tint ${props.narrow ? "w-[44px] h-[44px] justify-center rounded-(--radius-md)" : "flex-1 min-w-0 gap-[6px] px-[6px] py-1"}`}
        >
          <Icon name="chevron-left" size={20} class="tint-brand" />
          <If when={!props.narrow}>
            <Text class="text-[13px] font-semibold text-brand">{backText()}</Text>
          </If>
        </View>
        <If when={props.narrow && props.subjectBot ? props.subjectBot : null}>
          {(bot) => <SettingsSubject variant="head" bot={bot()} caption={copy().detail.titleBot} />}
        </If>
      </If>
      <IconButton testID="sheet-close" icon="x" size="sm" label={copy().common.close} onPress={() => props.onClose()} />
    </View>
  );
}
