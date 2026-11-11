/**
 * The contract sections of the spec panel (`overlays/PlanSpecPanel.svelte`): done-when, rules and
 * process. Each lists its written lines with an edit box; done-when also carries the acceptance
 * checks under their lines, those held to the approved sample, those from your words, the
 * orphaned ones, and the form to add a check.
 */
import { Text, View } from "nsh";
import type { PlanSpec } from "@real-bot/protocol";
import { checksForLine } from "../../m/overlays/acceptance-checks.ts";
import { specLines, type SpecListField } from "../../m/overlays/plan-board.ts";
import { copy } from "../../runtime";
import { Icon, type IconName } from "../Icon";
import { AcceptanceCheckForm } from "./AcceptanceCheckForm";
import { fieldLabel, GUIDELINE_FIELDS, type CheckGroups } from "./plan-spec-panel";
import { CheckItem, EditBtn, ErrorLine, LinesBox, SaveCancel, SmallBtn } from "./plan-spec-parts";
import type { PlanSpecPanelProps, PlanSpecState } from "./plan-spec-state";

const ICON: Record<string, IconName> = { acceptance: "check-square", rules: "shield", process: "git-branch" };

export function CountBadge(props: { n: number }) {
  return (
    <View class="shrink-0 px-[5px] rounded-full bg-line-subtle">
      <Text class="text-[10px] font-bold font-mono leading-[15px] text-ink-muted">{String(props.n)}</Text>
    </View>
  );
}

function Pills(props: { block?: boolean; children?: import("nsh").JSX.Element }) {
  return <View class={`flex-row flex-wrap items-start gap-1 ${props.block ? "w-full mt-[5px]" : "ml-1"}`}>{props.children}</View>;
}

function OrphanTitle(props: { children?: string }) {
  return <Text class="text-[11px] font-semibold text-ink-muted">{props.children}</Text>;
}

function Field(props: { panel: PlanSpecPanelProps; state: PlanSpecState; spec: PlanSpec; groups: CheckGroups; field: SpecListField; focusTicketId: string | null }) {
  const t = () => copy().plan;
  const s = props.state;
  const field = props.field;
  const checks = () => props.panel.detail.checks ?? [];
  const lines = () => specLines(props.spec, field);
  const unwritten = () => lines().length === 0 && s.editing() !== field;
  const isAcceptance = field === "acceptance";
  // Nothing written and nothing under it: the head alone, its 「无」 in it.
  const bare = () => unwritten() && !(isAcceptance && (checks().length > 0 || s.addingCheck() || s.runError()));
  const item = (check: import("@real-bot/protocol").AcceptanceCheck) => (
    <CheckItem
      api={props.panel.api}
      detail={props.panel.detail}
      check={check}
      focusTicketId={props.focusTicketId}
      onSaved={s.checkSaved}
      onShowTicket={props.panel.onShowTicket}
    />
  );
  return (
    <View
      testID={`plan-spec-list-${field}`}
      class={`min-w-0 border rounded-(--radius-md) bg-pane px-[11px] hover:border-line-hover ${bare() ? "py-[6px] border-dashed border-line bg-transparent" : "py-[10px] border-line"}`}
    >
      <View class={`flex-row flex-wrap items-center justify-between gap-[6px] ${bare() ? "" : "mb-[7px]"}`}>
        <View class={`flex-row items-center gap-[6px] min-w-0 ${bare() ? "opacity-[0.7]" : ""}`}>
          <Icon name={ICON[field]} size={12} class="tint-ink-muted" />
          <Text class="shrink-0 text-[12px] font-semibold text-ink-muted">{fieldLabel(copy(), field)}</Text>
          <If when={lines().length > 0}>
            <CountBadge n={lines().length} />
          </If>
          <If when={unwritten()}>
            <Text class="text-[11px] italic text-ink-muted">{t().empty}</Text>
          </If>
          <If when={isAcceptance && props.groups.total.total > 0}>
            <View class="shrink-0 px-[7px] rounded-full bg-accent-tint">
              <Text testID="plan-spec-checks-summary" class="text-[10px] font-bold font-mono leading-[15px] text-brand">
                {t().checks.summary(props.groups.total.pass, props.groups.total.total)}
              </Text>
            </View>
          </If>
        </View>
        <View class="flex-row flex-wrap items-center gap-[6px] shrink-0">
          <If when={isAcceptance && props.panel.api}>
            <If when={props.groups.total.total > 0}>
              <SmallBtn
                testID="plan-spec-checks-run"
                label={`▶ ${t().checks.run}`}
                disabled={s.runningAll() || props.groups.anyRunning}
                onPress={() => void s.runAllChecks()}
              />
            </If>
            <SmallBtn testID="plan-spec-checks-add" label={t().checks.add} onPress={s.openAddCheck} />
          </If>
          <If when={props.panel.api && s.editing() !== field}>
            <EditBtn testID={`plan-spec-edit-${field}`} onPress={() => s.startEditField(field)} />
          </If>
        </View>
      </View>

      <If when={isAcceptance && s.runError()}>
        <ErrorLine testID="plan-spec-run-error">{s.runError() ?? ""}</ErrorLine>
      </If>

      <If
        when={s.editing() === field}
        else={
          <View class="gap-2">
            <If when={lines().length > 0}>
              <View class="gap-1 pl-[2px]">
                <Each of={lines()}>
                  {(line) => (
                    <View class="flex-row flex-wrap items-baseline gap-x-[6px] gap-y-1 min-w-0">
                      <Text class="text-[12px] leading-[1.45] text-ink-muted">•</Text>
                      <Text class="shrink text-[12px] leading-[1.45] text-ink-secondary">{line()}</Text>
                      <If when={isAcceptance && checksForLine(checks(), line()).length > 0}>
                        <Pills>
                          <Each of={checksForLine(checks(), line())} key={(c) => c.id}>
                            {(c) => item(c())}
                          </Each>
                        </Pills>
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </If>

            <If when={isAcceptance && props.groups.heldToSample.length > 0}>
              <View testID="plan-spec-sample" class="gap-[6px] mt-2 pt-2 border-t border-dashed border-line">
                <OrphanTitle>{t().checks.sampleTitle}</OrphanTitle>
                <View class="gap-1 pl-[2px]">
                  <Each of={props.groups.heldToSample} key={(g) => g.item}>
                    {(group) => (
                      <View class="min-w-0">
                        <Text class="text-[12px] leading-[1.45] text-ink-secondary">{`• ${group().item}`}</Text>
                        <Pills block>
                          <Each of={group().checks} key={(c) => c.id}>
                            {(c) => item(c())}
                          </Each>
                        </Pills>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </If>

            <If when={isAcceptance && props.groups.fromYourWords.length > 0}>
              <View testID="plan-spec-derived" class="gap-[6px] mt-2 pt-2 border-t border-dashed border-line">
                <OrphanTitle>{t().checks.derivedTitle}</OrphanTitle>
                <View class="gap-1 pl-[2px]">
                  <Each of={props.groups.fromYourWords} key={(c) => c.id}>
                    {(c) => (
                      <View class="flex-row flex-wrap items-baseline gap-x-[6px] gap-y-1 min-w-0">
                        <Text class="text-[12px] leading-[1.45] text-ink-secondary">{`• ${c().item}`}</Text>
                        <Pills>{item(c())}</Pills>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </If>

            <If when={isAcceptance && props.groups.orphaned.length > 0}>
              <View testID="plan-spec-orphans" class={`gap-[6px] ${lines().length > 0 ? "mt-2 pt-2 border-t border-dashed border-line" : ""}`}>
                <OrphanTitle>{t().checks.orphansTitle}</OrphanTitle>
                <View class="flex-row flex-wrap items-start gap-1">
                  <Each of={props.groups.orphaned} key={(c) => c.id}>
                    {(c) => item(c())}
                  </Each>
                </View>
              </View>
            </If>

            <If when={isAcceptance && s.addingCheck() && props.panel.api}>
              <AcceptanceCheckForm
                api={props.panel.api!}
                detail={props.panel.detail}
                editing={null}
                onSaved={s.checkSaved}
                onCancel={() => s.addingCheck.set(false)}
              />
            </If>
          </View>
        }
      >
        <View class="gap-[6px]">
          <LinesBox state={s} testID={`plan-spec-lines-${field}`} />
          <If when={isAcceptance}>
            <Text class="text-[11px] text-ink-muted">{t().checks.editHint}</Text>
          </If>
          <SaveCancel state={s} testID={`plan-spec-${field}`} />
          <If when={s.saveError()}>
            <ErrorLine testID="plan-spec-error">{s.saveError() ?? ""}</ErrorLine>
          </If>
        </View>
      </If>
    </View>
  );
}

export function PlanSpecGuidelines(props: {
  panel: PlanSpecPanelProps;
  state: PlanSpecState;
  spec: PlanSpec;
  groups: CheckGroups;
  focusTicketId: string | null;
}) {
  return (
    <View testID="plan-spec-guidelines" class="gap-[10px]">
      <Each of={GUIDELINE_FIELDS.slice()}>
        {(field) => (
          <Field panel={props.panel} state={props.state} spec={props.spec} groups={props.groups} field={field()} focusTicketId={props.focusTicketId} />
        )}
      </Each>
    </View>
  );
}
