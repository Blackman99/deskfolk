/**
 * Whose settings a screen is showing (`SettingsSubject.svelte`). On a phone every settings screen
 * fills it, so the drawer's head carries the name large (`head`) and a section or an editor two
 * levels in carries it as a line under its own title (`line`).
 */
import { Text, View, signal } from "nsh";
import type { Bot, SessionSummary } from "@real-bot/protocol";
import { avatarSrc, botAvatarColor, isFolkAvatar } from "../../m/avatar";
import { rosterLetter } from "../../m/sidebar/roster-letter";
import { sessionTitle } from "../../m/sidebar/session-title";
import { copy } from "../../runtime";
import { AvatarPicture } from "../AvatarPicture";
import { SessionAvatar } from "../SessionAvatar";
import { cssColor } from "../styles";

export function SettingsSubject(props: {
  /** One Bot's settings: a you↔Bot conversation's, or a Bot opened from a group. */
  bot?: Bot | null;
  /** A conversation's own settings: a group, or a Bot↔Bot direct. */
  session?: SessionSummary | null;
  bots?: ReadonlyMap<string, Bot>;
  /** `head` stands in for the drawer's title; `line` sits under a page's own title. */
  variant: "head" | "line";
  /** Under the name in the head: what these settings are. */
  caption?: string;
}) {
  const head = () => props.variant === "head";
  const name = () =>
    props.bot
      ? props.bot.name
      : props.session
        ? sessionTitle(props.session, props.bots ?? new Map(), { deleted: copy().top.deleted, archived: copy().top.archived })
        : "";
  const failedSrc = signal<string | null>(null);
  const edge = () => (head() ? 36 : 18);
  return (
    <View testID="settings-subject" class={`flex-row items-center min-w-0 ${head() ? "flex-1 gap-3" : "gap-[6px]"}`}>
      <If
        when={props.bot ? props.bot : null}
        else={
          <If when={props.session}>
            {(session) => (
              <SessionAvatar session={session()} bots={props.bots ?? new Map()} size={head() ? "top" : "tab"} ringColor={cssColor("var(--pane)")} />
            )}
          </If>
        }
      >
        {(bot) => {
          const colors = () => botAvatarColor(bot().id);
          const folk = () => isFolkAvatar(bot().avatar);
          return (
            <View
              class="items-center justify-center overflow-hidden border shrink-0"
              style={{
                width: edge(),
                height: edge(),
                borderRadius: edge() * 0.3,
                backgroundColor: folk() ? "transparent" : cssColor(colors().bg),
                borderColor: folk() ? "transparent" : cssColor(colors().border),
              }}
            >
              <If
                when={folk() || (avatarSrc(bot().avatar) && failedSrc() !== avatarSrc(bot().avatar))}
                else={<Text class="font-bold" style={{ fontSize: edge() * 0.38, color: cssColor(colors().text) }}>{rosterLetter(bot().name)}</Text>}
              >
                <AvatarPicture avatar={bot().avatar} onError={() => failedSrc.set(avatarSrc(bot().avatar))} />
              </If>
            </View>
          );
        }}
      </If>
      <View class="flex-col gap-[1px] min-w-0">
        <If
          when={head()}
          else={<Text testID="settings-subject-name" class="text-[13px] font-medium text-ink-muted line-clamp-1">{name()}</Text>}
        >
          <Text testID="settings-subject-name" role="header" class="text-[15px] font-bold text-ink line-clamp-1">{name()}</Text>
          <If when={props.caption}>
            <Text class="text-[12px] font-medium text-ink-muted">{props.caption}</Text>
          </If>
        </If>
      </View>
    </View>
  );
}
