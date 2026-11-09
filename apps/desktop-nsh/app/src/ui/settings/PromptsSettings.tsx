/**
 * Settings › Prompts (`settings/PromptsSettings.svelte`), by group as Models is by section: a wide
 * window shows the groups as tabs under the search, a phone lists them and opens one as a page of
 * its own. A search or the edited filter looks through every group, so while one is on, what it
 * keeps shows by group in one list instead. A row opens `PromptEditorPage`.
 *
 * Differences from the Svelte: a phone is `narrowWindow()` (680 wide) not 720; focus is not moved
 * to the text or back to the row (NSH has no element focus to hand around); a group opened on a
 * phone does not slide in.
 *
 * Props: `items` (every built-in prompt and its state; the settings modal loads them, so its tab
 * can count them too); `loadFailed`; `closeSettings`; `openRouting` (opens Settings › Roles, where
 * the app's own calls' prompts are); `notices` (what the dialog says over any page); `onReady(api)`
 * hands the caller `sectionTitle()` (the open group's name for a phone's page head, null on the
 * list), `backFromSection()` and `backFromEditor()` (each true when it took the Back).
 */
import type { Locale, PromptGroup, PromptSummary } from "@real-bot/protocol";
import { effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Input } from "nsh/base";
import { copy, runtime } from "../../runtime";
import { promptsTabItems } from "../../m/settings/routing-map.ts";
import { editedCount, firstLocale, groupPrompts, promptChip, toolsByKind, type PromptView } from "../../m/settings/prompts-view.ts";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";
import { PromptEditorPage } from "./PromptEditorPage";
import { PromptRowList } from "./PromptRowList";
import { SettingsSectionList } from "./SettingsSectionList";
import { SettingsSectionTabs } from "./SettingsSectionTabs";

export type PromptsSettingsApi = {
  sectionTitle: () => string | null;
  backFromSection: () => boolean;
  backFromEditor: () => boolean;
};

export function PromptsSettings(props: {
  items: readonly PromptSummary[];
  loadFailed?: boolean;
  closeSettings?: () => void;
  openRouting?: () => void;
  notices?: JSX.Element;
  onReady?: (api: PromptsSettingsApi) => void;
}) {
  const t = () => copy();
  const c = () => t().prompts;
  const ui = (): Locale => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");
  // The app's own calls' prompts are on Roles, with their models (ADR 0082); a daemon from before
  // it names no call for them, and they stay here.
  const items = () => promptsTabItems(props.items);
  const moved = () => props.items.some((item) => item.role);

  const query = signal("");
  const onlyEdited = signal(false);
  const open = signal<{ id: string; locale: Locale } | null>(null);
  const editorView = signal<PromptView>("text");
  /** A change to open in the history the first time the editor shows it (a card's 「在设置里看」). */
  const editorReveal = signal<string | null>(null);
  let flushEditor: () => Promise<void> = async () => {};
  /** Opened from a card: its group goes under the editor once it shows. */
  let fromCard = false;

  const counts = () => editedCount(items());
  // The filter is there only while something is edited, so restoring the last one shows them all again.
  const editedOnly = () => onlyEdited() && counts().edited > 0;
  const groups = () => groupPrompts(items(), query(), editedOnly());
  const narrowed = () => query().trim() !== "" || editedOnly();
  /** Every prompt by group, whatever the search: the tabs, and the phone's list of groups. */
  const byGroup = () => groupPrompts(items(), "");
  const sections = () => byGroup().map((row) => row.group);
  const picked = signal<PromptGroup>("turn");
  const section = (): PromptGroup => (sections().includes(picked()) ? picked() : (sections()[0] ?? "turn"));
  /** On a phone, a group's page is open over the list of them. */
  const opened = signal(false);
  const sectioned = () => sections().length > 1 && !narrowed();
  const listing = () => narrowWindow() && sectioned() && !opened();
  const inGroup = () => narrowWindow() && sectioned() && opened();
  const botNames = () => new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot.name] as const));
  const openItem = () => {
    const at = open();
    return at ? items().find((item) => item.id === at.id) : undefined;
  };

  const itemsOf = (group: PromptGroup) => byGroup().find((row) => row.group === group)?.items ?? [];
  /** A tab counts what you edited in its group, as Prompts in the settings list does over all of them. */
  const editedIn = (group: PromptGroup) => editedCount(itemsOf(group)).edited;
  const conflictIn = (group: PromptGroup) => editedCount(itemsOf(group)).conflict;

  /** A group's line on the phone's list: how many prompts, and how many of them are edited. */
  function summary(group: PromptGroup): string {
    const list = itemsOf(group);
    const counted = editedCount(list);
    return c().groupSummary(list.length, counted.edited, counted.conflict);
  }

  function openSection(next: PromptGroup): void {
    picked.set(next);
    opened.set(true);
  }

  async function closeEditor(): Promise<void> {
    await flushEditor();
    open.set(null);
  }

  function openMessage(sessionId: string, messageId: string): void {
    void flushEditor();
    open.set(null);
    props.closeSettings?.();
    void runtime.selectSession(sessionId, { messageId });
  }

  props.onReady?.({
    sectionTitle: () => (inGroup() ? c().groups[section()] : null),
    backFromSection: () => {
      if (!inGroup()) return false;
      opened.set(false);
      return true;
    },
    backFromEditor: () => {
      if (!open()) return false;
      void closeEditor();
      return true;
    },
  });

  // Sent here from a card's 「在设置里看」: that prompt's history, at the change the card let through.
  effect(() => {
    const target = runtime.promptsTarget?.prompt;
    if (!target) return;
    untracked(() => {
      editorView.set("history");
      editorReveal.set(target.revisionId);
      open.set({ id: target.id, locale: target.locale });
      fromCard = true;
      runtime.promptsTarget = null;
    });
  });
  // Under the editor, its group: where closing it, or Back on a phone, lands.
  effect(() => {
    const item = open() ? openItem() : undefined;
    if (!item) return;
    untracked(() => {
      if (fromCard) {
        fromCard = false;
        picked.set(item.group);
        opened.set(true);
      }
    });
  });

  function openEditor(item: PromptSummary): void {
    // Opened from a search, its group is the tab showing once the search is cleared.
    picked.set(item.group);
    editorView.set("text");
    editorReveal.set(null);
    open.set({ id: item.id, locale: firstLocale(item, ui()) });
  }

  const icon = (of: PromptGroup, size: number) => (
    <Icon name={of === "turn" ? "repeat" : of === "agent" ? "terminal-square" : of === "call" ? "zap" : "wrench"} size={size <= 12 ? 12 : size <= 17 ? 16 : 20} class={size === 15 ? "tint-ink-muted" : "tint-ink-muted"} />
  );

  const toolCell = (item: PromptSummary) => {
    const chip = promptChip(item, botNames(), c());
    return (
      <View
        role="button"
        testID={`prompt-${item.id}`}
        accessibilityLabel={chip.tone === "default" ? item.title[ui()] : `${item.title[ui()]}, ${chip.label}`}
        tooltip={chip.tone === "default" ? undefined : tip(chip.label)}
        onPress={() => openEditor(item)}
        class="cursor-pointer select-none group flex-row items-center gap-[6px] px-2 py-[5px] rounded-(--radius-sm) hover:bg-row-hover"
        style={{ width: narrowWindow() ? 140 : 156 }}
      >
        <Text class="min-w-0 shrink text-[12px] leading-[1.5] text-ink-secondary group-hover:text-ink font-mono line-clamp-1">{item.title[ui()]}</Text>
        <If when={chip.tone !== "default"}>
          <View testID={`prompt-${item.id}-dot`} class={`shrink-0 w-[6px] h-[6px] rounded-full ${chip.tone === "conflict" ? "bg-warn-text" : "bg-brand"}`} />
        </If>
      </View>
    );
  };

  // A group's prompts: one line each, or for the tool descriptions, their names in a grid under the name of what they are for.
  const groupBody = (group: PromptGroup, list: PromptSummary[]) =>
    group === "tool" ? (
      <>
        <Text testID="prompts-tools-note" class="px-1 text-[12px] leading-[1.45] text-ink-muted">{c().toolsNote}</Text>
        <View class="flex-col border border-line rounded-(--radius-md) bg-pane" style={{ boxShadow: shadow("xs") }}>
          {() =>
            toolsByKind(list).map((row, at) => (
              <View
                role="region"
                testID={`prompts-tool-kind-${row.kind ?? "none"}`}
                accessibilityLabel={row.kind ? c().toolKinds[row.kind] : undefined}
                class={`flex-col gap-[2px] p-[6px] ${at > 0 ? "border-t border-line" : ""}`}
              >
                <If when={row.kind}>
                  {(kind) => <Text class="px-2 pt-[2px] text-[12px] font-medium leading-[1.5] text-ink-muted">{c().toolKinds[kind()]}</Text>}
                </If>
                <View class="flex-row flex-wrap gap-[2px]">{row.items.map(toolCell)}</View>
              </View>
            ))
          }
        </View>
      </>
    ) : (
      <PromptRowList items={list} ui={ui()} botNames={botNames()} onOpen={openEditor} />
    );

  const gutter = () => (narrowWindow() ? "px-4" : "px-6");

  return (
    <View testID="prompts-settings" class="flex-col flex-1 min-h-0 min-w-0">
      {/* The search sits over the groups, not in one: it looks through all of them. On a phone it is on the list of groups. */}
      <If when={!inGroup()}>
        <View class={`flex-col gap-[10px] shrink-0 ${narrowWindow() ? "px-4 pt-[14px] pb-3" : "px-6 pt-[18px] pb-3"}`}>
          {props.notices}
          <Text class="text-[12px] leading-[1.5] text-ink-muted">{c().intro}</Text>
          <If when={moved() && props.openRouting}>
            <Text testID="prompts-moved" class="text-[12px] leading-[1.5] text-ink-muted">
              {`${t().routing.promptsMoved} `}
              <View role="button" class="cursor-pointer select-none" testID="prompts-to-routing" onPress={() => props.openRouting?.()} style={{ verticalAlign: "middle" }}>
                <Text class="text-[12px] text-brand">{t().routing.toRouting}</Text>
              </View>
            </Text>
          </If>
          <View class="flex-row items-center gap-2">
            <Input
              testID="prompts-search"
              value={query()}
              onChange={(e) => query.set(e.value)}
              placeholder={c().search}
              accessibilityLabel={c().search}
              autoCorrect={false}
              autoCapitalize="none"
              class="flex-1 min-w-0 px-3 py-[7px] border border-line rounded-(--radius-md) bg-input-bg text-[13px] text-ink focus:border-field-focus-border"
            />
            <If when={counts().edited > 0}>
              <View role="group" accessibilityLabel={c().filter.edited} class="shrink-0 flex-row items-center gap-[2px] p-[3px] border border-chip-line rounded-(--radius-md) bg-chip">
                <View
                  role="button"
                  testID="prompts-filter-all"
                  accessibilityState={{ selected: !editedOnly() }}
                  onPress={() => onlyEdited.set(false)}
                  class={`cursor-pointer select-none px-[10px] py-1 rounded-(--radius-sm) ${!editedOnly() ? "bg-pane" : ""}`}
                >
                  <Text class={`text-[12px] ${!editedOnly() ? "font-semibold text-brand" : "font-medium text-ink-muted"}`}>{c().filter.all}</Text>
                </View>
                <View
                  role="button"
                  testID="prompts-filter-edited"
                  accessibilityState={{ selected: editedOnly() }}
                  onPress={() => onlyEdited.set(true)}
                  class={`cursor-pointer select-none flex-row items-center gap-[5px] px-[10px] py-1 rounded-(--radius-sm) ${editedOnly() ? "bg-pane" : ""}`}
                >
                  <Text class={`text-[12px] ${editedOnly() ? "font-semibold text-brand" : "font-medium text-ink-muted"}`}>{c().filter.edited}</Text>
                  <View testID="prompts-filter-count" class={`min-w-4 px-[5px] rounded-(--radius-full) items-center ${counts().conflict ? "bg-warn-bg" : "bg-accent-tint"}`}>
                    <Text class={`text-[11px] font-semibold leading-4 ${counts().conflict ? "text-warn-text" : "text-brand"}`}>{String(counts().edited)}</Text>
                  </View>
                </View>
              </View>
            </If>
          </View>
          <If when={props.loadFailed}>
            <Text role="alert" testID="prompts-load-failed" class="text-[12px] text-danger-text">{c().loadFailed}</Text>
          </If>
        </View>
      </If>

      <If when={!narrowWindow() && sectioned()}>
        <SettingsSectionTabs
          id="prompts"
          sections={sections()}
          active={section()}
          label={(of) => c().groups[of]}
          count={editedIn}
          warn={conflictIn}
          icon={icon}
          ariaLabel={t().settings.tabPrompts}
          onPick={openSection}
        />
      </If>

      <Scroll testID="prompts-scroll" accessibilityLabel={t().settings.tabPrompts} class="flex-1 min-h-0">
        <View class={`flex-col ${narrowWindow() ? "gap-4 pt-4 pb-5" : "gap-[18px] pt-4 pb-5"} ${gutter()} ${!inGroup() && !narrowWindow() && !sectioned() ? "pt-[2px]" : ""}`}>
          <If when={inGroup()}>{props.notices}</If>
          <If when={listing()}>
            <SettingsSectionList sections={sections()} label={(of) => c().groups[of]} summary={summary} icon={icon} ariaLabel={t().settings.tabPrompts} onPick={openSection} />
          </If>
          <If when={!listing() && sectioned()}>
            <View testID={`prompt-group-${section()}`} accessibilityLabel={c().groups[section()]} class="flex-col gap-2 min-w-0">
              {groupBody(section(), itemsOf(section()))}
            </View>
          </If>
          <If when={!listing() && !sectioned()}>
            <If when={items().length > 0 && groups().length === 0}>
              <Text role="text" testID="prompts-no-match" class="mx-[2px] my-2 text-[13px] text-ink-muted">{c().noMatch}</Text>
            </If>
            {() =>
              groups().map((row) => (
                <View testID={`prompt-group-${row.group}`} class="flex-col gap-[6px]">
                  <View class="flex-row items-center gap-[6px] min-h-[22px] px-1">
                    <Text role="header" class="text-[12px] font-semibold text-ink-secondary">{c().groups[row.group]}</Text>
                    <Text class="text-[11px] text-ink-muted">{String(row.items.length)}</Text>
                  </View>
                  {groupBody(row.group, row.items)}
                </View>
              ))
            }
          </If>
        </View>
      </Scroll>

      <If when={open() && openItem()}>
        {(item) => (
          <PromptEditorPage
            item={item()}
            open={open()!}
            view={editorView()}
            onViewChange={(view) => editorView.set(view)}
            reveal={editorReveal()}
            onClose={() => void closeEditor()}
            onLocale={(locale) => {
              editorReveal.set(null);
              open.set({ id: open()!.id, locale });
            }}
            onOpenMessage={openMessage}
            onReady={(api) => {
              flushEditor = api.flush;
            }}
          />
        )}
      </If>
    </View>
  );
}
