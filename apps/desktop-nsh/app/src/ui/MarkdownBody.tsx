/**
 * A message's text, Markdown drawn natively (`MarkdownBody.svelte`): `TextView` reads it, with the
 * messenger's look (`.md-body`: 14px at 1.55, code on its wash, tables with lines, quotes with a
 * bar). A file the text names is a chip — its kind's icon and its name on a wash of the accent, a
 * picture a card with its thumbnail once it is fetched — and a Bot it names is a chip with its
 * letter; pressing one opens the file, the picture or the profile. Other links open outside. A
 * picture's chip has the magnifier and hands its thumbnail to the enlargement, which grows out of it.
 *
 * `inverted` is your own bubble: light text on the accent.
 *
 * Code blocks take the messenger's Shiki colours (`code-colors.tsx`): a `CodeColors` around the
 * view colours them natively, in GitHub's light and dark or the code theme your interface chose,
 * which also brings its surface. Your own bubble keeps its code white on its wash, as before.
 */
import { cleanup, computed, Image, openUrl, signal, Text, View, type JSX, type ViewRef } from "nsh";
import { TextView } from "nsh/base";
import { CodeColors } from "deskfolk/native";
import { artifactKind, svgDisplayBlob } from "../m/overlays/artifacts.ts";
import { fileIconFor } from "../m/overlays/file-icon.ts";
import { botAvatarColor } from "../m/avatar.ts";
import { rosterLetter } from "../m/sidebar/roster-letter.ts";
import { codeColorsAvailable, codeSurface, codeThemes } from "./code-colors";
import { blobDataUrl } from "./data-url";
import type { PressedPicture } from "./chat/image-origin";
import { linkTarget, prepareMarkdown, unresolvedToken, type RenderMarkdownOptions } from "./markdown";
import { FileIcon } from "./overlays/FileIcon";
import { cssColor } from "./styles";
import { tip } from "./tip";

export type { RenderMarkdownOptions };

const EXTENSIONS = [
  { name: "artifact", tag: "artifact" },
  { name: "mention", tag: "mention" },
];

const isPicture = (path: string) => ["image", "svg"].includes(artifactKind(path));
const baseName = (path: string) => path.split("/").pop() || path;

export function MarkdownBody(props: {
  source: string;
  options?: RenderMarkdownOptions;
  /** The code blocks' copy button. */
  copyLabel: string;
  /** Kept for parity: NSH's copy button shows its own check once copied. */
  copiedLabel?: string;
  /** Your own bubble: light text on the accent fill. */
  inverted?: boolean;
  class?: string;
  onOpenArtifact?: (relpath: string) => void;
  /** A picture stays in the app. `from` is its chip's thumbnail, when it was pressed on one. */
  onOpenImage?: (relpath: string, from?: PressedPicture) => void;
  /** Bytes for a picture's chip. `signal` aborts once this text is gone. */
  loadArtifactImage?: (relpath: string, signal: AbortSignal) => Promise<Blob>;
  /** Files shown elsewhere (the message's cards): a line that is only one of them is left out. */
  hideStandaloneArtifactLinks?: string[];
  onOpenProfile?: (botId: string) => void;
  /**
   * Text can be selected and copied (default true): the text is a selection area of its own. False
   * inside an outer `<View selectable>` still selects, as part of that area, and leaves a right click
   * to the area's `onContextMenu` rather than NSH's Copy menu (`workbench/pane-menu.ts`).
   */
  selectable?: boolean;
  testID?: string;
  children?: JSX.Element;
}) {
  const markdown = () => prepareMarkdown(props.source, props.options ?? {}, props.hideStandaloneArtifactLinks ?? []);
  const loads = new AbortController();
  cleanup(() => loads.abort());

  function openArtifact(path: string, from?: PressedPicture): void {
    if (props.onOpenImage && isPicture(path)) props.onOpenImage(path, from);
    else props.onOpenArtifact?.(path);
  }

  function onLink(url: string): void {
    const target = linkTarget(url);
    if (target.kind === "mention") {
      if (target.id !== "everyone" && !unresolvedToken(target.id)) props.onOpenProfile?.(target.id);
      return;
    }
    if (target.kind === "artifact") {
      openArtifact(target.path);
      return;
    }
    if (/^(https?|mailto):/i.test(target.url)) void openUrl(target.url).catch(() => undefined);
  }

  const inv = () => props.inverted === true;
  /** The code colours in force: a new pair makes the view again, which reads them as it is made. */
  const themes = computed(() => codeThemes("chat"), { equals: (a, b) => a.light === b.light && a.dark === b.dark });
  const surface = () => (inv() ? null : codeSurface());

  const view = () => (
    <TextView
      markdown={markdown()}
      options={{ streaming: props.options?.streaming === true, math: false }}
      extensions={EXTENSIONS}
      selectable={props.selectable !== false}
      codeBlockActions={[{ id: "copy", label: props.copyLabel }]}
      onLinkPress={(e) => onLink(e.url)}
      renderCustom={(node) =>
        node.name === "artifact" ? (
          <ArtifactChip
            path={node.attributes?.path ?? ""}
            label={node.text ?? ""}
            inverted={inv()}
            load={props.loadArtifactImage}
            signal={loads.signal}
            onPress={openArtifact}
          />
        ) : node.name === "mention" ? (
          <MentionChip
            id={node.attributes?.id ?? ""}
            label={node.text ?? ""}
            inverted={inv()}
            unresolvedTitle={props.options?.unresolvedMentionTitle}
            onPress={(id) => props.onOpenProfile?.(id)}
          />
        ) : (
          <Text>{node.text ?? ""}</Text>
        )
      }
      classes={{
        root: `text-[14px] leading-[1.55] ${inv() ? "text-white" : "text-ink"}`,
        heading: "font-bold leading-[1.3] mt-[9px] mb-[4px]",
        heading1: "text-[17px]",
        heading2: "text-[15px]",
        heading3: "text-[14px]",
        heading4: "text-[14px]",
        heading5: "text-[14px]",
        heading6: "text-[14px]",
        blockquote: `border-l-[3px] pl-[11px] ${inv() ? "border-white/45 text-white/85" : "border-line text-ink-muted"}`,
        rule: `border-t my-[9px] ${inv() ? "border-white/35" : "border-line"}`,
        link: inv() ? "text-white underline" : "text-brand underline hover:text-accent-hover",
        code: `font-mono text-[12px] rounded-(--radius-xs) px-[4px] ${inv() ? "bg-white/12" : "bg-inline-code-bg border border-inline-code-border"}`,
        codeBlock: `rounded-(--radius-sm) border ${inv() ? "bg-[rgba(18,28,32,0.28)] border-white/20" : "bg-chip border-line"}`,
        codeBlockCode: `font-mono text-[12px] leading-[1.45] ${inv() ? "text-white" : "text-ink"}`,
        table: "text-[13px]",
        tableCell: `border px-[10px] py-[6px] leading-[1.45] ${inv() ? "border-white/35" : "border-line"}`,
        tableHeaderCell: `font-semibold ${inv() ? "bg-white/12" : "bg-line-subtle"}`,
      }}
      styles={surface() ? { codeBlock: { backgroundColor: surface()!.bg }, codeBlockCode: { color: surface()!.fg } } : undefined}
    />
  );

  return (
    <View testID={props.testID} class={`min-w-0 ${props.class ?? ""}`}>
      {codeColorsAvailable() && !inv() ? (
        <Each of={[themes()]} key={(pair) => `${pair.light} ${pair.dark}`}>
          {(pair) => (
            <CodeColors class="min-w-0" light={pair().light} dark={pair().dark}>
              {view()}
            </CodeColors>
          )}
        </Each>
      ) : (
        view()
      )}
      {props.children}
    </View>
  );
}

/** A file the text names (`a.md-artifact-link`), or a picture's card (`a.md-artifact-image`). */
function ArtifactChip(props: {
  path: string;
  label: string;
  inverted: boolean;
  load?: (relpath: string, signal: AbortSignal) => Promise<Blob>;
  signal: AbortSignal;
  onPress: (path: string, from?: PressedPicture) => void;
}) {
  const picture = () => Boolean(props.load) && isPicture(props.path);
  /** The thumbnail: `null` loading, a URL loaded, `false` failed (a plain chip then). */
  const thumb = signal<string | null | false>(null);
  /** The thumbnail's view (its grey box while it loads): the enlargement grows out of it, as the Svelte's grows out of the `img`. */
  let picView: ViewRef | null = null;
  const pressed = (): PressedPicture => ({ view: picView, shown: typeof thumb() === "string" ? (thumb() as string) : null });
  // The label is the path itself when the text wrote the path: the chip shows the file's name.
  const name = () => (props.label.trim() === props.path ? baseName(props.path) : props.label);
  if (picture()) {
    void props.load!(props.path, props.signal)
      .then((blob) => (artifactKind(props.path) === "svg" ? svgDisplayBlob(blob) : blob))
      .then(blobDataUrl)
      .then((url) => thumb.set(url))
      .catch(() => thumb.set(false));
  }
  return (
    <If
      when={picture() && thumb() !== false}
      else={
        <View
          role="link"
          testID="md-artifact-link"
          accessibilityLabel={props.path}
          tooltip={tip(props.path)}
          onPress={() => props.onPress(props.path)}
          style={{ verticalAlign: "middle" }}
          class={`cursor-pointer flex-row items-center gap-1 px-[7px] py-[2px] mx-[1px] rounded-(--radius-sm) border ${props.inverted ? "bg-white/18 border-white/35 hover:bg-white/28" : "bg-brand/7 border-brand/17 hover:bg-accent-tint hover:border-accent-border"}`}
        >
          <FileIcon icon={fileIconFor(props.path)} size={12} />
          <Text class={`cursor-pointer text-[13px] ${props.inverted ? "text-white" : "text-accent-hover"}`}>{name()}</Text>
        </View>
      }
    >
      <View
        role="link"
        testID="md-artifact-image"
        accessibilityLabel={props.path}
        tooltip={tip(props.path)}
        onPress={() => props.onPress(props.path, pressed())}
        style={{ verticalAlign: "middle" }}
        class={`cursor-zoom-in flex-row items-center gap-2 max-w-[240px] p-[5px] my-[2px] rounded-(--radius-md) border ${props.inverted ? "bg-white/14 border-white/30 hover:border-white/70" : "bg-pane border-line hover:border-brand"}`}
      >
        <If when={thumb()} else={<View ref={(n: ViewRef) => (picView = n)} class="w-[72px] h-[54px] rounded-[6px] bg-line-subtle shrink-0" />}>
          {(url: () => string | null | false) => <Image ref={(n: ViewRef) => (picView = n)} src={url() as string} class="w-[72px] h-[54px] rounded-[6px] shrink-0" style={{ objectFit: "cover" }} accessibilityLabel={name()} />}
        </If>
        <Text class={`cursor-zoom-in min-w-0 shrink text-[13px] line-clamp-1 ${props.inverted ? "text-white" : "text-ink-secondary"}`}>{name()}</Text>
      </View>
    </If>
  );
}

/** A Bot the text names (`.md-mention-chip`): its letter on its colour, then `@name`. */
function MentionChip(props: { id: string; label: string; inverted: boolean; unresolvedTitle?: string; onPress: (id: string) => void }) {
  const unresolved = () => unresolvedToken(props.id);
  const everyone = () => props.id === "everyone";
  const name = () => props.label.replace(/^@/, "");
  const palette = () => botAvatarColor(props.id);
  return (
    <If
      when={unresolved() === null}
      else={
        <Text
          class="text-ink-muted border-b border-dashed border-ink-muted"
          tooltip={props.unresolvedTitle ? tip(props.unresolvedTitle) : undefined}
        >{`@${unresolved()}`}</Text>
      }
    >
      <View
        role={everyone() ? undefined : "link"}
        testID="md-mention-chip"
        accessibilityLabel={`@${name()}`}
        onPress={everyone() ? undefined : () => props.onPress(props.id)}
        style={{ verticalAlign: "middle" }}
        class={`${everyone() ? "" : "cursor-pointer "}flex-row items-center gap-1 pl-[3px] pr-[7px] py-[1px] mx-[1px] rounded-full border ${props.inverted ? "bg-white/12 border-white/35 hover:bg-white/20" : "bg-accent-tint border-accent-border hover:bg-accent-border"}`}
      >
        <If
          when={!everyone()}
          else={<Text class="text-[12px] leading-none">👥</Text>}
        >
          <View
            class="w-[16px] h-[16px] rounded-full items-center justify-center border"
            style={{ backgroundColor: cssColor(palette().bg), borderColor: cssColor(palette().border) }}
          >
            <Text class="cursor-pointer text-[10px] font-bold leading-none" style={{ color: cssColor(palette().text) }}>
              {rosterLetter(name()) || "?"}
            </Text>
          </View>
        </If>
        <Text class={`${everyone() ? "" : "cursor-pointer "}text-[13px] font-semibold leading-[1.2] ${props.inverted ? "text-white" : "text-accent-hover"}`}>{`@${name()}`}</Text>
      </View>
    </If>
  );
}
