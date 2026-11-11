/**
 * A job's title row (`overlays/JobHeader.svelte`): the job switcher (a line's own board has its
 * heading instead), how the job stands, when it last moved, your stops over it, and the stop menu
 * and the close button. What sits between the titles and those buttons (`middle`) and beside the
 * stop menu (`end`) is the parent's.
 *
 * Not carried over: `focusSwitcher` (the switcher's popover returns the focus itself).
 */
import type { JSX } from "nsh";
import { Text, View, cleanup, signal } from "nsh";
import type { Bot, Hold, PlanStatus, SessionSummary } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import { planStopItems, type StopChoice } from "../../m/chat/stop-menu.ts";
import type { JobState } from "../../m/overlays/job-state.svelte.ts";
import { countedTicketCount, openTicketCount, parkedTicketCount, planTitle, totalTicketCount } from "../../m/overlays/plan-board.ts";
import { lastChangeLabel } from "../../m/overlays/plan-requirements.ts";
import { holdLabel } from "../../m/sidebar/holds-list.ts";
import { StopMenu } from "../chat/StopMenu";
import { Icon } from "../Icon";
import { tip } from "../tip";
import { TraceJobSwitcher } from "./TraceJobSwitcher";

const STATUS_TONE: Record<string, { box: string; text: string }> = {
  active: { box: "border-accent-border bg-accent-tint", text: "text-brand" },
  done: { box: "border-ok-line bg-ok-bg", text: "text-ok-text" },
};

export function JobHeader(props: {
  job: JobState;
  /** A line of yours filed under no job, drawn as a flow of its own (ADR 0083). */
  line: string | null;
  /** Where the job's own conversation is, said as the trace's cards say it; null when it has none. */
  place: string | null;
  bots: readonly Bot[];
  sessions: readonly SessionSummary[];
  deletedLabel: string;
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  onSelectJob: (id: string) => void;
  /** Your stops in force; null where the daemon has none, and the board then offers no stop. */
  holds?: readonly Hold[] | null;
  /** A choice from the board's stop menu: this job, or every Bot. Resolves to a refusal to show, or nothing. */
  onStop?: (choice: StopChoice) => Promise<unknown> | void;
  /** Resolves to a refusal to show, or nothing. */
  onLift?: (hold: Hold) => Promise<unknown> | void;
  /** The daemon is out of reach: the stop menu and the lifts show but cannot be pressed. */
  controlsDisabled?: boolean;
  /** Absent in a pane: a pane is closed by its own tab, not by a button inside the content. */
  onClose?: () => void;
  middle?: JSX.Element;
  /** What the row says of the job beside its stop menu. */
  end?: JSX.Element;
}) {
  const t = () => copy();
  const job = props.job;
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot]));
  const sessionsById = () => new Map(props.sessions.map((session) => [session.id, session]));
  const planStatus = (): PlanStatus => job.detail?.status ?? (job.trace?.closed_at ? "done" : "active");

  /** 「上次变化 X 前」 ages while the board is open, so the clock it reads ticks now and then. */
  const nowMs = signal(Date.now());
  const timer = setInterval(() => nowMs.set(Date.now()), 30_000);
  cleanup(() => clearInterval(timer));
  const changeLine = () => (job.detail ? lastChangeLabel(job.detail, nowMs(), t().plan) : null);
  const heading = () =>
    props.line
      ? `${t().traceSteps.lineTitle} · ${job.trace?.title ?? ""}`
      : job.trace
        ? `${t().trace.title} · ${planTitle(job.detail ?? job.trace)}`
        : t().trace.title;

  /**
   * What keeps the job parked on the board: its own parking, and any stop over it that waits to be
   * lifted: on a Bot's work in it, on the conversation it belongs to, on everything. A stop for now
   * there is not shown: your next line is the end of it (ADR 0081). Read from the live list, so a
   * stop made anywhere shows at once.
   */
  const boardHolds = (): Hold[] => {
    const holds = props.holds;
    const id = job.currentId;
    if (!holds || !id) return [];
    const home = job.detail?.session_id ?? job.trace?.session_id ?? null;
    return holds.filter(
      (hold) =>
        (hold.scope === "plan" || !hold.lift_on_next_user_message) &&
        (hold.scope === "global" ||
          (hold.scope === "plan" && hold.scope_id === id) ||
          (hold.scope === "bot_plan" && hold.scope_id?.endsWith(`:${id}`)) ||
          (hold.scope === "session" && home !== null && hold.scope_id === home)),
    );
  };
  const stopItems = () =>
    props.holds && job.currentId && props.onStop
      ? planStopItems({ taskId: job.currentId, title: job.trace ? planTitle(job.detail ?? job.trace) : null, holds: props.holds, t: t().control })
      : [];

  /** The stop whose lift was refused, said on its chip until you try again. */
  const liftFailed = signal<string | null>(null);
  async function liftFromBoard(hold: Hold): Promise<void> {
    if (!props.onLift) return;
    liftFailed.set(null);
    try {
      if (await props.onLift(hold)) liftFailed.set(hold.id);
    } catch {
      liftFailed.set(hold.id);
    }
  }
  const holdText = (hold: Hold): string =>
    holdLabel(hold, {
      bots: botsById(),
      sessions: sessionsById(),
      roster: { deleted: props.deletedLabel, archived: props.deletedLabel },
      t: t().control,
    });

  /** The meta line: status, kind, ticket counts, where the conversation is, the job's folder. */
  const metaTail = (): string => {
    const detail = job.detail;
    let out = "";
    if (detail?.kind) out += ` · ${detail.kind}`;
    if (detail && totalTicketCount(detail.ticket_counts) > 0) {
      out += ` · ${t().plan.ticketCounts(openTicketCount(detail.ticket_counts), countedTicketCount(detail.ticket_counts), parkedTicketCount(detail.ticket_counts))}`;
    }
    if (props.place) out += ` · ${props.place}`;
    return out;
  };

  return (
    <View class="relative z-10 border-b border-line bg-pane" testID="job-header">
      <View class="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-[10px] pt-3 pr-[14px] pb-[10px] pl-[14px]">
        <View class="flex-1 min-w-0 gap-[2px]" style={{ flexBasis: 0 }}>
          <If
            when={!props.line}
            else={
              <Text role="header" testID="trace-line-title" tooltip={tip(job.trace?.title ?? "")} class="text-[14px] font-semibold text-ink line-clamp-1">
                {heading()}
              </Text>
            }
          >
            <TraceJobSwitcher
              jobs={job.jobs.slice()}
              currentId={job.currentId}
              heading={heading()}
              open={props.switcherOpen}
              onOpenChange={props.onSwitcherOpenChange}
              onSelectJob={props.onSelectJob}
            />
            <If when={job.trace}>
              {(trace) => (
                <>
                  <View testID="job-meta" class="flex-row items-center flex-wrap gap-y-[2px]">
                    <View class={`px-[6px] rounded-full border ${STATUS_TONE[planStatus()]?.box ?? "border-line bg-chip"}`}>
                      <Text testID="job-status" class={`text-[11px] font-semibold leading-[16px] ${STATUS_TONE[planStatus()]?.text ?? "text-ink-muted"}`}>
                        {t().plan.status[planStatus()]}
                      </Text>
                    </View>
                    <If when={job.detail?.dormant_since}>
                      <View tooltip={tip(t().plan.dormantHint)} class="ml-1 px-[6px] rounded-full border border-dashed border-line-hover">
                        <Text testID="job-dormant" class="text-[11px] font-semibold leading-[16px] text-ink-muted">{t().plan.dormant}</Text>
                      </View>
                    </If>
                    <Text class="text-[12px] text-ink-muted">
                      {metaTail()}
                      {" · "}
                      <Text class="text-[12px] font-mono text-ink-muted">{trace().dir}</Text>
                    </Text>
                  </View>
                  <If when={changeLine()}>
                    {(line) => (
                      <Text
                        testID="job-change"
                        tooltip={job.detail?.last_change ? tip(formatFullTimestamp(job.detail.last_change.at)) : undefined}
                        class="text-[11px] text-ink-muted line-clamp-1"
                      >
                        {line()}
                      </Text>
                    )}
                  </If>
                  <If when={boardHolds().length > 0}>
                    <View role="list" accessibilityLabel={t().control.holdsTitle} testID="job-holds" class="flex-row flex-wrap gap-x-[6px] gap-y-1 mt-1">
                      <Each of={boardHolds()} key={(hold) => hold.id}>
                        {(hold) => (
                          <View
                            testID={`job-hold-${hold().id}`}
                            class="flex-row items-center gap-[5px] max-w-full min-h-[22px] pl-[7px] pr-1 rounded-full border border-line bg-chip"
                          >
                            <Icon name="pause" size={12} class="tint-ink-secondary" />
                            <Text class="shrink min-w-0 text-[11px] text-ink-secondary line-clamp-1">{holdText(hold())}</Text>
                            <If
                              when={liftFailed() === hold().id}
                              else={<Text class="shrink-0 text-[11px] font-mono text-ink-muted">{formatMessageTime(hold().created_at)}</Text>}
                            >
                              <Text role="text" testID="job-hold-error" class="shrink-0 text-[11px] text-danger-text">{t().control.failed}</Text>
                            </If>
                            <If when={props.onLift}>
                              <View
                                role="button"
                                testID={`job-hold-lift-${hold().id}`}
                                disabled={props.controlsDisabled}
                                onPress={() => void liftFromBoard(hold())}
                                class="cursor-pointer select-none disabled:cursor-default group shrink-0 px-[7px] py-px rounded-full border border-accent-border bg-pane hover:bg-brand hover:border-brand disabled:opacity-[0.5]"
                              >
                                <Text class="text-[11px] font-medium text-brand group-hover:text-on-accent">{t().control.lift}</Text>
                              </View>
                            </If>
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>
                </>
              )}
            </If>
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-2">
          {props.end}
          <If when={stopItems().length > 0 && props.onStop}>
            <StopMenu
              items={stopItems()}
              placement="below"
              size="sm"
              label={t().control.stop}
              disabled={props.controlsDisabled}
              onPick={(item) => props.onStop?.(item.choice)}
            />
          </If>
          <If when={props.onClose}>
            <View
              role="button"
              testID="job-close"
              accessibilityLabel={t().common.close}
              tooltip={tip(t().common.close)}
              onPress={() => props.onClose?.()}
              class="cursor-pointer select-none w-7 h-7 items-center justify-center rounded-(--radius-sm) hover:bg-line-subtle"
            >
              <Icon name="x" size={16} class="tint-ink-muted" />
            </View>
          </If>
        </View>
        {props.middle}
      </View>
    </View>
  );
}
