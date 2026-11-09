/**
 * Which job a trace or the task map shows (`TraceJobSwitcher.svelte`): its title as a menu of the
 * conversation's jobs, a popover on a desktop and a sheet from the bottom on a phone. The jobs that
 * were one question and its answer fold into a row (a phone's sheet) or a column of their own beside
 * the list (the popover), so the jobs that were work stay in view; the one on screen never folds.
 * Open state is the caller's (`open` / `onOpenChange`). The Svelte component's `focusTrigger` is not
 * ported: the popover returns the focus itself.
 */
import { Text, View, effect, keymap, signal, type ViewRef } from "nsh";
import { Popover } from "nsh/base";
import type { PlanStatus, SessionTaskSummary } from "@real-bot/protocol";
import { countedTicketCount, isOneShot, openTicketCount, parkedTicketCount, planTitle, totalTicketCount } from "../../m/overlays/plan-board";
import { copy } from "../../runtime";
import { BottomSheet } from "../BottomSheet";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";

type Kind = "work" | "oneShot";

/** A row from a daemon that predates plans has neither a status nor counts. */
const planStatusOf = (job: SessionTaskSummary): PlanStatus => job.status ?? (job.closed_at ? "done" : "active");

const STATUS_CLASS: Record<string, string> = {
  active: "border-accent-border bg-accent-tint text-brand",
  done: "border-ok-line bg-ok-bg text-ok-text",
};

export function TraceJobSwitcher(props: {
  jobs: readonly SessionTaskSummary[];
  currentId: string | null;
  heading: string;
  t?: unknown;
  /** Open (controlled), and told when it should change. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectJob: (id: string) => void;
}) {
  const t = () => copy();
  const open = () => props.open === true;
  const setOpen = (v: boolean) => props.onOpenChange?.(v);
  const phone = () => narrowWindow();

  // The jobs that were one question and its answer fold away; the one on screen never folds.
  const folded = () => props.jobs.filter((job) => job.id !== props.currentId && isOneShot(job));
  const listed = () => props.jobs.filter((job) => !folded().includes(job));
  const foldOpen = signal(false);
  const kind = signal<Kind>("work");
  const twoKinds = () => listed().length > 0 && folded().length > 0;
  const kinds = (): { key: Kind; count: number }[] => [
    { key: "work", count: listed().length },
    { key: "oneShot", count: folded().length },
  ];
  const shown = () => (twoKinds() ? (kind() === "work" ? listed() : folded()) : listed().length > 0 ? listed() : folded());

  // A menu that opens again opens compact, on the work.
  effect(() => {
    if (!open()) {
      foldOpen.set(false);
      kind.set("work");
    }
  });

  // Up and Down walk the rows while the menu is open.
  const rows: ViewRef[] = [];
  const kindRows: Record<string, ViewRef | null> = {};
  const cursor = (step: number) => {
    const live = rows.filter(Boolean);
    if (live.length === 0) return;
    const at = live.findIndex((r) => (r as unknown as { __focused?: boolean }).__focused);
    const next = live[(at + step + live.length) % live.length] ?? live[0]!;
    next.focus();
  };
  let focusedAt = -1;
  effect(() => {
    if (!open()) return;
    return keymap.bind(
      {
        down: () => {
          const live = rows.filter(Boolean);
          focusedAt = live.length ? (focusedAt + 1) % live.length : -1;
          live[focusedAt]?.focus();
        },
        up: () => {
          const live = rows.filter(Boolean);
          focusedAt = live.length ? (focusedAt - 1 + live.length) % live.length : -1;
          live[focusedAt]?.focus();
        },
      },
      { when: "always" },
    );
  });
  void cursor;

  const statusPill = (job: SessionTaskSummary) => {
    const status = planStatusOf(job);
    return (
      <View class={`px-[6px] rounded-full border ${STATUS_CLASS[status] ?? "border-line bg-chip text-ink-muted"}`} style={{ alignSelf: "center" }}>
        <Text class={`text-[11px] font-semibold ${STATUS_CLASS[status]?.split(" ").pop() ?? "text-ink-muted"}`}>{t().plan.status[status]}</Text>
      </View>
    );
  };

  const JobRow = (p: { job: SessionTaskSummary }) => {
    const job = () => p.job;
    const current = () => job().id === props.currentId;
    const total = () => totalTicketCount(job().ticket_counts);
    return (
      <View
        role="option"
        testID={`trace-job-${job().id}`}
        accessibilityState={{ selected: current() }}
        ref={(node) => {
          if (node) rows.push(node);
        }}
        onPress={() => props.onSelectJob(job().id)}
        class={`cursor-pointer select-none flex-row items-start w-full rounded-(--radius-sm) border focus:bg-chip hover:bg-chip ${phone() ? "gap-3 min-h-[56px] px-3 py-[10px] rounded-(--radius-md)" : "gap-2 px-2 py-[6px]"} ${current() ? "bg-accent-tint border-accent-border" : "border-transparent"}`}
      >
        <View class="shrink-0 w-[14px] h-[14px] mt-[2px] items-center justify-center">
          <If when={current()}>
            <Icon name="check" size={12} class="tint-brand" />
          </If>
        </View>
        <View class="flex-1 min-w-0 gap-[2px]">
          <Text class={`${phone() ? "text-[15px]" : "text-[12px]"} line-clamp-1 ${current() ? "text-brand font-medium" : "text-ink"}`}>{planTitle(job())}</Text>
          <View class="flex-row items-center flex-wrap gap-[4px]">
            {statusPill(job())}
            <Text class={`text-[11px] line-clamp-1 flex-1 min-w-0 ${current() ? "text-brand" : "text-ink-muted"}`}>
              {`${total() > 0 ? ` · ${t().plan.ticketCounts(openTicketCount(job().ticket_counts), countedTicketCount(job().ticket_counts), parkedTicketCount(job().ticket_counts))}` : ""} · ${job().dir}`}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  /** The jobs as a phone's sheet lists them: the work, then a fold row for the one-question ones. */
  const SheetList = () => (
    <View role="list" accessibilityLabel={t().trace.title} class="gap-[2px]">
      <Each of={listed()} key={(j) => j.id}>{(job) => <JobRow job={job()} />}</Each>
      <If when={folded().length > 0}>
        <View
          role="button"
          testID="trace-job-fold"
          accessibilityState={{ expanded: foldOpen() }}
          onPress={() => foldOpen.set(!foldOpen())}
          class="cursor-pointer select-none flex-row items-center w-full gap-3 min-h-[56px] px-3 py-[10px] rounded-(--radius-md) hover:bg-chip"
        >
          <Icon name="chevron-right" size={12} class={foldOpen() ? "tint-ink-muted rotate-90" : "tint-ink-muted"} />
          <Text class="text-[15px] text-ink-muted">{t().plan.oneShotJobs(folded().length)}</Text>
        </View>
        <If when={foldOpen()}>
          <Each of={folded()} key={(j) => j.id}>{(job) => <JobRow job={job()} />}</Each>
        </If>
      </If>
    </View>
  );

  const trigger = (
    <View
      role="button"
      testID="trace-job-switcher"
      accessibilityLabel={props.heading}
      accessibilityState={{ expanded: open() }}
      tooltip={tip(props.heading)}
      onPress={() => setOpen(!open())}
      class="cursor-pointer select-none flex-row items-center gap-[6px] min-w-0 px-[6px] py-[3px] rounded-(--radius-sm) border border-transparent hover:bg-chip hover:border-line-subtle"
    >
      <Text role="header" class="shrink min-w-0 text-[14px] font-semibold text-ink line-clamp-1">{props.heading}</Text>
      <Icon name="chevron-down" size={12} class={open() ? "tint-ink-muted rotate-180" : "tint-ink-muted"} />
    </View>
  );

  return (
    <If when={props.jobs.length > 1} else={<Text role="header" testID="trace-heading" class="shrink min-w-0 text-[14px] font-semibold text-ink line-clamp-1">{props.heading}</Text>}>
      <View class="min-w-0 shrink">
        <If
          when={phone()}
          else={
            <Popover
              open={open()}
              placement="bottom"
              align="start"
              offset={6}
              onOpenChange={(e) => setOpen(e.open)}
              trigger={trigger}
              popupClass={`bg-pane border border-line rounded-(--radius-md) overflow-hidden flex-row max-h-[280px] ${twoKinds() ? "" : "min-w-[260px]"}`}
              popupStyle={{ width: twoKinds() ? 492 : undefined, maxWidth: twoKinds() ? undefined : 440, boxShadow: shadow("md") }}
            >
              <View testID="trace-job-menu" role="group" accessibilityLabel={t().trace.title} class="flex-1 flex-row min-h-0">
                <If when={twoKinds()}>
                  <View role="tablist" accessibilityLabel={t().plan.jobKinds.label} class="w-[112px] shrink-0 gap-px p-1 border-r border-line bg-line-subtle">
                    <Each of={kinds()} key={(k) => k.key}>
                      {(entry) => (
                        <View
                          role="tab"
                          testID={`trace-job-kind-${entry().key}`}
                          accessibilityState={{ selected: entry().key === kind() }}
                          ref={(node) => {
                            kindRows[entry().key] = node;
                          }}
                          onMouseEnter={() => kind.set(entry().key)}
                          onPress={() => kind.set(entry().key)}
                          class={`cursor-pointer select-none flex-row items-center gap-[6px] w-full px-2 py-[7px] rounded-(--radius-sm) ${entry().key === kind() ? "bg-pane" : ""}`}
                          style={entry().key === kind() ? { boxShadow: shadow("xs") } : undefined}
                        >
                          <Text class={`flex-1 min-w-0 text-[12px] font-medium line-clamp-1 ${entry().key === kind() ? "text-ink" : "text-ink-secondary"}`}>{t().plan.jobKinds[entry().key]}</Text>
                          <Text class="shrink-0 text-[11px] text-ink-muted">{String(entry().count)}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <View role="list" accessibilityLabel={twoKinds() ? t().plan.jobKinds[kind()] : t().trace.title} class="flex-1 min-w-0 gap-[2px] p-1">
                  {() => shown().map((job) => <JobRow job={job} />)}
                </View>
              </View>
            </Popover>
          }
        >
          {trigger}
          <If when={open()}>
            <BottomSheet title={t().trace.title} closeLabel={t().common.close} onClose={() => setOpen(false)}>
              <SheetList />
            </BottomSheet>
          </If>
        </If>
      </View>
    </If>
  );
}
