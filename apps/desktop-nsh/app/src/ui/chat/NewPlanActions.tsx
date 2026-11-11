/**
 * The buttons under a line that opened a plan (`NewPlanActions.svelte`): take the plan back, or fold
 * it into another job. Each asks to be confirmed first, saying what it costs; once the line says it
 * was acted on, the row is that line's last action.
 */
import { signal, Text, View } from "nsh";
import type { ControlOffer, MessageControl } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { Select } from "../Select";

export function NewPlanActions(props: {
  control: Extract<MessageControl, { kind: "plan_opened" }>;
  disabled?: boolean;
  onAct: (action: ControlOffer, taskId?: string) => Promise<unknown>;
}) {
  const choosing = signal<"undo_plan" | "merge_plan" | null>(null);
  const target = signal("");
  const pending = signal(false);
  const failed = signal(false);
  const off = () => props.disabled === true;
  const t = () => copy().control;

  async function confirm(): Promise<void> {
    const mode = choosing();
    if (!mode || pending() || off() || (mode === "merge_plan" && !target())) return;
    pending.set(true);
    failed.set(false);
    try {
      failed.set(Boolean(await props.onAct(mode, mode === "merge_plan" ? target() : undefined)));
    } catch {
      failed.set(true);
    } finally {
      pending.set(false);
    }
  }

  const actedLast = () => props.control.acted?.at(-1);

  return (
    <View testID="new-plan-actions" accessibilityLabel={t().planMergeTarget} class="flex-row flex-wrap items-center gap-[6px] mt-[6px]">
      <If
        when={props.control.acted?.length}
        else={
          <If
            when={choosing()}
            else={
              <>
                <If when={props.control.offer.includes("undo_plan")}>
                  <Button testID="plan-undo" size="sm" disabled={off()} onPress={() => choosing.set("undo_plan")}>{t().undoPlan}</Button>
                </If>
                <If when={props.control.offer.includes("merge_plan")}>
                  <Button
                    testID="plan-merge"
                    size="sm"
                    disabled={off() || !props.control.merge_targets.length}
                    onPress={() => choosing.set("merge_plan")}
                  >
                    {t().mergePlan}
                  </Button>
                  <If when={!props.control.merge_targets.length}>
                    <Text class="text-[12px] text-ink-muted">{t().noMergeTargets}</Text>
                  </If>
                </If>
              </>
            }
          >
            {(mode: () => "undo_plan" | "merge_plan") => (
              <>
                <Text class="w-full text-[12px] text-ink-muted">{mode() === "undo_plan" ? t().planUndoWarning : t().planMergeWarning}</Text>
                <If when={mode() === "merge_plan"}>
                  <View class="flex-row items-center gap-[6px]">
                    <Text class="text-[12px] text-ink-muted">{t().planMergeTarget}</Text>
                    <View class="w-[220px]">
                      <Select
                        testID="plan-merge-target"
                        ariaLabel={t().planMergeTarget}
                        value={target()}
                        disabled={off() || pending()}
                        options={[{ value: "", label: "—" }, ...props.control.merge_targets.map((job) => ({ value: job.task_id, label: job.title }))]}
                        onChange={(v) => target.set(v)}
                        size="sm"
                      />
                    </View>
                  </View>
                </If>
                <Button
                  testID="plan-confirm"
                  size="sm"
                  disabled={off() || pending() || (mode() === "merge_plan" && !target())}
                  onPress={() => void confirm()}
                >
                  {mode() === "undo_plan" ? t().confirmUndoPlan : t().confirmMergePlan}
                </Button>
                <Button
                  testID="plan-cancel"
                  size="sm"
                  disabled={pending()}
                  onPress={() => {
                    choosing.set(null);
                    failed.set(false);
                  }}
                >
                  {t().cancelPlanAction}
                </Button>
              </>
            )}
          </If>
        }
      >
        <Text testID="plan-acted" class="text-[12px] text-ink-muted">{actedLast() ? t().acted[actedLast()!] : ""}</Text>
        <If when={props.control.retained_effects?.length}>
          <Text class="text-[12px] text-ink-muted">{t().planRetained}</Text>
        </If>
      </If>
      <If when={failed()}>
        <Text testID="plan-failed" class="text-[12px] text-danger-text">{t().failed}</Text>
      </If>
    </View>
  );
}
