/**
 * The annotations on one file as a list (`AnnotationList.svelte`): filter tabs by state with their
 * counts, a row per annotation (number, kind, place, state, remark, stale and resolution notes,
 * the actions its state allows). A state has one colour wherever it shows: 待处理 the accent, 已处理
 * green, 草稿 grey and dashed. Being picked is told apart by form, an outlined row.
 */
import { keymap, Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { ANNOTATION_BODY_MAX, type Annotation } from "@real-bot/protocol";
import { compactPositionLabel, filterAnnotations, positionLabel, resolverName, staleLabel, statusLabel, type AnnotationListFilter } from "../../m/annotations/model.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Icon, type IconName } from "../Icon";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";

type State = "open" | "resolved" | "draft";

const STATE_BG: Record<State, string> = { open: "bg-brand", resolved: "bg-ok", draft: "bg-muted-light" };
const KIND_ICON: Partial<Record<Annotation["anchor_kind"], IconName>> = {
  image_region: "image",
  text_range: "lines",
  pdf_region: "file",
  html_element: "code",
  media_time: "clock",
};
const FILTERS: AnnotationListFilter[] = ["all", "open", "resolved", "draft"];

function Dot(props: { state: State }) {
  return (
    <View
      accessible={false}
      class={`w-[6px] h-[6px] rounded-full shrink-0 ${props.state === "draft" ? "border border-ink-muted" : STATE_BG[props.state]}`}
    />
  );
}

export function AnnotationList(props: {
  /** This file's annotations, in reading order. */
  annotations: Annotation[];
  locale: "zh" | "en";
  bots: ReadonlyMap<string, { name: string }>;
  focusId: string | null;
  busy?: boolean;
  error?: string | null;
  onReveal: (row: Annotation) => void;
  onEdit: (row: Annotation, body: string) => void;
  onDelete: (row: Annotation) => void;
  onToggleStatus: (row: Annotation, status: "open" | "resolved") => void;
  onClose?: () => void;
  /** Nothing here can be annotated (no Bot handed the file over): the empty list says so. */
  noTarget?: boolean;
}) {
  const filter = signal<AnnotationListFilter>("all");
  const editingId = signal<string | null>(null);
  const editBody = signal("");
  const shown = () => filterAnnotations(props.annotations, filter());
  const busy = () => props.busy === true;
  const label = (key: AnnotationListFilter) =>
    key === "all"
      ? copy().stream.annotationsFilterAll
      : key === "open"
        ? copy().stream.annotationsFilterOpen
        : key === "resolved"
          ? copy().stream.annotationsFilterResolved
          : copy().stream.annotationsFilterDraft;
  /** How many rows each state has on this file, whichever tab is showing. */
  const count = (key: AnnotationListFilter) => (key === "all" ? props.annotations.length : props.annotations.filter((row) => row.status === key).length);
  /** What an empty tab says: why nothing is here, and how something gets here. */
  const empty = () => {
    const t = copy().stream;
    if (filter() === "open") return { title: t.annotationsEmptyOpen, hint: t.annotationsEmptyOpenHint };
    if (filter() === "resolved") return { title: t.annotationsEmptyResolved, hint: t.annotationsEmptyResolvedHint };
    if (filter() === "draft") return { title: t.annotationsEmptyDraft, hint: t.annotationsEmptyDraftHint };
    return { title: t.annotationsEmpty, hint: props.noTarget ? t.annotationNoTarget : t.annotationsEmptyHint };
  };
  const markNumber = (row: Annotation) => {
    const index = props.annotations.findIndex((a) => a.id === row.id);
    return index >= 0 ? index + 1 : 1;
  };

  function startEdit(row: Annotation): void {
    editingId.set(row.id);
    editBody.set(row.body);
  }

  function commitEdit(row: Annotation): void {
    const body = editBody().trim();
    if (body && body !== row.body) props.onEdit(row, body);
    editingId.set(null);
  }

  // Escape drops the edit, Cmd/Ctrl+Enter keeps it.
  keymap.bind(
    "escape",
    () => {
      if (editingId() !== null) editingId.set(null);
    },
    { when: "always" },
  );
  keymap.bind(
    "mod+enter",
    () => {
      const row = props.annotations.find((a) => a.id === editingId());
      if (row) commitEdit(row);
    },
    { when: "always" },
  );

  return (
    <View testID="annotation-list" accessibilityLabel={copy().stream.annotationsTitle} class={`flex-1 min-h-0 bg-pane border-line ${narrowWindow() ? "border-t" : "border-l"}`}>
      <View class="border-b border-line">
        <View class="flex-row items-center justify-between gap-[6px] min-h-[48px] pt-[10px] pr-2 pb-2 pl-[14px]">
          <Text role="header" class="text-[13px] font-semibold text-ink">{copy().stream.annotationsCount(props.annotations.length)}</Text>
          <If when={props.onClose}>
            <IconButton testID="annotation-list-close" icon="x" label={copy().common.close} size="sm" onPress={() => props.onClose?.()} />
          </If>
        </View>
        <View role="tablist" class="flex-row gap-[2px] mx-3 mb-3 p-[3px] bg-line-subtle border border-line rounded-(--radius-md)">
          {FILTERS.map((key) => (
            <View
              role="tab"
              testID={`annotation-filter-${key}`}
              accessibilityState={{ selected: filter() === key }}
              onPress={() => filter.set(key)}
              class={`flex-1 flex-row items-center justify-center gap-1 px-[6px] rounded-[7px] ${narrowWindow() ? "min-h-[32px]" : "min-h-[26px]"} ${filter() === key ? "bg-pane" : "bg-transparent"}`}
              style={{ boxShadow: filter() === key ? shadow("xs") : undefined }}
            >
              <If when={key !== "all"}>
                <Dot state={key as State} />
              </If>
              <Text class={`text-[11px] line-clamp-1 shrink ${filter() === key ? "font-semibold text-ink" : "font-medium text-ink-muted hover:text-ink"}`}>{label(key)}</Text>
              <If when={key !== "all" && count(key) > 0}>
                <Text class="text-[10px] text-ink-muted">{String(count(key))}</Text>
              </If>
            </View>
          ))}
        </View>
      </View>
      <If when={props.error}>
        {(message: () => string) => <Text testID="annotation-list-error" class="px-4 pt-2 text-[11px] text-danger-text">{message()}</Text>}
      </If>
      <If
        when={shown().length > 0}
        else={
          <Scroll class="flex-1 min-h-0">
            <EmptyState size="inline" level={3} title={empty().title} hint={empty().hint} badge={<Icon name="message" />} />
          </Scroll>
        }
      >
        <Scroll class="flex-1 min-h-0" contentClass="gap-2 px-3 pt-3 pb-4">
          <Each of={shown()} key={(row: Annotation) => row.id}>
            {(row: () => Annotation) => (
              <Row
                row={row()}
                n={markNumber(row())}
                locale={props.locale}
                bots={props.bots}
                focused={props.focusId === row().id}
                busy={busy()}
                editing={editingId() === row().id}
                editBody={editBody()}
                onEditBody={(value) => editBody.set(value)}
                onReveal={props.onReveal}
                onStartEdit={startEdit}
                onCommitEdit={commitEdit}
                onCancelEdit={() => editingId.set(null)}
                onDelete={props.onDelete}
                onToggleStatus={props.onToggleStatus}
              />
            )}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}

function Row(props: {
  row: Annotation;
  n: number;
  locale: "zh" | "en";
  bots: ReadonlyMap<string, { name: string }>;
  focused: boolean;
  busy: boolean;
  editing: boolean;
  editBody: string;
  onEditBody: (value: string) => void;
  onReveal: (row: Annotation) => void;
  onStartEdit: (row: Annotation) => void;
  onCommitEdit: (row: Annotation) => void;
  onCancelEdit: () => void;
  onDelete: (row: Annotation) => void;
  onToggleStatus: (row: Annotation, status: "open" | "resolved") => void;
}) {
  const row = () => props.row;
  const state = (): State => (row().status === "resolved" ? "resolved" : row().status === "draft" ? "draft" : "open");
  const stale = () => staleLabel(copy(), row(), props.locale);
  const resolver = () => resolverName(row(), props.bots, copy());
  const kind = () => KIND_ICON[row().anchor_kind];
  const t = () => copy().stream;
  const numberClass = () =>
    state() === "open"
      ? "bg-accent-tint border-accent-border"
      : state() === "resolved"
        ? "bg-ok-bg border-ok-line"
        : "bg-input-bg border-dashed border-line";
  const numberInk = () => (state() === "open" ? "text-brand" : state() === "resolved" ? "text-ok-text" : "text-ink-muted");
  const chipClass = () => (state() === "open" ? "bg-accent-tint" : state() === "resolved" ? "bg-ok-bg" : "bg-transparent border border-line");
  const chipInk = () => (state() === "open" ? "text-brand" : state() === "resolved" ? "text-ok-text" : "text-ink-muted");
  return (
    <View
      testID={`annotation-item-${row().id}`}
      class={`shrink-0 overflow-hidden rounded-(--radius-md) border ${props.focused ? "border-brand" : state() === "draft" ? "border-dashed border-line hover:border-line-hover" : "border-line hover:border-line-hover"} ${state() === "resolved" ? "bg-bg" : "bg-pane"}`}
      style={{ boxShadow: shadow("xs") }}
    >
      <View accessible={false} class={`absolute top-0 bottom-0 left-0 w-[3px] ${STATE_BG[state()]}`} />
      <View
        role="button"
        testID="annotation-reveal"
        accessibilityState={{ selected: props.focused }}
        tooltip={tip(props.focused ? t().annotationDeselect : t().annotationGoTo)}
        accessibilityLabel={props.focused ? t().annotationDeselect : t().annotationGoTo}
        onPress={() => props.onReveal(row())}
        class="gap-[6px] pt-[10px] pr-3 pb-2 pl-[15px]"
      >
        <View class="flex-row items-center justify-between gap-1">
          <View class="flex-1 flex-row items-center gap-1 min-w-0">
            <View testID="annotation-number" class={`min-w-[18px] h-[18px] px-1 rounded-full border items-center justify-center shrink-0 ${numberClass()}`}>
              <Text class={`text-[10px] font-bold ${numberInk()}`}>{String(props.n)}</Text>
            </View>
            <If when={kind()}>{(name: () => IconName) => <Icon name={name()} size={12} />}</If>
            <Text tooltip={tip(positionLabel(row(), props.locale))} class="font-mono text-[11px] text-ink-muted line-clamp-1 shrink">
              {compactPositionLabel(row(), props.locale)}
            </Text>
          </View>
          <View testID="annotation-status" class={`flex-row items-center gap-[5px] px-2 h-[20px] rounded-full shrink-0 ${chipClass()}`}>
            <Dot state={state()} />
            <Text class={`text-[11px] font-semibold ${chipInk()}`}>{statusLabel(copy(), row().status)}</Text>
          </View>
        </View>
        <If when={!props.editing}>
          <Text testID="annotation-body" class={`text-[13px] leading-[1.5] ${state() === "resolved" ? "text-ink-secondary" : "text-ink"}`}>{row().body}</Text>
        </If>
      </View>
      <If when={props.editing}>
        <View class="gap-1 pr-3 pb-2 pl-[15px]">
          <Input
            testID="annotation-edit-input"
            value={props.editBody}
            onChange={(e) => props.onEditBody(e.value)}
            multiline
            maxLength={ANNOTATION_BODY_MAX}
            autoFocus
            class="min-h-[64px] max-h-[160px] px-2 py-[6px] border border-line rounded-(--radius-sm) bg-input-bg text-[12px] text-ink focus:border-field-focus-border"
          />
          <View class="flex-row gap-1 justify-end">
            <Button testID="annotation-edit-save" size="sm" disabled={props.busy || !props.editBody.trim()} onPress={() => props.onCommitEdit(row())}>
              {t().annotationSaveDraft}
            </Button>
            <Button testID="annotation-edit-cancel" size="sm" onPress={props.onCancelEdit}>{t().annotationCancel}</Button>
          </View>
        </View>
      </If>
      <If when={stale()}>
        {(text: () => string) => (
          <View testID="annotation-stale" class="flex-row items-center gap-1 mt-0 mr-3 mb-2 ml-[15px] px-2 py-1 rounded-(--radius-sm) bg-warn-bg border border-warn-line">
            <Icon name="alert-triangle" size={12} class="tint-warn-text" />
            <Text class="flex-1 text-[11px] text-warn-text">{text()}</Text>
          </View>
        )}
      </If>
      <If when={state() === "resolved" && (resolver() || row().resolved_note)}>
        <View testID="annotation-note" class="flex-row items-start gap-1 mr-3 mb-2 ml-[15px] px-2 py-[6px] rounded-(--radius-sm) bg-line-subtle">
          <Icon name="check-circle" size={12} class="tint-ok mt-[2px]" />
          <Text class="flex-1 text-[11px] leading-[1.45] text-ink-secondary">
            {`${resolver() ? t().annotationResolvedBy(resolver()!) : ""}${row().resolved_note ? `${resolver() ? "：" : ""}${row().resolved_note}` : ""}`}
          </Text>
        </View>
      </If>
      <View class="flex-row items-center justify-end gap-1 py-[6px] pr-3 pl-[15px] border-t border-line-subtle">
        <If
          when={state() === "draft"}
          else={
            <If
              when={state() === "open"}
              else={
                <Button testID="annotation-reopen" size="sm" icon="refresh" disabled={props.busy} onPress={() => props.onToggleStatus(row(), "open")}>
                  {t().annotationReopen}
                </Button>
              }
            >
              <Button testID="annotation-resolve" size="sm" icon="check" disabled={props.busy} onPress={() => props.onToggleStatus(row(), "resolved")}>
                {t().annotationResolve}
              </Button>
            </If>
          }
        >
          <Button testID="annotation-edit" size="sm" icon="edit" disabled={props.busy} onPress={() => props.onStartEdit(row())}>
            {t().annotationEdit}
          </Button>
          <Button testID="annotation-delete" size="sm" variant="danger-soft" icon="trash" disabled={props.busy} onPress={() => props.onDelete(row())}>
            {t().annotationDelete}
          </Button>
        </If>
      </View>
    </View>
  );
}
