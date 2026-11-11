/**
 * A Bot's face at one size, as the chat's chips, welcome and header draw it: a folk stands on its own
 * (no disc, no ring, nothing clipped, acting out `motion`), a stored picture fills a rounded square,
 * and with none the Bot's letter on its palette. A helper of this folder, not a messenger component.
 */
import { Text, View } from "nsh";
import { botAvatarColor, avatarSrc, isFolkAvatar } from "../../m/avatar";
import type { FolkMotion } from "../../m/folk-motion";
import { rosterLetter } from "../../m/sidebar/roster-letter";
import { AvatarPicture } from "../AvatarPicture";
import { cssColor } from "../styles";

export function BotFace(props: {
  id: string;
  name?: string | null;
  avatar?: string | null;
  size: number;
  motion?: FolkMotion;
  /** The ring's width (the letter and picture faces). */
  border?: number;
  /** The letter's size in points. */
  letterSize?: number;
  testID?: string;
}) {
  const folk = () => isFolkAvatar(props.avatar);
  const pal = () => botAvatarColor(props.id);
  return (
    <View
      testID={props.testID}
      accessible={false}
      class="items-center justify-center shrink-0"
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size * 0.3,
        overflow: folk() ? "visible" : "hidden",
        borderWidth: folk() ? 0 : (props.border ?? 1),
        backgroundColor: folk() ? "transparent" : cssColor(pal().bg),
        borderColor: cssColor(pal().border),
      }}
    >
      <If
        when={folk() || avatarSrc(props.avatar)}
        else={
          <Text class="font-bold" style={{ fontSize: props.letterSize ?? props.size * 0.5, color: cssColor(pal().text) }}>
            {rosterLetter(props.name ?? "?")}
          </Text>
        }
      >
        <AvatarPicture avatar={props.avatar} motion={props.motion} alt={props.name ?? undefined} />
      </If>
    </View>
  );
}
