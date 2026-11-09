/**
 * A group's settings (`GroupPane.svelte`), or a Bot↔Bot direct's: who is in it (with the lead, and
 * pulling a Bot in or taking one out), the conversation's archive, mute and engine, and the danger
 * zone. On a phone it is two screens, like the settings page: the sections as a list, and one
 * section at a time on top of it (`mobileDetail`, which the shell holds so Back can unwind it);
 * wider windows keep the single scrolling column of cards.
 *
 * `bind:detail` and `bind:mobileDetail` are the value plus `onDetailChange` and
 * `onMobileDetailChange`; the exported `backFromDetail()` is `onHandle`.
 */
import { Scroll, Text, View, effect, signal, untracked } from "nsh";
import { USER_MEMBER, type Bot, type SessionSummary } from "@real-bot/protocol";
import { avatarSrc, botAvatarColor, isFolkAvatar } from "../../m/avatar";
import { canRemoveGroupBot, pullInCandidates, type GroupDetailDraft } from "../../m/panels/group-edit";
import { rosterLetter } from "../../m/sidebar/roster-letter";
import { classifySession, presentBotIds } from "../../m/sidebar/session-groups";
import { copy, runtime } from "../../runtime";
import { AvatarPicture } from "../AvatarPicture";
import { Icon, type IconName } from "../Icon";
import { narrowWindow } from "../Modal";
import { Select } from "../Select";
import { cssColor } from "../styles";
import { tip } from "../tip";
import { PlaybookPicker } from "./PlaybookPicker";
import { SessionMuteRow } from "./SessionMuteRow";
import { SettingsSubject } from "./SettingsSubject";
import { PANEL_CARD, PANEL_CARD_BODY, PANEL_CARD_HEAD, PANEL_CARD_TITLE, PANEL_COUNTER } from "./panel-card";

export type { GroupDetailDraft };

type GroupSection = "members" | "actions" | "danger";

export type GroupPaneApi = {
  /** On a phone, from a section back to the list; says whether it was open. */
  backFromDetail: () => boolean;
};

/** `.member-avatar-mini`: a Bot's initial (or picture) in its colours. */
function MemberAvatar(props: { bot: Bot | undefined; you?: boolean }) {
  const failed = signal<string | null>(null);
  const colors = () => (props.bot ? botAvatarColor(props.bot.id) : null);
  return (
    <View
      accessible={false}
      class={`w-[32px] h-[32px] shrink-0 items-center justify-center overflow-hidden border ${props.you ? "bg-ink" : ""}`}
      style={{
        borderRadius: 10,
        backgroundColor: props.you ? undefined : props.bot ? cssColor(colors()!.bg) : cssColor("var(--line-subtle)"),
        borderColor: props.you ? "transparent" : props.bot ? cssColor(colors()!.border) : cssColor("var(--line)"),
      }}
    >
      <If when={props.you}>
        <Text class="text-[13px] font-bold text-pane">{rosterLetter(copy().common.you)}</Text>
      </If>
      <If when={!props.you && props.bot ? props.bot : null} else={<If when={!props.you}><Text class="text-[13px] font-bold text-ink-muted">?</Text></If>}>
        {(bot) => (
          <If
            when={isFolkAvatar(bot().avatar) || (avatarSrc(bot().avatar) && failed() !== avatarSrc(bot().avatar))}
            else={<Text class="text-[13px] font-bold" style={{ color: cssColor(colors()!.text) }}>{rosterLetter(bot().name)}</Text>}
          >
            <AvatarPicture avatar={bot().avatar} onError={() => failed.set(avatarSrc(bot().avatar))} />
          </If>
        )}
      </If>
    </View>
  );
}

/** `.member-badge`. */
function Badge(props: { kind: "owner" | "lead" | "model"; hint?: string; children: string }) {
  const box = () =>
    props.kind === "owner" ? "bg-chip border-chip-line" : props.kind === "lead" ? "bg-brand border-brand" : "bg-accent-tint border-accent-border max-w-[140px]";
  const ink = () => (props.kind === "owner" ? "text-ink-muted" : props.kind === "lead" ? "text-on-accent" : "text-brand font-mono");
  return (
    <View tooltip={props.hint ? tip(props.hint) : undefined} class={`px-[6px] py-[1px] rounded-full border shrink-0 ${box()}`}>
      <Text class={`text-[11px] font-medium line-clamp-1 ${ink()}`}>{props.children}</Text>
    </View>
  );
}

function Member(props: { children: import("nsh").JSX.Element; you?: boolean; testID?: string }) {
  return (
    <View
      testID={props.testID}
      class={`flex-row items-center justify-between gap-3 px-[10px] py-2 rounded-(--radius-md) border hover:border-line hover:bg-pane ${props.you ? "bg-pane border-line-subtle" : "bg-line-subtle border-transparent"}`}
    >
      {props.children}
    </View>
  );
}

/** A small flat button on a member's row (`.btn-lead`, `.btn-remove-member`). */
function RowAction(props: { testID: string; label: string; icon?: IconName; hint?: string; danger?: boolean; suggested?: boolean; disabled?: boolean; onPress: () => void }) {
  const on = () => props.suggested === true;
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      tooltip={props.hint ? tip(props.hint) : undefined}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none disabled:cursor-default group flex-row items-center gap-1 px-2 py-1 rounded-(--radius-sm) border shrink-0 disabled:opacity-[0.45] ${
        props.danger
          ? "border-transparent hover:bg-danger-bg hover:border-danger-line"
          : on()
            ? "bg-accent-tint border-accent-border"
            : "border-transparent hover:bg-accent-tint hover:border-accent-border"
      }`}
    >
      <If when={props.icon}>
        {(name) => <Icon name={name()} size={12} class={props.danger ? "tint-ink-muted group-hover:tint-danger-text" : "tint-ink-muted group-hover:tint-brand"} />}
      </If>
      <Text class={`text-[12px] font-medium ${props.danger ? "text-ink-muted group-hover:text-danger-text" : on() ? "text-brand" : "text-ink-muted group-hover:text-brand"}`}>
        {props.label}
      </Text>
    </View>
  );
}

/** `.action-btn`: a small button beside what it does; `deny` is the red one. */
function ActionButton(props: { testID: string; icon: IconName; deny?: boolean; onPress: () => void; children: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.children}
      onPress={() => props.onPress()}
      class={`cursor-pointer select-none group flex-row items-center justify-center gap-[6px] px-[14px] py-[6px] rounded-(--radius-md) border shrink-0 ${
        props.deny ? "bg-btn-secondary-bg border-danger-line hover:bg-danger-bg hover:border-danger" : "bg-btn-secondary-bg border-line hover:bg-line-subtle hover:border-line-hover"
      }`}
    >
      <Icon name={props.icon} size={16} class={props.deny ? "tint-danger-text" : "tint-ink-secondary group-hover:tint-ink"} />
      <Text class={`text-[12px] font-semibold ${props.deny ? "text-danger-text" : "text-ink-secondary group-hover:text-ink"}`}>{props.children}</Text>
    </View>
  );
}

function ActionInfo(props: { title: string; desc: string; danger?: boolean }) {
  return (
    <View class="flex-1 min-w-0 gap-[2px]">
      <Text class={`text-[13px] font-semibold ${props.danger ? "text-danger-text" : "text-ink"}`}>{props.title}</Text>
      <Text class="text-[12px] text-ink-muted">{props.desc}</Text>
    </View>
  );
}

export function GroupPane(props: {
  selected: SessionSummary;
  detail: GroupDetailDraft;
  onDetailChange: (detail: GroupDetailDraft) => void;
  /** Phone only: a section is open on top of the list. The shell owns it so Back can unwind it. */
  mobileDetail?: boolean;
  onMobileDetailChange?: (open: boolean) => void;
  onOpenProfile: (botId: string) => void;
  onDeleteGroup: () => void;
  onClearHistory: () => void;
  onHandle?: (api: GroupPaneApi) => void;
}) {
  const t = () => copy();
  const phone = () => narrowWindow();
  const activeSection = signal<GroupSection>("members");
  const shows = (section: GroupSection) => !phone() || (props.mobileDetail === true && activeSection() === section);
  const patch = (change: Partial<GroupDetailDraft>) => props.onDetailChange({ ...props.detail, ...change });

  function openSection(section: GroupSection): void {
    activeSection.set(section);
    props.onMobileDetailChange?.(true);
  }

  /** The shell's Back button and the browser's both come through here first. */
  function backFromDetail(): boolean {
    if (!props.mobileDetail) return false;
    props.onMobileDetailChange?.(false);
    return true;
  }
  props.onHandle?.({ backFromDetail });

  const sectionLabel = (section: GroupSection) =>
    section === "members" ? t().detail.members : section === "actions" ? t().detail.sessionActions : t().detail.dangerZone;

  const snapshot = () => runtime.snapshot;
  const locale = () => (snapshot().settings.locale === "en" ? "en" : "zh");
  const zh = () => locale() === "zh";
  const botsById = () => new Map(snapshot().bots.map((b) => [b.id, b] as const));
  const visibleBots = () => snapshot().bots.filter((b) => !b.archived_at);
  const selected = () => props.selected;
  const isGroup = () => selected().kind === "group";
  const selectedKind = () => classifySession(selected());
  const groupPresent = () => presentBotIds(selected());
  const groupCanRemove = () => (isGroup() ? canRemoveGroupBot(selected()) : false);
  const groupCandidates = () => (isGroup() ? pullInCandidates(visibleBots(), selected()) : []);
  function memberLabel(id: string): string {
    if (id === USER_MEMBER) return t().common.you;
    const bot = botsById().get(id);
    if (!bot) return t().top.deleted;
    return bot.archived_at ? `${bot.name} · ${t().top.archived}` : bot.name;
  }

  async function pullInMember(): Promise<void> {
    if (!isGroup() || !props.detail.pullPick) return;
    patch({ failed: false });
    const error = await runtime.addMember(selected().id, props.detail.pullPick);
    if (error) {
      patch({ failed: true });
      return;
    }
    patch({ pullPick: "" });
  }

  /**
   * The lead is a property of a member, so it is set on the member's row: one click is the
   * confirmation (nothing here is a guess the daemon made for you), and the same button on the
   * current lead takes it back. The daemon's suggestion is only ever a hint on the row.
   */
  const leadState = () => runtime.groupLeads[selected().id] ?? null;
  const leadAvailable = () => isGroup() && !runtime.groupLeadUnsupported[selected().id];
  const leadId = () => leadState()?.confirmed_bot_id ?? null;
  const leadPresent = () => leadId() !== null && groupPresent().includes(leadId()!);
  const leadSuggestion = () => {
    const state = leadState();
    return state?.suggestion && state.suggestion.bot_id !== leadId() ? state.suggestion : null;
  };
  const leadPending = signal(false);
  const leadFailed = signal(false);
  effect(() => {
    const id = selected().id;
    leadFailed.set(false);
    if (isGroup() && runtime.connection === "connected") void untracked(() => runtime.loadGroupLead(id));
  });

  async function setLead(botId: string | null): Promise<void> {
    if (!isGroup() || leadPending()) return;
    leadPending.set(true);
    leadFailed.set(false);
    try {
      leadFailed.set(Boolean(await runtime.confirmGroupLead(selected().id, botId)));
    } catch {
      leadFailed.set(true);
    } finally {
      leadPending.set(false);
    }
  }

  async function removeMember(botId: string): Promise<void> {
    if (!isGroup() || !groupCanRemove()) return;
    patch({ failed: false });
    const error = await runtime.removeMember(selected().id, botId);
    if (error) patch({ failed: true });
  }

  /** One Bot's row; a group's adds the lead and the buttons. */
  const BotRow = (rowProps: { botId: string; withActions: boolean }) => {
    const bot = () => botsById().get(rowProps.botId);
    return (
      <Member testID={`member-${rowProps.botId}`}>
        <View class="flex-row items-center gap-[10px] min-w-0 flex-1">
          <MemberAvatar bot={bot()} />
          <If
            when={bot()}
            else={
              <View class="flex-col min-w-0 flex-1 gap-[2px]">
                <Text class="text-[12px] text-ink-muted italic">{t().top.deleted}</Text>
              </View>
            }
          >
            {(row) => (
              <View class="flex-col min-w-0 flex-1 gap-[2px]">
                <View class="flex-row flex-wrap items-center gap-x-[6px] gap-y-[2px] min-w-0">
                  <View
                    role="button"
                    testID={`member-open-${row().id}`}
                    accessibilityLabel={memberLabel(rowProps.botId)}
                    tooltip={tip(zh() ? "查看并编辑 Bot 人设" : "View & edit bot profile")}
                    onPress={() => props.onOpenProfile(row().id)}
                    class="cursor-pointer select-none group max-w-full"
                  >
                    <Text class="text-[13px] font-semibold text-ink group-hover:text-brand line-clamp-1">{memberLabel(rowProps.botId)}</Text>
                  </View>
                  <If when={rowProps.withActions && rowProps.botId === leadId()}>
                    <Badge kind="lead" hint={t().groupLead.badgeHint}>{t().groupLead.badge}</Badge>
                  </If>
                  <If when={row().model}>
                    <Badge kind="model" hint={row().model ?? ""}>{row().model ?? ""}</Badge>
                  </If>
                </View>
                <If when={row().duties}>
                  <Text class="text-[12px] text-ink-muted line-clamp-1">{row().duties}</Text>
                </If>
                <If when={rowProps.withActions && leadSuggestion()?.bot_id === rowProps.botId ? leadSuggestion() : null}>
                  {(suggestion) => <Text class="text-[12px] text-brand">{t().groupLead.suggested(suggestion().handoffs)}</Text>}
                </If>
              </View>
            )}
          </If>
        </View>
        <If when={rowProps.withActions ? bot() : null}>
          {(row) => (
            <View class="flex-row items-center gap-[2px] shrink-0">
              <If when={leadAvailable() && leadState() && (rowProps.botId === leadId() || !row().archived_at)}>
                <RowAction
                  testID={`member-lead-${row().id}`}
                  label={rowProps.botId === leadId() ? t().groupLead.clear : t().groupLead.set}
                  suggested={leadSuggestion()?.bot_id === rowProps.botId}
                  disabled={leadPending()}
                  onPress={() => void setLead(rowProps.botId === leadId() ? null : rowProps.botId)}
                />
              </If>
              <RowAction
                testID={`member-remove-${row().id}`}
                label={t().detail.remove}
                icon="x"
                danger
                disabled={!groupCanRemove()}
                hint={!groupCanRemove() ? (zh() ? "群内至少需保留 2 个 Bot" : "Keep at least 2 bots") : t().detail.remove}
                onPress={() => void removeMember(rowProps.botId)}
              />
            </View>
          )}
        </If>
      </Member>
    );
  };

  const sectionRows = (): { id: GroupSection; icon: IconName; name: string; count?: number; danger?: boolean }[] => [
    { id: "members", icon: "user", name: t().detail.members, count: isGroup() ? groupPresent().length + 1 : groupPresent().length },
    ...(isGroup() ? [{ id: "actions" as const, icon: "archive" as const, name: t().detail.sessionActions }] : []),
    { id: "danger", icon: "alert-triangle", name: t().detail.dangerZone, danger: true },
  ];

  const showList = () => !phone() || !props.mobileDetail;
  const showDetail = () => !phone() || props.mobileDetail === true;

  return (
    <View testID="group-pane" class="flex-1 min-h-0 overflow-hidden">
      {/* Phone only: the sections as a list. Wider windows show them all at once. */}
      <If when={phone() && showList()}>
        <Scroll testID="group-sections" accessibilityLabel={isGroup() ? t().detail.titleGroup : t().detail.titleBot} class="flex-1 bg-sidebar-bg">
          <View class="px-3 pt-[14px] pb-6">
            <View class="rounded-(--radius-lg) overflow-hidden">
              <Each of={sectionRows()} key={(row) => row.id}>
                {(row, index) => (
                  <View
                    role="button"
                    testID={`group-section-${row().id}`}
                    accessibilityLabel={row().name}
                    onPress={() => openSection(row().id)}
                    class={`cursor-pointer select-none flex-row items-center gap-[10px] min-h-[54px] px-[14px] bg-pane active:bg-row-hover ${index() > 0 ? "border-t border-line" : ""}`}
                  >
                    <Icon name={row().icon} size={20} class={row().danger ? "tint-danger" : "tint-ink-muted"} />
                    <Text class="flex-1 min-w-0 text-[15px] font-medium text-ink">{row().name}</Text>
                    <If when={row().count !== undefined}>
                      <Text class="ml-2 text-[13px] text-ink-muted">{String(row().count)}</Text>
                    </If>
                    <Icon name="chevron-right" size={16} class="tint-ink-muted ml-2" />
                  </View>
                )}
              </Each>
            </View>
          </View>
        </Scroll>
      </If>

      <If when={showDetail()}>
        <View testID="group-detail" class="flex-1 min-h-0 bg-bg">
          <If when={phone()}>
            <View testID="group-detail-head" class="flex-row items-center gap-1 shrink-0 min-h-[56px] pl-1 pr-3 bg-pane border-b border-line">
              <View
                role="button"
                testID="group-detail-back"
                accessibilityLabel={t().detail.backToSections}
                onPress={() => backFromDetail()}
                class="cursor-pointer select-none w-[44px] h-[44px] items-center justify-center rounded-(--radius-md) shrink-0 active:bg-row-hover"
              >
                <Icon name="chevron-left" size={20} class="tint-brand" />
              </View>
              <View class="flex-1 min-w-0 gap-[1px]">
                <Text role="header" testID="group-detail-title" class="text-[16px] font-semibold text-ink">{sectionLabel(activeSection())}</Text>
                <SettingsSubject variant="line" session={selected()} bots={botsById()} />
              </View>
            </View>
          </If>

          <Scroll class="flex-1 min-h-0">
            <View class={`flex-col gap-8 ${phone() ? "pt-4 px-3 pb-7" : "pt-9 px-9 pb-12"}`}>
              <If when={isGroup() && props.detail.failed}>
                <View role="alert" testID="group-failed" class="flex-row items-center gap-2 px-[14px] py-[10px] rounded-(--radius-md) bg-danger-bg border border-danger-line">
                  <Icon name="alert-circle" class="tint-danger-text" />
                  <Text class="text-[13px] font-medium text-danger-text">{t().detail.saveFailed}</Text>
                </View>
              </If>

              {/* Group members */}
              <If when={isGroup() && shows("members")}>
                <View testID="group-members-card" class={PANEL_CARD}>
                  <View class={PANEL_CARD_HEAD}>
                    <Text class={PANEL_CARD_TITLE}>{t().detail.members}</Text>
                    <View class={PANEL_COUNTER}>
                      <Text class="text-[11px] font-semibold text-ink-secondary">{String(groupPresent().length + 1)}</Text>
                    </View>
                  </View>
                  <View class={PANEL_CARD_BODY}>
                    <View class="gap-[6px]">
                      <Member you testID="member-you">
                        <View class="flex-row items-center gap-[10px] min-w-0 flex-1">
                          <MemberAvatar bot={undefined} you />
                          <View class="flex-row flex-wrap items-center gap-x-[6px] gap-y-[2px] min-w-0 flex-1">
                            <Text class="text-[13px] font-semibold text-ink line-clamp-1">{t().common.you}</Text>
                            <Badge kind="owner">{zh() ? "创建者" : "Owner"}</Badge>
                          </View>
                        </View>
                      </Member>
                      <Each of={groupPresent()} key={(id) => id}>{(botId) => <BotRow botId={botId()} withActions />}</Each>
                    </View>

                    <If when={leadAvailable()}>
                      <If when={runtime.groupLeadLoadError[selected().id]}>
                        <View class="flex-row flex-wrap items-center mt-[10px]">
                          <Text role="alert" testID="lead-note" class="text-[12px] text-danger-text">{t().groupLead.loadFailed}</Text>
                          <View
                            role="button"
                            testID="lead-retry"
                            accessibilityLabel={t().groupLead.retry}
                            disabled={leadPending()}
                            onPress={() => void runtime.loadGroupLead(selected().id)}
                            class="cursor-pointer select-none disabled:cursor-default pl-1 disabled:opacity-[0.45]"
                          >
                            <Text class="text-[12px] text-brand underline">{t().groupLead.retry}</Text>
                          </View>
                        </View>
                      </If>
                      <If when={!runtime.groupLeadLoadError[selected().id] && leadFailed()}>
                        <Text role="alert" testID="lead-note" class="mt-[10px] text-[12px] text-danger-text">{t().groupLead.failed}</Text>
                      </If>
                      <If when={!runtime.groupLeadLoadError[selected().id] && !leadFailed() && leadState()}>
                        <Text testID="lead-note" class="mt-[10px] text-[12px] text-ink-muted">{leadPresent() ? t().groupLead.confirmed : t().groupLead.unconfirmed}</Text>
                      </If>
                      <If when={!runtime.groupLeadLoadError[selected().id] && !leadFailed() && !leadState() && runtime.groupLeadLoading[selected().id]}>
                        <Text role="text" testID="lead-note" class="mt-[10px] text-[12px] text-ink-muted">{t().groupLead.loading}</Text>
                      </If>
                    </If>

                    <If when={groupCandidates().length > 0}>
                      <View testID="pull-in" class="mt-3 pt-3 border-t border-line-subtle flex-row items-center gap-2">
                        <View class="flex-1 min-w-0">
                          <Select
                            testID="pull-in-select"
                            value={props.detail.pullPick}
                            onChange={(value) => patch({ pullPick: value })}
                            placeholder={t().detail.pullIn}
                            emptyLabel={t().detail.pullIn}
                            options={groupCandidates().map((bot) => ({ value: bot.id, label: bot.name }))}
                            size="sm"
                          />
                        </View>
                        <View
                          role="button"
                          testID="pull-in-add"
                          accessibilityLabel={t().detail.pullIn}
                          disabled={!props.detail.pullPick}
                          onPress={() => void pullInMember()}
                          class={`cursor-pointer select-none disabled:cursor-default group flex-row items-center gap-[5px] px-3 py-[6px] rounded-(--radius-md) border shrink-0 ${
                            props.detail.pullPick ? "bg-accent-tint border-accent-border hover:bg-brand hover:border-brand" : "bg-line-subtle border-line opacity-[0.45]"
                          }`}
                        >
                          <Icon name="plus" size={12} class={props.detail.pullPick ? "tint-brand group-hover:tint-on-accent" : "tint-ink-muted"} />
                          <Text class={`text-[12px] font-semibold ${props.detail.pullPick ? "text-brand group-hover:text-on-accent" : "text-ink-muted"}`}>{t().detail.pullIn}</Text>
                        </View>
                      </View>
                    </If>
                  </View>
                </View>
              </If>
              <If when={!isGroup() && selectedKind() === "bot-bot" && shows("members")}>
                <View testID="group-members-card" class={PANEL_CARD}>
                  <View class={PANEL_CARD_HEAD}>
                    <Text class={PANEL_CARD_TITLE}>{t().detail.members}</Text>
                    <View class={PANEL_COUNTER}>
                      <Text class="text-[11px] font-semibold text-ink-secondary">{String(groupPresent().length)}</Text>
                    </View>
                  </View>
                  <View class={PANEL_CARD_BODY}>
                    <View class="gap-[6px]">
                      <Each of={groupPresent()} key={(id) => id}>{(botId) => <BotRow botId={botId()} withActions={false} />}</Each>
                    </View>
                  </View>
                </View>
              </If>

              {/* Session actions (archive / restore, mute, engine) */}
              <If when={isGroup() && shows("actions")}>
                <View testID="group-actions-card" class={PANEL_CARD}>
                  <View class={PANEL_CARD_HEAD}>
                    <Text class={PANEL_CARD_TITLE}>{t().detail.sessionActions}</Text>
                  </View>
                  <View class={PANEL_CARD_BODY}>
                    <View class="flex-row items-center justify-between gap-[14px]">
                      <ActionInfo
                        title={selected().archived_at ? t().sidebar.restore : t().sidebar.archive}
                        desc={
                          selected().archived_at
                            ? zh() ? "恢复此群组到活跃会话列表" : "Restore group to active sidebar"
                            : zh() ? "从侧栏移入已归档列表，保留历史消息" : "Move to archived sessions without deleting history"
                        }
                      />
                      <If
                        when={selected().archived_at}
                        else={
                          <ActionButton testID="group-archive" icon="archive" onPress={() => void runtime.archiveSession(selected().id)}>
                            {t().sidebar.archive}
                          </ActionButton>
                        }
                      >
                        <ActionButton testID="group-restore" icon="rotate-ccw" onPress={() => void runtime.restoreSession(selected().id)}>
                          {t().sidebar.restore}
                        </ActionButton>
                      </If>
                    </View>
                    <View class="mt-4 pt-4 border-t border-line">
                      <SessionMuteRow sessionId={selected().id} />
                    </View>
                    <View class="mt-4 pt-4 border-t border-line">
                      <PlaybookPicker sessionId={selected().id} />
                    </View>
                  </View>
                </View>
              </If>

              {/* Danger zone (clear history / delete group) */}
              <If when={shows("danger")}>
                <View testID="group-danger-zone" class="bg-pane border border-danger-line rounded-(--radius-lg) min-w-0">
                  <View class="flex-row items-center justify-between px-4 py-3 border-b border-danger-line bg-danger-bg rounded-t-(--radius-lg)">
                    <Text class="text-[12px] font-semibold text-danger-text">{t().detail.dangerZone}</Text>
                  </View>
                  <View class={`${PANEL_CARD_BODY} gap-6`}>
                    <View class="flex-row items-center justify-between gap-[14px]">
                      <ActionInfo
                        title={t().detail.clearHistory}
                        desc={zh() ? "清空所有聊天消息、轮次和上下文，不可撤销" : "Clear all messages and turns in this group"}
                      />
                      <ActionButton testID="group-clear-history" icon="rotate-ccw" onPress={props.onClearHistory}>
                        {t().detail.clearHistory}
                      </ActionButton>
                    </View>
                    <If when={isGroup()}>
                      <View class="flex-row items-center justify-between gap-[14px]">
                        <ActionInfo
                          danger
                          title={t().detail.deleteGroup}
                          desc={zh() ? "永久解散此群组并删除记录，名册上的 Bot 保留" : "Permanently delete this group; member bots remain"}
                        />
                        <ActionButton testID="group-delete" icon="trash" deny onPress={props.onDeleteGroup}>
                          {t().detail.deleteGroup}
                        </ActionButton>
                      </View>
                    </If>
                  </View>
                </View>
              </If>
            </View>
          </Scroll>
        </View>
      </If>
    </View>
  );
}
