/**
 * Annotating's own row, where the toolbar used to be (`ArtifactAnnotBar.svelte`): the how-to line,
 * the resolved toggle, source / rendered, annotate mode, the list, and a compact download. The
 * row shows only while one of those applies; on a phone a bar that would hold only the download
 * stays away, as does the download itself (the phone downloads from its own bar).
 *
 * `bind:checked` of the resolved box writes `annot.annotShowResolved` directly, as the Svelte's
 * binding did. The download's note is `loader.downloadNote`.
 */
import { Text, View } from "nsh";
import type { Attachment } from "@real-bot/protocol";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { ArtifactAnnotations } from "../../m/overlays/artifact-annotations.svelte.ts";
import type { ArtifactLoader } from "../../m/overlays/artifact-loader.svelte.ts";
import type { artifactByteSource } from "../../m/overlays/artifacts.ts";
import { copy } from "../../runtime";
import { Checkbox } from "../Checkbox";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { FileDownload } from "./FileDownload";

export function ArtifactAnnotBar(props: {
  api: MessengerApi | null;
  mode: "cited" | "workspace";
  relpath: string;
  attachment: Attachment | null;
  byteSource: ReturnType<typeof artifactByteSource>;
  titleName: string;
  downloadKey: string;
  canDownload: boolean;
  showAnnotToggle: boolean;
  showAnnotMode: boolean;
  annotHint: "" | "dirty" | "no-target" | "no-agent-line" | "streamed" | null;
  /** Said in the hint's place: why this file is read-only, or shown as source. */
  fileNotice: string | null;
  showSourceToggle: boolean;
  hasResolved: boolean;
  showSource: boolean;
  toggleSource: () => void;
  annot: ArtifactAnnotations;
  loader: ArtifactLoader;
  /** The phone's header already carries the download. */
  hideDownload?: boolean;
}) {
  const t = () => copy().stream;
  const other = () => props.showAnnotToggle || props.showAnnotMode || props.annotHint !== null || props.fileNotice !== null || props.showSourceToggle;
  const visible = () => other() || props.canDownload;
  const btnHeight = () => (narrowWindow() ? "h-[32px]" : "h-[26px]");
  const hint = () => {
    const h = props.annotHint;
    if (h === "no-agent-line") return t().annotationNoAgentLine;
    return h === "dirty" ? t().annotationDirtyHint : h === "no-target" ? t().annotationNoTarget : h === "streamed" ? t().annotationStreamedHint : t().annotationAddHint;
  };

  return (
    <If when={visible() && !(narrowWindow() && !other())}>
      <View testID="artifact-annot-bar" class="flex-row items-center gap-2 min-h-[38px] px-3 py-1 border-b border-line bg-pane shrink-0">
        <If when={props.fileNotice !== null} else={
          <If when={props.annotHint !== null} else={<View class="flex-1" />}>
            <Text testID="artifact-annotation-hint" class="flex-1 min-w-0 text-[12px] text-ink-muted">{hint()}</Text>
          </If>
        }>
          <Text testID="artifact-file-notice" class="flex-1 min-w-0 text-[12px] text-ink-muted">{props.fileNotice ?? ""}</Text>
        </If>
        <If when={props.hasResolved && props.mode !== "workspace"}>
          <View tooltip={tip(t().annotationShowResolvedHint)} class={`shrink-0 justify-center px-2 rounded-full border ${narrowWindow() ? "h-[32px]" : "h-[26px]"} ${props.annot.annotShowResolved ? "bg-accent-tint border-accent-border" : "bg-btn-secondary-bg border-line"}`}>
            <Checkbox
              testID="annotation-show-resolved"
              checked={props.annot.annotShowResolved}
              onChange={(next) => {
                props.annot.annotShowResolved = next;
              }}
              label={t().annotationShowResolved}
            />
          </View>
        </If>
        <If when={props.showSourceToggle}>
          <View
            role="button"
            testID="artifact-source-toggle"
            accessibilityState={{ selected: props.showSource }}
            onPress={props.toggleSource}
            class={`cursor-pointer select-none shrink-0 flex-row items-center gap-[5px] px-[10px] rounded-full border border-line bg-btn-secondary-bg hover:border-line-hover hover:bg-btn-secondary-hover ${btnHeight()}`}
          >
            <Icon name={props.showSource ? "eye" : "code"} size={12} class="tint-ink-secondary" />
            <Text class="text-[12px] font-medium text-ink-secondary">{props.showSource ? t().artifactRendered : t().artifactSource}</Text>
          </View>
        </If>
        <If when={props.showAnnotMode}>
          <View
            role="button"
            testID="annotation-mode"
            accessibilityState={{ selected: props.annot.annotMode, disabled: props.loader.originalProgress !== null || props.loader.loading }}
            disabled={props.loader.originalProgress !== null || props.loader.loading}
            onPress={() => void props.annot.toggleAnnotMode()}
            class={`cursor-pointer select-none disabled:cursor-default shrink-0 flex-row items-center gap-[5px] px-[10px] rounded-full border disabled:opacity-60 ${btnHeight()} ${props.annot.annotMode ? "bg-brand border-brand hover:bg-accent-hover" : "border-line bg-btn-secondary-bg hover:border-line-hover hover:bg-btn-secondary-hover"}`}
          >
            <Icon name="target" size={12} class={props.annot.annotMode ? "tint-on-accent" : "tint-ink-secondary"} />
            <Text class={`text-[12px] font-medium ${props.annot.annotMode ? "text-on-accent" : "text-ink-secondary"}`}>
              {props.annot.annotMode ? t().annotationModeExit : t().annotationMode}
            </Text>
          </View>
        </If>
        <If when={props.showAnnotToggle}>
          <View
            role="button"
            testID="annotation-toggle"
            accessibilityState={{ selected: props.annot.annotOpen }}
            onPress={() => {
              props.annot.annotOpen = !props.annot.annotOpen;
            }}
            class={`cursor-pointer select-none shrink-0 flex-row items-center gap-[5px] px-[10px] rounded-full border ${btnHeight()} ${props.annot.annotOpen ? "bg-accent-tint border-accent-border" : "border-line bg-btn-secondary-bg hover:border-line-hover hover:bg-btn-secondary-hover"}`}
          >
            <Icon name="message" size={12} class={props.annot.annotOpen ? "tint-brand" : "tint-ink-secondary"} />
            <Text class={`text-[12px] font-medium ${props.annot.annotOpen ? "text-brand" : "text-ink-secondary"}`}>
              {`${t().annotationsTitle}${props.annot.fileAnnotations.length > 0 ? ` (${props.annot.fileAnnotations.length})` : ""}`}
            </Text>
          </View>
        </If>
        <If when={props.canDownload && !narrowWindow() && !props.hideDownload}>
          {/* The key of the Svelte's `{#key}`: a new file is a new download. */}
          <Each of={[props.downloadKey]}>
            {() => (
              <FileDownload
                api={props.api}
                path={props.relpath}
                attachmentId={props.byteSource === "attachment" ? (props.attachment?.id ?? null) : null}
                name={props.titleName}
                ready={props.loader.readyOriginal}
                variant="compact"
                quiet
                note={props.loader.downloadNote}
                onNoteChange={(next) => {
                  props.loader.downloadNote = next;
                }}
              />
            )}
          </Each>
        </If>
      </View>
    </If>
  );
}
