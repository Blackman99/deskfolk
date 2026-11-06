/**
 * What the stage opens over the conversation: a picture enlarged, a file opened from its chip, the
 * menu of a message, and a message's text on a page of its own (a touch's way to select part of it).
 * Mounted once per stage, after the transcript and the composer.
 *
 * Not ported: the file overlay's preview (`overlays/ArtifactPreview`) is a job of its own, so the
 * frame opens with its name and ✕ and nothing inside.
 */
import { Text, View } from "nsh";
import type { Attachment, SessionSummary } from "@real-bot/protocol";
import { formatMessageTime, isAppLine } from "../../m/chat/chat-view.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { copy, runtime } from "../../runtime";
import { MarkdownBody } from "../MarkdownBody";
import { MessageContextMenu } from "./MessageContextMenu";
import { MessageFileOverlay } from "./MessageFileOverlay";
import { MessageImageLightbox } from "./MessageImageLightbox";
import { MessageTextSheet } from "./MessageTextSheet";
import type { StageActions } from "./stage-actions";
import type { StageContext } from "./stage-context";

export function StageOverlays(props: {
  ctx: StageContext;
  actions: StageActions;
  selected: SessionSummary | null;
  onOpenProfile: (botId: string) => void;
  onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;
}) {
  const t = () => copy();
  const a = () => props.actions;
  const c = () => props.ctx;
  return (
    <>
      <If when={a().shownImage()}>
        {(shown: () => NonNullable<ReturnType<StageActions["shownImage"]>>) => (
          <MessageImageLightbox
            attachment={shown().attachment}
            relpath={shown().relpath}
            origin={shown().origin}
            api={runtime.client}
            onClose={() => a().inlineImage.set(null)}
          />
        )}
      </If>
      <If when={a().shownFile()}>
        {(shown: () => NonNullable<ReturnType<StageActions["shownFile"]>>) => (
          <MessageFileOverlay attachment={shown().attachment} relpath={shown().relpath} messageId={shown().messageId} onClose={() => a().inlineFile.set(null)} />
        )}
      </If>
      <If when={a().menu()}>
        {(open: () => NonNullable<ReturnType<StageActions["menu"]>>) => (
          <MessageContextMenu
            message={open().message}
            x={open().x}
            y={open().y}
            lockedComposer={c().lockedComposer()}
            selectedText={open().selectedText}
            onClose={a().closeMenu}
            onReply={() => a().startQuoteReply(open().message)}
            onCopy={(text) => {
              a().copyMessageBody(open().message.id, text);
              // From the menu, which has closed by now: nothing on screen would say it worked.
              showToast(t().chat.copied);
            }}
            onOpenFileTree={(path) => a().openFileTree(path, open().message)}
            onShowTrace={() => a().showMessageTrace(open().message)}
            onCopyId={() => a().copyId(open().message.id)}
            onReaction={(emoji) => void runtime.toggleReaction(open().message.id, emoji)}
            onSelectText={open().touch ? () => a().textSheetId.set(open().message.id) : undefined}
            onEdit={a().editable(open().message) ? () => a().startEdit(open().message) : undefined}
            sheet={open().touch}
          />
        )}
      </If>
      <If when={a().textSheetMessage()}>
        {(shown: () => NonNullable<ReturnType<StageActions["textSheetMessage"]>>) => (
          <MessageTextSheet
            subject={`${isAppLine(shown()) ? t().chat.appName : c().who(shown())} · ${formatMessageTime(shown().created_at)}`}
            onClose={() => a().textSheetId.set(null)}
          >
            {/* As the conversation draws it: a reply or a line of yours as markdown, the rest as it is. */}
            <If
              when={shown().kind === "user" || shown().kind === "bot"}
              else={
                <View selectable>
                  <Text class="text-[14px] text-ink">{shown().body}</Text>
                </View>
              }
            >
              <MarkdownBody
                source={c().messageBody(shown())}
                options={c().markdownOpts(shown())}
                copyLabel={t().chat.copyCode}
                copiedLabel={t().chat.copied}
                onOpenArtifact={(path) => {
                  a().textSheetId.set(null);
                  props.onOpenArtifact(path, undefined, shown().id);
                }}
                onOpenImage={(path) => a().openBodyImage(shown(), path)}
                loadArtifactImage={a().loadBodyImage}
                onOpenProfile={(id) => {
                  a().textSheetId.set(null);
                  props.onOpenProfile(id);
                }}
              />
            </If>
          </MessageTextSheet>
        )}
      </If>
    </>
  );
}
