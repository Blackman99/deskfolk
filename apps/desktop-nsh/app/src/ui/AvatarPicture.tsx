/**
 * A stored avatar as a picture filling its box: a folk drawn from its layers (a native SVG draws no
 * embedded images, so the folk's own SVG would come out empty), any other SVG or image from its
 * source. `onError` says the source failed to load, so the caller can fall back to a letter.
 */
import { Image } from "nsh";
import { avatarSrc, isFolkAvatar } from "../m/avatar";
import { FolkAvatar } from "./FolkAvatar";
import type { FolkMotion } from "../m/folk-motion";

export function AvatarPicture(props: {
  avatar: string | null | undefined;
  motion?: FolkMotion;
  alt?: string;
  onError?: () => void;
  testID?: string;
}) {
  const src = () => avatarSrc(props.avatar);
  return (
    <If
      when={isFolkAvatar(props.avatar)}
      else={
        <If when={src()}>
          {(uri) => (
            <Image
              testID={props.testID}
              src={uri()}
              accessibilityLabel={props.alt}
              onError={() => props.onError?.()}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          )}
        </If>
      }
    >
      <FolkAvatar testID={props.testID} avatar={props.avatar ?? ""} motion={props.motion} />
    </If>
  );
}
