/**
 * A Bot's avatar editor (`AvatarEditor.svelte`): a round preview, Randomize, a style, an upload, and
 * one chip per generated style. A generated avatar follows the Bot's name until the user uploads
 * a picture of their own; an upload comes from the system's picker, scaled to 256 points on its
 * longer side and kept when it fits the Bot record.
 *
 * `bind:avatar` is `avatar` + `onAvatarChange`; `onchange` (a change the user made, for the form's
 * dirty state) is `onChange`. The copy is `copy()`'s, not a `t` prop.
 */
import { Picker, Text, View, effect, signal } from "nsh";
import {
  AVATAR_MAX_DATA_URI_CHARS,
  AVATAR_MAX_EDGE,
  BORING_AVATAR_VARIANTS,
  avatarEditorPrimaryActions,
  avatarSrc,
  boringAvatarName,
  classifyAvatarFile,
  followGeneratedAvatar,
  generateBoringAvatar,
  generatedAvatarVariant,
  isCustomAvatar,
  mimeFromAvatarFile,
  type AvatarImageError,
  type BoringAvatarVariant,
} from "../m/avatar";
import { copy } from "../runtime";
import { AvatarPicture } from "./AvatarPicture";
import { Button } from "./Button";
import { shadow } from "./styles";
import { tip } from "./tip";

const VARIANT_LABELS: Record<BoringAvatarVariant, { zh: string; en: string }> = {
  folk: { zh: "布丁", en: "Pudding" },
  beam: { zh: "表情", en: "Beam" },
  marble: { zh: "大理石", en: "Marble" },
  pixel: { zh: "像素", en: "Pixel" },
  sunset: { zh: "日落", en: "Sunset" },
  bauhaus: { zh: "包豪斯", en: "Bauhaus" },
  ring: { zh: "环形", en: "Ring" },
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Base64 of bytes (the engine has no `btoa` to lean on). */
export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
  }
  return out;
}

/** Picks an image through the system's picker and returns it as the data URI a Bot record keeps. */
async function pickAvatarDataUri(): Promise<{ ok: true; dataUri: string } | { ok: false; error: AvatarImageError } | null> {
  let picked;
  try {
    picked = await Picker.pickImages({ multiple: false, maxDimension: AVATAR_MAX_EDGE, quality: 0.85 });
  } catch {
    return { ok: false, error: "decode" };
  }
  const file = picked[0]?.file;
  if (!file) return null;
  const classified = classifyAvatarFile(file);
  if (classified) return { ok: false, error: classified };
  try {
    const dataUri = `data:${mimeFromAvatarFile(file)};base64,${base64(new Uint8Array(await file.arrayBuffer()))}`;
    return dataUri.length > AVATAR_MAX_DATA_URI_CHARS ? { ok: false, error: "size" } : { ok: true, dataUri };
  } catch {
    return { ok: false, error: "decode" };
  }
}

export function AvatarEditor(props: {
  name: string;
  avatar: string | null | undefined;
  onAvatarChange?: (avatar: string) => void;
  /** The user changed the avatar. */
  onChange?: () => void;
}) {
  const initial = generatedAvatarVariant(props.avatar) ?? "folk";
  // Start from the style the avatar was drawn in, so Randomize keeps it; a new Bot starts on the folk.
  const variant = signal<BoringAvatarVariant>(initial);
  const seed = signal(0);
  const uploadError = signal<AvatarImageError | null>(null);
  const uploading = signal(false);
  let lastGenerated = "";
  const customMode = () => isCustomAvatar(props.avatar);

  const set = (next: string) => props.onAvatarChange?.(next);

  effect(() => {
    if (customMode()) return;
    const planned = followGeneratedAvatar({ name: props.name, variant: variant(), salt: seed(), current: props.avatar, lastGenerated });
    lastGenerated = planned.lastGenerated;
    if (planned.changed) {
      set(planned.avatar);
      props.onChange?.();
    }
  });

  function applyGenerated(nextVariant: BoringAvatarVariant = variant(), nextSeed = seed()): void {
    uploadError.set(null);
    const next = generateBoringAvatar({ name: boringAvatarName(props.name, nextSeed), variant: nextVariant });
    lastGenerated = next;
    set(next);
    props.onChange?.();
  }

  function randomize(): void {
    seed.set(seed() + 1);
    applyGenerated(variant(), seed());
  }

  function pickVariant(v: BoringAvatarVariant): void {
    variant.set(v);
    applyGenerated(v, seed());
  }

  async function upload(): Promise<void> {
    if (uploading()) return;
    uploading.set(true);
    uploadError.set(null);
    const result = await pickAvatarDataUri();
    uploading.set(false);
    if (!result) return;
    if (!result.ok) {
      uploadError.set(result.error);
      return;
    }
    set(result.dataUri);
    props.onChange?.();
  }

  const errorCopy = (error: AvatarImageError) => {
    const t = copy();
    return error === "type" ? t.sidebar.botAvatarInvalidType : error === "size" ? t.sidebar.botAvatarTooLarge : t.sidebar.botAvatarDecodeFailed;
  };

  /** What the circle shows: the avatar, or what the name would be drawn as while it is empty. */
  const shown = () => (avatarSrc(props.avatar) ? props.avatar : generateBoringAvatar({ name: boringAvatarName(props.name), variant: variant() }));
  const actions = () => avatarEditorPrimaryActions(customMode() ? "custom" : "generated");

  const preview = () => (
    <View
      class="w-[56px] h-[56px] rounded-full overflow-hidden border-2 border-line bg-chip items-center justify-center shrink-0"
      style={{ boxShadow: shadow("xs") }}
    >
      <AvatarPicture avatar={shown()} alt={props.name || "Bot avatar"} testID="avatar-editor-img" />
    </View>
  );

  return (
    <View class="mb-[12px]" testID="avatar-editor">
      <View class="flex-row items-center gap-[28px]">
        <If when={customMode()} else={preview()}>
          <View
            role="button"
            testID="avatar-editor-upload"
            tooltip={tip(copy().sidebar.botAvatarCustom)}
            accessibilityLabel={copy().sidebar.botAvatarCustom}
            disabled={uploading()}
            onPress={() => void upload()}
            class="cursor-pointer select-none disabled:cursor-default rounded-full hover:opacity-90 disabled:opacity-[0.6]"
          >
            {preview()}
          </View>
        </If>
        <View class="flex-1 min-w-0 gap-[12px]">
          <View class="flex-row items-center gap-[16px]">
            <Each of={actions()}>
              {(action) => (
                <If
                  when={action() === "randomize"}
                  else={
                    <If
                      when={action() === "style"}
                      else={
                        <Button size="sm" testID="avatar-editor-custom" disabled={uploading()} onPress={() => void upload()}>
                          {copy().sidebar.botAvatarCustom}
                        </Button>
                      }
                    >
                      <Button size="sm" testID="avatar-editor-style" onPress={() => applyGenerated()}>
                        {copy().sidebar.botAvatarStyle}
                      </Button>
                    </If>
                  }
                >
                  <Button size="sm" testID="avatar-editor-randomize" onPress={randomize}>
                    {`🎲 ${copy().sidebar.botAvatarRefresh}`}
                  </Button>
                </If>
              )}
            </Each>
          </View>
          <If
            when={!customMode()}
            else={<Text class="text-[11px] text-ink-muted">{copy().sidebar.botAvatarCustomHint}</Text>}
          >
            <View class="flex-row flex-wrap gap-[8px]">
              <Each of={[...BORING_AVATAR_VARIANTS]}>
                {(v) => (
                  <View
                    role="button"
                    testID={`avatar-variant-${v()}`}
                    accessibilityState={{ selected: variant() === v() }}
                    onPress={() => pickVariant(v())}
                    class={`cursor-pointer select-none px-[7px] py-[2px] rounded-(--radius-lg) border ${variant() === v() ? "bg-ink border-ink" : "border-line hover:border-line-hover"}`}
                  >
                    <Text class={`text-[11px] ${variant() === v() ? "font-semibold text-pane" : "text-ink-muted"}`}>
                      {copy().common.you === "你" ? VARIANT_LABELS[v()].zh : VARIANT_LABELS[v()].en}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={uploadError()}>{(error) => <Text class="text-[12px] text-danger">{errorCopy(error())}</Text>}</If>
        </View>
      </View>
    </View>
  );
}
