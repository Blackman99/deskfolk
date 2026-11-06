/**
 * One acceptance check as a pill that opens its detail (`overlays/AcceptanceCheckRow.svelte`): what it
 * measures, where it came from, its last run and output, and what you can do — confirm an offer,
 * run it again, edit it, remove it (after a confirmation).
 */
import { signal, Scroll, Text, View } from "nsh";
import type { AcceptanceCheck, TaskDetail } from "@real-bot/protocol";
import { formatFullTimestamp, formatMessageTime } from "../../m/chat/chat-view.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import {
  badgeOf,
  derivedStateOf,
  describeCheck,
  isDerived,
  isUnbound,
  unconfirmedResult,
  type CheckBadge,
} from "../../m/overlays/acceptance-checks.ts";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { tip } from "../tip";
import { AcceptanceCheckForm } from "./AcceptanceCheckForm";
import { DangerDialog } from "./DangerDialog";

const GLYPH: Record<CheckBadge, string> = {
  pass: "✓",
  fail: "✗",
  running: "…",
  blocked: "!",
  error: "!",
  none: "○",
  unbound: "◌",
  proposed: "?",
};

/** The pill's colours by badge: border, fill, ink. */
const PILL: Record<CheckBadge, string> = {
  pass: "border-ok-line bg-ok-bg text-ok-text",
  fail: "border-danger-line bg-danger-bg text-danger-text",
  running: "border-accent-border bg-accent-tint text-brand",
  blocked: "border-warn-line bg-warn-bg text-warn-text",
  error: "border-warn-line bg-warn-bg text-warn-text",
  none: "border-line bg-chip text-muted-light",
  unbound: "border-line bg-chip text-muted-light border-dashed",
  proposed: "border-accent-border bg-chip text-brand border-dashed",
};

function errorStatus(err: unknown): number | undefined {
  const status = err && typeof err === "object" && "status" in err ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}

function Action(props: { testID: string; label: string; disabled?: boolean; primary?: boolean; danger?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      disabled={props.disabled}
      onPress={props.onPress}
      class={`group rounded-(--radius-sm) border px-[9px] disabled:opacity-[0.55] ${narrowWindow() ? "min-h-[36px] py-[6px] justify-center" : "py-1"} ${
        props.primary ? "border-accent-border bg-accent-tint" : "border-line bg-chip"
      } ${props.danger ? "hover:border-danger-line hover:bg-danger-bg" : "hover:border-accent-border hover:bg-accent-tint"}`}
    >
      <Text
        class={`text-[11px] font-medium ${props.primary ? "text-brand" : "text-ink-secondary"} ${
          props.danger ? "group-hover:text-danger-text" : "group-hover:text-brand"
        }`}
      >
        {props.label}
      </Text>
    </View>
  );
}

export function AcceptanceCheckRow(props: {
  api: MessengerApi | null;
  detail: TaskDetail;
  check: AcceptanceCheck;
  /** The plan comes back whole from every check action; the parent replaces its copy. */
  onSaved: (detail: TaskDetail) => void;
}) {
  const t = () => copy().plan.checks;
  const expanded = signal(false);
  const editing = signal(false);
  const confirmingRemove = signal(false);
  const busy = signal(false);
  const removing = signal(false);
  const confirming = signal(false);
  const actionError = signal<string | null>(null);

  const badge = () => badgeOf(props.check);
  // From your words (ADR 0040 P3): a new number of yours changes it, so there is nothing to edit
  // here; an offer is yours to confirm, measured meanwhile so you see what the cut does against it.
  const fromWords = () => isDerived(props.check);
  const standing = () => derivedStateOf(props.check);
  const runnable = () => !isUnbound(props.check);
  const result = () => (standing() === "proposed" ? unconfirmedResult(props.check, copy()) : null);
  const pillLabel = () => {
    const outcome = props.check.last_run?.outcome;
    const base = t().status[badge()];
    return badge() === "proposed" && (outcome === "pass" || outcome === "fail") ? `${base} · ${t().status[outcome]}` : base;
  };
  const source = () =>
    fromWords()
      ? t().sourceDerived
      : props.check.origin === "reflection"
        ? t().sourceReflection
        : props.check.source === "organizer"
          ? t().sourceOrganizer
          : t().sourceUser;

  async function rerun(): Promise<void> {
    if (!props.api || busy()) return;
    busy.set(true);
    actionError.set(null);
    try {
      props.onSaved(await props.api.runChecks(props.detail.id, props.check.id));
    } catch {
      actionError.set(t().runFailed);
    } finally {
      busy.set(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!props.api || confirming()) return;
    confirming.set(true);
    actionError.set(null);
    try {
      props.onSaved(await props.api.confirmCheck(props.check.id));
    } catch (err) {
      actionError.set(errorStatus(err) === 409 ? t().checkGone : t().confirmFailed);
    } finally {
      confirming.set(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!props.api || removing()) return;
    removing.set(true);
    try {
      const next = await props.api.deleteCheck(props.check.id, props.check.updated_at);
      confirmingRemove.set(false);
      props.onSaved(next);
    } catch (err) {
      confirmingRemove.set(false);
      actionError.set(errorStatus(err) === 409 ? t().checkGone : t().removeFailed);
    } finally {
      removing.set(false);
    }
  }

  return (
    <View testID={`check-${props.check.id}`} class="items-start gap-[6px] max-w-full">
      <View
        role="button"
        testID="check-pill"
        accessibilityLabel={describeCheck(props.check, copy())}
        accessibilityState={{ expanded: expanded() }}
        tooltip={tip(describeCheck(props.check, copy()))}
        onPress={() => expanded.set(!expanded())}
        class={`flex-row items-center gap-1 shrink-0 self-start rounded-full border px-2 py-[3px] ${PILL[badge()]}`}
      >
        <Text class="text-[10px] font-semibold leading-none">{GLYPH[badge()]}</Text>
        <Text testID="check-pill-label" class="text-[11px] font-semibold leading-none">{pillLabel()}</Text>
      </View>

      <If when={expanded()}>
        <View
          testID="check-detail"
          class={`gap-[6px] max-w-full px-[10px] py-2 border border-line rounded-(--radius-md) bg-pane ${narrowWindow() ? "w-full" : "w-[280px]"}`}
        >
          <If
            when={editing() && props.api}
            else={
              <>
                <Text class="text-[12px] leading-[1.4] text-ink">{describeCheck(props.check, copy())}</Text>
                <View class="flex-row flex-wrap items-center gap-[5px]">
                  <Text class="text-[11px] text-ink-muted">{source()}</Text>
                  <Text class="text-[11px] text-muted-light">·</Text>
                  <If
                    when={props.check.last_run}
                    else={<Text class="text-[11px] text-ink-muted">{t().neverRun}</Text>}
                  >
                    {(run) => (
                      <View tooltip={tip(formatFullTimestamp(run().started_at))}>
                        <Text class="text-[11px] text-ink-muted">{`${t().lastRun}：${formatMessageTime(run().started_at)}`}</Text>
                      </View>
                    )}
                  </If>
                </View>
                <If
                  when={result()}
                  else={
                    <If when={standing() === "proposed"}>
                      <Text class="text-[11px] leading-[1.4] text-ink-muted">{t().stateProposed}</Text>
                    </If>
                  }
                >
                  {(line) => <Text testID="check-result" class="text-[11px] leading-[1.4] text-ink-secondary">{line()}</Text>}
                </If>
                <If when={props.check.last_run?.detail}>
                  {(line: () => string) => <Text class="text-[11px] text-ink-secondary">{line()}</Text>}
                </If>
                <If when={props.check.last_run?.output}>
                  {(output: () => string) => (
                    <Scroll class="max-h-[160px] rounded-(--radius-sm) bg-line-subtle">
                      <Text testID="check-output" class="px-2 py-[6px] text-[11px] leading-[1.4] font-mono text-ink-secondary">{output()}</Text>
                    </Scroll>
                  )}
                </If>
                <If when={actionError()}>
                  {(message: () => string) => <Text testID="check-error" class="text-[12px] font-medium leading-[1.4] text-warn-text">{message()}</Text>}
                </If>
                <If when={props.api}>
                  <View class="flex-row flex-wrap gap-[6px]">
                    <If when={standing() === "proposed"}>
                      <Action testID="check-confirm" primary label={t().confirm} disabled={busy() || confirming()} onPress={() => void confirm()} />
                    </If>
                    <Action
                      testID="check-rerun"
                      label={t().rerun}
                      disabled={busy() || props.check.running || !runnable()}
                      onPress={() => void rerun()}
                    />
                    <If when={!fromWords()}>
                      <Action
                        testID="check-edit"
                        label={copy().plan.edit}
                        disabled={busy()}
                        onPress={() => {
                          editing.set(true);
                          actionError.set(null);
                        }}
                      />
                    </If>
                    <Action
                      testID="check-remove"
                      danger
                      label={t().remove}
                      disabled={busy()}
                      onPress={() => {
                        confirmingRemove.set(true);
                        actionError.set(null);
                      }}
                    />
                  </View>
                </If>
              </>
            }
          >
            <AcceptanceCheckForm
              api={props.api!}
              detail={props.detail}
              editing={props.check}
              onSaved={(next) => {
                editing.set(false);
                props.onSaved(next);
              }}
              onCancel={() => editing.set(false)}
            />
          </If>
        </View>
      </If>

      <If when={confirmingRemove()}>
        <DangerDialog
          busy={removing()}
          copy={{
            title: t().confirmRemoveTitle,
            body: t().confirmRemoveBody,
            confirm: t().confirmRemove,
            cancel: copy().plan.cancel,
          }}
          onDismiss={() => {
            if (!removing()) confirmingRemove.set(false);
          }}
          onConfirm={() => void confirmRemove()}
        />
      </If>
    </View>
  );
}
