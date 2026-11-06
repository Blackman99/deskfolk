/**
 * What the job is called (`overlays/PlanSpecPanel.svelte`'s name block): named after the line that
 * opened it until you name it; the goal said beside a new name; and the job's scale (ADR 0060),
 * large or no need, which is yours to call off.
 */
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { EditBtn, ErrorLine, LinkBtn, SaveCancel } from "./plan-spec-parts";
import type { PlanSpecPanelProps, PlanSpecState } from "./plan-spec-state";

export function PlanNameBlock(props: { panel: PlanSpecPanelProps; state: PlanSpecState }) {
  const t = () => copy().plan;
  const s = props.state;
  const detail = () => props.panel.detail;
  const api = () => props.panel.api;
  const large = () => {
    const scale = detail().scale;
    return scale?.value === "large" ? scale : null;
  };
  return (
    <View testID="plan-spec-name" class="gap-1 px-[2px] pb-[10px] border-b border-line-subtle">
      <View class="flex-row items-center justify-between gap-2 min-w-0">
        <Text class="text-[12px] font-semibold text-ink-muted">{t().spec.name}</Text>
        <If when={api() && s.editing() !== "title"}>
          <EditBtn testID="plan-spec-edit-title" tooltip={t().spec.nameHint} onPress={s.startEditTitle} />
        </If>
      </View>
      <If
        when={s.editing() === "title"}
        else={
          <View class="gap-1">
            <Text testID="plan-spec-name-text" class="text-[14px] font-semibold text-ink">
              {detail().title}
            </Text>
            <If when={s.renamed() && detail().spec && api()}>
              <View class="flex-row flex-wrap items-center gap-[6px] mt-1">
                <Text class="shrink text-[12px] text-ink-secondary">{t().spec.renamedGoal(detail().spec?.goal ?? "")}</Text>
                <LinkBtn testID="plan-spec-edit-goal-link" label={t().spec.editGoal} onPress={s.startEditGoal} />
              </View>
            </If>
            <If when={large()}>
              {(scale) => (
                <View testID="plan-spec-scale" class="flex-row flex-wrap items-center gap-[6px] mt-1">
                  <Text class="shrink text-[12px] text-ink-secondary">
                    {`${t().spec.scaleLarge(scale().unit)} ${t().spec.scaleWhy[scale().by](scale().why)}`}
                  </Text>
                  <If when={api()}>
                    <LinkBtn testID="plan-spec-scale-single" label={t().spec.scaleNotLarge} disabled={s.scaleSaving()} onPress={() => void s.setScale("single")} />
                  </If>
                </View>
              )}
            </If>
            <If when={detail().scale?.value === "single"}>
              <View testID="plan-spec-scale" class="flex-row flex-wrap items-center gap-[6px] mt-1">
                <Text class="shrink text-[12px] text-ink-secondary">{t().spec.scaleSingle}</Text>
                <If when={api()}>
                  <LinkBtn testID="plan-spec-scale-large" label={t().spec.scaleMakeLarge} disabled={s.scaleSaving()} onPress={() => void s.setScale("large")} />
                </If>
              </View>
            </If>
            {/* A failed scale change has no edit box to show it in. */}
            <If when={s.saveError() && s.editing() === null}>
              <ErrorLine testID="plan-spec-error">{s.saveError() ?? ""}</ErrorLine>
            </If>
          </View>
        }
      >
        <View class="gap-[6px]">
          <Input
            testID="plan-spec-name-input"
            accessibilityLabel={t().spec.name}
            autoCorrect={false}
            autoFocus
            value={s.draft()}
            readonly={s.saving()}
            submitBehavior="submit"
            onChange={(e) => s.draft.set(e.value)}
            onSubmit={() => void s.saveTitle()}
            onKeyPress={(e) => {
              if (e.key === "Escape") s.cancelEdit();
            }}
            class={`w-full border border-line rounded-(--radius-sm) bg-input-bg text-ink focus:border-field-focus-border ${
              narrowWindow() ? "px-[10px] py-2 text-[14px]" : "px-[9px] py-[6px] text-[13px]"
            }`}
          />
          <Text class="text-[12px] text-ink-muted">{t().spec.nameHint}</Text>
          <SaveCancel state={s} testID="plan-spec-title" disabledSave={!s.draft().trim()} />
          <If when={s.saveError()}>
            <ErrorLine testID="plan-spec-error">{s.saveError() ?? ""}</ErrorLine>
          </If>
        </View>
      </If>
    </View>
  );
}
