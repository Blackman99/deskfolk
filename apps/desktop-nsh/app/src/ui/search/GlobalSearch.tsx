/**
 * ⌘K search over Bots, conversations, messages, files and routines (`GlobalSearch.svelte`): a card
 * over a scrim with the query, the category tabs and the grouped hits; the arrows walk the hits
 * that can be opened, Return opens one, Escape (or a press on the scrim) closes it. The search
 * itself is the runtime's (`runSearch`, `searchHits`, ...); what a hit does is the caller's
 * (`onSelect`): the shell closes the search, then opens the file, routine or conversation
 * (`searchJump`, `Shell.svelte`).
 *
 * It is nsh/base's `Dialog` underneath, as `Modal` is, so Escape and the scrim are NSH's. The
 * Svelte one's `opener` (the control to give focus back to) is a `ViewRef`, and its exported
 * `focusQuery()` is handed to `onApi` once. On a phone (≤ 680) it fills the window.
 */
import { effect, keymap, safeArea, Scroll, signal, Text, View, windowSize, type InputRef, type ScrollRef, type ViewRef } from "nsh";
import { Dialog, Input } from "nsh/base";
import type { Bot, SearchHit, SearchKind, SessionSummary } from "@real-bot/protocol";
import { copy, runtime } from "../../runtime";
import { searchHitView } from "../../m/sidebar/search-jump.ts";
import { canOpenSearchHit, nextSearchIndex } from "../../m/search/results.ts";
import { searchShortcutLabel } from "../../m/search/shortcuts.ts";
import { BotFace } from "../chat/BotFace";
import { EmptyState } from "../EmptyState";
import { Icon, type IconName } from "../Icon";
import { IconButton } from "../IconButton";
import { narrowWindow } from "../Modal";
import { SessionAvatar } from "../SessionAvatar";
import { shadow } from "../styles";
import { tip } from "../tip";
import { WheelLayer } from "../../platform/wheel-layer";

export type GlobalSearchApi = { focusQuery: () => void };

type Category = SearchKind | "all";
const KINDS = ["bot", "session", "message", "file", "routine"] as const;

const glyph = (kind: SearchKind | "search"): IconName => (kind === "search" ? "search" : kind === "file" ? "file" : kind === "routine" ? "calendar" : "message-lines");

export function GlobalSearch(props: {
  onClose: () => void;
  onSelect: (hit: SearchHit) => void;
  /** The control that opened it: gets the focus back when the search closes without a choice. */
  opener?: ViewRef | null;
  /** Hands the caller `focusQuery()`, for the shortcut pressed while it is open. */
  onApi?: (api: GlobalSearchApi) => void;
}) {
  const t = () => copy().sidebar;
  const category = signal<Category>("all");
  const active = signal(-1);
  const composing = signal(false);
  let input: InputRef | null = null;
  let returnFocus = true;
  const scroller: { ref: ScrollRef | null } = { ref: null };
  const bounds = new Map<number, { y: number; height: number }>();
  const viewport = { y: 0, height: 0 };

  const snapshot = () => runtime.snapshot;
  const bots = () => new Map(snapshot().bots.map((bot) => [bot.id, bot]));
  const sessions = () => new Map(snapshot().sessions.map((session) => [session.id, session]));
  const labels = () => ({ bot: t().searchKindBot, session: t().searchKindSession, message: t().searchKindMessage, file: t().searchKindFile, routine: t().searchKindRoutine });
  const categories = () => [{ key: "all" as Category, label: t().searchAll }, ...KINDS.map((key) => ({ key: key as Category, label: labels()[key] }))];
  const connected = () => runtime.connection === "connected";
  const queried = () => Boolean(runtime.searchQuery.trim());
  const hits = (): SearchHit[] =>
    connected() && !runtime.searchLoading && !runtime.searchError ? runtime.searchHits.filter((hit) => category() === "all" || hit.kind === category()) : [];
  const available = () => hits().map((hit) => canOpenSearchHit(hit, snapshot().sessions, snapshot().routines, snapshot().bots));

  // A new list starts on its first row that can be opened, at the top.
  effect(() => {
    void hits();
    active.set(nextSearchIndex(available(), -1, 1));
    scroller.ref?.scrollTo({ y: 0, animated: false });
  });

  /** Focuses the query and selects it, so typing replaces it. */
  function focusQuery(): void {
    input?.focus();
    input?.setSelection(0, runtime.searchQuery.length);
  }
  props.onApi?.({ focusQuery });

  function close(): void {
    props.onClose();
  }
  effect(() => () => {
    if (returnFocus) props.opener?.focus();
  });

  function choose(hit: SearchHit): void {
    if (!canOpenSearchHit(hit, snapshot().sessions, snapshot().routines, snapshot().bots) || runtime.searchLoading || !connected()) return;
    returnFocus = false;
    props.onSelect(hit);
  }

  function changeCategory(next: Category): void {
    category.set(next);
    input?.focus();
  }

  /** Keeps the row the arrows are on in view. */
  const reveal = (index: number) => {
    const at = bounds.get(index);
    if (!at || !scroller.ref || viewport.height === 0) return;
    if (at.y < viewport.y) scroller.ref.scrollTo({ y: at.y });
    else if (at.y + at.height > viewport.y + viewport.height) scroller.ref.scrollTo({ y: at.y + at.height - viewport.height });
  };
  effect(() => reveal(active()));

  // The arrows walk the hits while the query has the focus; nothing is moved while an input method composes.
  effect(() => {
    const move = (direction: 1 | -1) => {
      if (composing()) return;
      active.set(nextSearchIndex(available(), active(), direction));
    };
    const off = [
      keymap.bind("down", () => move(1), { when: "always", repeat: true }),
      keymap.bind("up", () => move(-1), { when: "always", repeat: true }),
      // The query has the focus, which would take Escape for itself.
      keymap.bind("escape", () => !composing() && close(), { when: "always" }),
    ];
    return () => off.forEach((fn) => fn());
  });

  function submit(): void {
    if (composing()) return;
    const hit = hits()[active()];
    if (hit) choose(hit);
  }

  const phone = () => narrowWindow();
  const cardWidth = () => (phone() ? windowSize().width : Math.min(640, windowSize().width - 48));

  return (
    <Dialog
      open
      animation="fade"
      onCancel={close}
      onOpenChange={(e) => {
        if (!e.open) close();
      }}
      backdropClass={phone() ? "bg-pane" : "bg-modal-backdrop"}
      class={`bg-pane overflow-hidden ${phone() ? "" : "rounded-(--radius-lg) border border-line"}`}
      style={{
        width: cardWidth(),
        height: phone() ? windowSize().height : undefined,
        maxHeight: phone() ? undefined : Math.min(640, Math.round(windowSize().height * 0.7)),
        minHeight: phone() ? 0 : 240,
        marginTop: phone() ? 0 : Math.min(100, Math.round(windowSize().height * 0.14)),
        marginHorizontal: "auto",
        paddingTop: phone() ? safeArea().top : 0,
        boxShadow: phone() ? undefined : shadow("lg"),
      }}
    >
      <WheelLayer>
        <View testID="global-search" role="group" accessibilityLabel={t().globalSearch} class="flex-col shrink min-h-0">
          <View class={`flex-row items-center gap-[10px] border-b border-line ${phone() ? "pl-4 pr-3 py-[6px] gap-2" : "px-4 py-3"}`}>
            <Icon name="search" size={20} class="tint-ink-muted" />
            <Input
              ref={(node: InputRef | null) => (input = node)}
              testID="global-search-input"
              accessibilityLabel={t().search}
              placeholder={t().search}
              value={runtime.searchQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              submitBehavior="submit"
              onChange={(e) => void runtime.runSearch(e.value)}
              onSubmit={submit}
              onCompositionChange={(e) => composing.set(e.composing)}
              class={`flex-1 min-w-0 text-ink ${phone() ? "py-3 text-[16px]" : "py-[9px] text-[16px]"}`}
            />
            <If when={runtime.searchQuery}>
              <IconButton
                icon="x"
                label={t().searchClear}
                testID="search-clear"
                onPress={() => {
                  void runtime.runSearch("");
                  input?.focus();
                }}
              />
            </If>
            <View
              role="button"
              testID="search-cancel"
              accessibilityLabel={t().searchCancel}
              onPress={close}
              class={`cursor-pointer select-none flex-row items-center justify-center gap-[6px] rounded-(--radius-sm) hover:bg-row-hover ${phone() ? "min-w-[44px] min-h-[44px] px-2" : "min-h-[36px] p-[6px]"}`}
            >
              <Text class={`${phone() ? "text-[14px] text-brand" : "text-[12px] text-ink-muted"}`}>{t().searchCancel}</Text>
              <If when={!phone()}>
                <Kbd>Esc</Kbd>
              </If>
            </View>
          </View>

          <View role="group" accessibilityLabel={t().globalSearch} class={`flex-row gap-1 border-b border-line-subtle ${phone() ? "px-3 py-2" : "px-[14px] py-[10px]"}`}>
            <Each of={categories()} key={(item) => item.key}>
              {(item) => (
                <View
                  role="button"
                  testID={`search-category-${item().key}`}
                  accessibilityLabel={item().label}
                  accessibilityState={{ selected: category() === item().key }}
                  onPress={() => changeCategory(item().key)}
                  class={`cursor-pointer select-none shrink-0 justify-center border rounded-(--radius-sm) ${phone() ? "min-h-[40px] px-[11px]" : "px-[11px] py-[5px]"} ${category() === item().key ? "bg-accent-tint border-accent-border" : "border-transparent hover:bg-row-hover"}`}
                >
                  <Text class={`${phone() ? "text-[13px]" : "text-[12px]"} ${category() === item().key ? "text-brand" : "text-ink-muted"}`}>{item().label}</Text>
                </View>
              )}
            </Each>
          </View>

          <Scroll
            class="shrink min-h-0 px-2 pb-2"
            ref={(node: ScrollRef | null) => (scroller.ref = node)}
            onLayout={(e) => (viewport.height = e.bounds.size.height)}
            onScroll={(e) => (viewport.y = e.offset.y)}
          >
            <State hits={hits} connected={connected} queried={queried} />
            <View testID="search-results" role="list" accessibilityLabel={t().globalSearch} accessibilityState={{ busy: runtime.searchLoading }}>
              {() =>
                hits().map((hit, index) => (
                  <Hit
                    hit={hit}
                    index={index}
                    selected={active() === index}
                    available={available()[index] === true}
                    onHover={() => available()[index] && active.set(index)}
                    onPress={() => choose(hit)}
                    onLayout={(b) => bounds.set(index, b)}
                    bots={bots()}
                    sessions={sessions()}
                    labels={labels()}
                  />
                ))
              }
            </View>
          </Scroll>

          <If when={!phone()}>
            <View class="flex-row items-center gap-[14px] px-[18px] py-[10px] border-t border-line">
              <Text class="text-[11px] text-ink-muted">{`↑↓ ${t().searchNavigate}`}</Text>
              <Text class="text-[11px] text-ink-muted">{`↵ ${t().searchOpen}`}</Text>
              <View class="flex-1" />
              <View tooltip={tip(t().searchEverywhere)}>
                <Text class="text-[11px] text-ink-muted">{searchShortcutLabel(true)}</Text>
              </View>
            </View>
          </If>
        </View>
      </WheelLayer>
    </Dialog>
  );
}

function Kbd(props: { children: string }) {
  return (
    <View class="px-1 rounded-(--radius-xs) border border-line">
      <Text class="text-[11px] text-ink-muted">{props.children}</Text>
    </View>
  );
}

/** What stands over the list: offline, working, failed (with a retry), the intro, no results, or the count. */
function State(props: { hits: () => SearchHit[]; connected: () => boolean; queried: () => boolean }) {
  const t = () => copy().sidebar;
  const note = (text: string, testID: string) => (
    <Text testID={testID} role="text" class="mt-10 mx-4 mb-2 text-center text-[13px] text-ink-muted">
      {text}
    </Text>
  );
  return (
    <View testID="search-state" role="text" class="items-stretch">
      <If when={props.connected()} else={note(t().searchOffline, "search-offline")}>
        <If when={runtime.searchLoading} else={
          <If when={runtime.searchError} else={
            <If when={props.queried()} else={
              <View testID="search-intro" class="items-center px-4 pt-8 pb-7">
                <Icon name="search" size={24} class="tint-ink-muted" />
                <Text class="mt-[14px] mb-[6px] text-[14px] text-ink-secondary text-center">{t().searchIntro}</Text>
                <Text class="text-[12px] text-ink-muted text-center">{t().searchHint}</Text>
              </View>
            }>
              <If when={props.hits().length === 0} else={<Text testID="search-count" class="px-[10px] pt-3 pb-[6px] text-[11px] text-ink-muted">{t().searchResults(props.hits().length)}</Text>}>
                <EmptyState
                  size="inline"
                  level={3}
                  testID="search-empty"
                  title={t().searchNoResults}
                  hint={t().searchTryAnother}
                  badge={<Icon name="search" size={12} class="tint-ink-muted" />}
                />
              </If>
            </If>
          }>
            <View class="items-center">
              {note(t().searchFailed, "search-failed")}
              <View
                role="button"
                testID="search-retry"
                accessibilityLabel={t().searchRetry}
                onPress={() => void runtime.runSearch(runtime.searchQuery)}
                class="cursor-pointer select-none mt-1 mb-[30px] px-[14px] py-[6px] border border-line rounded-(--radius-sm) bg-btn-secondary-bg hover:bg-line-subtle"
              >
                <Text class="text-[13px] text-ink">{t().searchRetry}</Text>
              </View>
            </View>
          </If>
        }>
          <View testID="search-loading" class="flex-row items-center justify-center gap-2 pt-10 pb-[30px]">
            <Icon name="spinner" size={16} class="animate-spin tint-brand" />
            <Text class="text-[13px] text-ink-muted">{t().searchLoading}</Text>
          </View>
        </If>
      </If>
    </View>
  );
}

/** One hit: its face or kind glyph, the name over a second line, and its kind. */
function Hit(props: {
  hit: SearchHit;
  index: number;
  selected: boolean;
  available: boolean;
  onHover: () => void;
  onPress: () => void;
  onLayout: (bounds: { y: number; height: number }) => void;
  bots: ReadonlyMap<string, Bot>;
  sessions: ReadonlyMap<string, SessionSummary>;
  labels: Record<SearchKind, string>;
}) {
  const t = () => copy().sidebar;
  const hit = props.hit;
  const view = searchHitView(hit, props.labels);
  const bot = hit.kind === "bot" && hit.id ? props.bots.get(hit.id) : undefined;
  const session = hit.kind === "session" && hit.id ? props.sessions.get(hit.id) : undefined;
  const path = hit.path ?? "";
  const name = hit.kind === "file" ? (path.split("/").at(-1) ?? path) : (bot?.name ?? (hit.kind === "session" ? (view.sessionTitle ?? view.snippet) : view.snippet));
  const secondary = hit.kind === "file" ? path : hit.kind === "bot" ? (view.snippet === name ? "" : view.snippet) : hit.kind === "message" ? view.sessionTitle : "";
  const phone = narrowWindow();
  return (
    <View
      role="option"
      testID={`search-hit-${props.index}`}
      accessibilityLabel={name}
      accessibilityState={{ selected: props.selected, disabled: !props.available }}
      onPress={props.onPress}
      onMouseEnter={props.onHover}
      onLayout={(e) => props.onLayout({ y: e.bounds.origin.y, height: e.bounds.size.height })}
      class={`cursor-pointer select-none flex-row items-center gap-3 px-3 py-[10px] border rounded-(--radius-sm) ${phone ? "min-h-[68px] gap-[10px]" : "min-h-[60px]"} ${props.available ? "" : "opacity-[0.65]"} ${props.selected ? "bg-accent-tint border-accent-border" : "border-transparent"}`}
    >
      <View class="w-[32px] h-[32px] items-center justify-center shrink-0">
        <If
          when={bot}
          else={
            <If when={session} else={<Icon name={glyph(hit.kind)} size={20} class="tint-ink-muted" />}>
              {(s) => <SessionAvatar session={s()} bots={props.bots} size="sm" />}
            </If>
          }
        >
          {(b) => <BotFace id={b().id} name={b().name} avatar={b().avatar ?? hit.avatar} size={32} border={0} letterSize={14} />}
        </If>
      </View>
      <View class="flex-1 min-w-0 gap-[3px]">
        <Text class="text-[14px] leading-[1.45] text-ink line-clamp-2">{name}</Text>
        <If when={secondary}>
          {(text) => <Text class={`text-[12px] leading-[1.4] line-clamp-1 ${props.selected ? "text-ink-secondary" : "text-ink-muted"}`}>{text()}</Text>}
        </If>
        <If when={!props.available}>
          <Text class="text-[12px] text-ink-muted">{hit.kind === "routine" ? t().routineUnavailable : t().searchUnavailable}</Text>
        </If>
      </View>
      <Text class={`shrink-0 text-[11px] ${props.selected ? "text-ink-secondary" : "text-ink-muted"}`}>{view.kindLabel}</Text>
    </View>
  );
}
