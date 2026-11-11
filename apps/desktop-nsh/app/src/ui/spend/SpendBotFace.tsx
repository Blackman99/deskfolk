/**
 * A Bot's face beside its figures (`SpendBotFace.svelte`). The roster gives the picture; a Bot gone
 * from it (deleted) keeps the first letter of the name the ledger kept, greyed. No Bot at all is a
 * dashed blank.
 */
import { signal, Text, token, View } from "nsh";
import type { Bot } from "@real-bot/protocol";
import { avatarSrc, botAvatarColor, isFolkAvatar } from "../../m/avatar";
import { rosterLetter } from "../../m/sidebar/roster-letter";
import { AvatarPicture } from "../AvatarPicture";
import { cssColor } from "../styles";

export function SpendBotFace(props: {
  id: string | null;
  /** The name the ledger kept, for a Bot the roster no longer has. */
  name?: string | null;
  bot?: Bot | null;
  size?: number;
  testID?: string;
}) {
  const size = () => props.size ?? 22;
  const src = () => avatarSrc(props.bot?.avatar);
  const folk = () => isFolkAvatar(props.bot?.avatar);
  const palette = () => (props.id ? botAvatarColor(props.id) : null);
  const failed = signal<string | null>(null);
  const picture = () => Boolean(src()) && failed() !== src();
  const bare = () => props.id == null;
  return (
    <View
      testID={props.testID}
      accessible={false}
      class="items-center justify-center shrink-0"
      style={{
        width: size(),
        height: size(),
        borderRadius: size() * 0.3,
        overflow: picture() && folk() ? "visible" : "hidden",
        opacity: props.id != null && !props.bot ? 0.7 : 1,
        borderWidth: bare() ? 1 : 0,
        borderStyle: bare() ? "dashed" : undefined,
        borderColor: bare() ? token("line") : undefined,
        backgroundColor: bare() || (picture() && folk()) ? "transparent" : props.bot && !folk() && palette() ? cssColor(palette()!.bg) : token("line-subtle"),
      }}
    >
      <If
        when={picture()}
        else={
          <If when={props.id != null}>
            <Text
              class="font-semibold"
              style={{ fontSize: Math.round(size() * 0.5), color: props.bot && palette() ? cssColor(palette()!.text) : token("ink-muted") }}
            >
              {rosterLetter(props.bot?.name ?? props.name ?? "")}
            </Text>
          </If>
        }
      >
        <AvatarPicture avatar={props.bot?.avatar} onError={() => failed.set(src())} />
      </If>
    </View>
  );
}
