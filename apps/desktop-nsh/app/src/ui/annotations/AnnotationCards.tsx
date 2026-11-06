/**
 * The annotations a message carries, as cards (`AnnotationCards.svelte`): the file and the place,
 * the remark, the stale and resolution notes, and a badge that is the state (a button that flips
 * it when the view is not read-only). The cards live on your own bubble, so everything draws in
 * the bubble's text colour with its lines and washes.
 */
import { Text, View } from "nsh";
import type { Annotation } from "@real-bot/protocol";
import { fileIconFor } from "../../m/overlays/file-icon.ts";
import { positionLabel, resolverName, staleLabel, statusLabel } from "../../m/annotations/model.ts";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { FileIcon } from "../overlays/FileIcon";
import { tip } from "../tip";

export function AnnotationCards(props: {
  annotations: Annotation[];
  locale: "zh" | "en";
  bots: ReadonlyMap<string, { name: string }>;
  /** Open the file in the preview and go to this spot. */
  onOpen: (row: Annotation) => void;
  /** Flip a sent annotation between pending and resolved; absent when the view is read-only. */
  onToggleStatus?: (row: Annotation, status: "open" | "resolved") => void;
  /** For a batch routed into your direct: the way back to the Bot↔Bot message it came from. */
  sourceLabel?: string | null;
  onOpenSource?: () => void;
  /** Why the last status change on this batch did not go through. */
  error?: string | null;
}) {
  return (
    <View testID="annotation-cards" class="mt-[6px] gap-1">
      <If when={props.sourceLabel}>
        {(label: () => string) => (
          <View role="link" testID="annotation-source" class="self-start" onPress={() => props.onOpenSource?.()}>
            <Text class="text-[11px] text-white/90 underline">{label()}</Text>
          </View>
        )}
      </If>
      <Each of={props.annotations} key={(row: Annotation) => row.id}>
        {(row: () => Annotation) => (
          <Card row={row()} locale={props.locale} bots={props.bots} onOpen={props.onOpen} onToggleStatus={props.onToggleStatus} />
        )}
      </Each>
      <If when={props.error}>
        {(message: () => string) => (
          <Text role="alert" testID="annotation-cards-error" class="text-[11px] text-white/90 underline">{message()}</Text>
        )}
      </If>
    </View>
  );
}

type CardProps = Pick<Parameters<typeof AnnotationCards>[0], "locale" | "bots" | "onOpen" | "onToggleStatus"> & { row: Annotation };

function Card(props: CardProps) {
  const row = () => props.row;
  const stale = () => staleLabel(copy(), row(), props.locale);
  const resolver = () => resolverName(row(), props.bots, copy());
  const resolved = () => row().status === "resolved";
  const toggle = () => row().status !== "draft" && props.onToggleStatus !== undefined;
  const badgeBox = () =>
    `shrink-0 px-[7px] py-[1px] rounded-full border ${row().status === "open" ? "border-brand" : "border-white/30"} ${narrowWindow() && toggle() ? "min-h-[30px] justify-center" : ""}`;
  return (
    <View
      testID={`annotation-card-${row().id}`}
      class={`flex-row items-start gap-2 px-2 py-[6px] border border-white/22 rounded-(--radius-md) ${resolved() ? "" : "bg-white/6"}`}
    >
      <View
        role="button"
        testID="annotation-card-open"
        tooltip={tip(copy().chat.annotationOpenFile)}
        accessibilityLabel={copy().chat.annotationOpenFile}
        onPress={() => props.onOpen(row())}
        class="flex-1 min-w-0 gap-[3px]"
      >
        <View class="flex-row items-center gap-1 min-w-0">
          <FileIcon icon={fileIconFor(row().relpath)} size={16} />
          <Text class="font-mono text-[11px] text-white line-clamp-1 shrink">{row().relpath}</Text>
          <Text class="text-[11px] text-white/90 line-clamp-1 shrink-0">{`· ${positionLabel(row(), props.locale)}`}</Text>
        </View>
        <Text class="text-[12px] leading-[1.4] text-white">{row().body}</Text>
        <If when={stale()}>
          {(label: () => string) => (
            <Text testID="annotation-stale" class="self-start text-[10px] text-white/90 px-[7px] border border-dashed border-white/30 rounded-full">
              {label()}
            </Text>
          )}
        </If>
        <If when={resolved() && (resolver() || row().resolved_note)}>
          <Text class="text-[11px] text-white/90">
            {`${resolver() ? copy().stream.annotationResolvedBy(resolver()!) : ""}${row().resolved_note ? `${resolver() ? "：" : ""}${row().resolved_note}` : ""}`}
          </Text>
        </If>
      </View>
      <If
        when={toggle()}
        else={
          <View testID="annotation-badge" class={badgeBox()}>
            <Text class={`text-[10px] text-white ${row().status === "open" ? "font-semibold" : ""}`}>{statusLabel(copy(), row().status)}</Text>
          </View>
        }
      >
        <View
          role="button"
          testID="annotation-toggle"
          tooltip={tip(row().status === "open" ? copy().stream.annotationResolve : copy().stream.annotationReopen)}
          onPress={() => props.onToggleStatus?.(row(), row().status === "open" ? "resolved" : "open")}
          class={`${badgeBox()} hover:bg-white/10`}
        >
          <Text class={`text-[10px] text-white ${row().status === "open" ? "font-semibold" : ""}`}>{statusLabel(copy(), row().status)}</Text>
        </View>
      </If>
    </View>
  );
}
