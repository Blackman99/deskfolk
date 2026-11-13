/**
 * Step 4 (ADR 0085, 0095): the first Bots from a way of working's templates, or a terminal session
 * of your own carried on as a project session. Kept side by side, so the Bots' drafts stay as you
 * left them while the other way is looked at.
 */
import { View } from "nsh";
import { copy } from "../../runtime";
import { runtime } from "../../runtime";
import { ProjectDirPicker } from "../sidebar/ProjectDirPicker";
import { Desc, StepFooter, StepHead, StepPrimary, StepSecondary, WaySwitch } from "./parts";
import { TeamStep } from "./TeamStep";
import type { Wizard } from "./wizard";

export function StartStep(props: { w: Wizard }) {
  const w = props.w;
  const t = () => copy();
  return (
    <View testID="onboarding-step-4" class="flex-col gap-[14px]">
      {/* The step's long explanation is the screen reader's (and the choice's hint), not a
          paragraph over everything: each way says its own line once it is chosen. */}
      <StepHead
        title={w.carryOffered() ? t().onboarding.stepStart : t().onboarding.stepBot}
        desc={w.carryOffered() ? undefined : t().onboarding.startTeamDesc}
      />

      <If when={w.carryOffered()}>
        <WaySwitch
          label={t().onboarding.step4StartTitle}
          value={w.startWay()}
          idPrefix="start-way"
          hint={w.startWay() === "carry" ? t().onboarding.carryDesc : t().onboarding.botDesc}
          disabled={w.teamBusy()}
          options={[
            ["team", t().onboarding.startTeam, t().onboarding.startTeamDesc],
            ["carry", t().onboarding.startCarry, t().onboarding.startCarryDesc],
          ]}
          onPick={(way) => w.startWay.set(way)}
        />
      </If>

      <View class="flex-col gap-[14px]" style={{ display: w.startWay() === "team" ? "flex" : "none" }}>
        <TeamStep
          base={w.teamBase()}
          onDone={() => w.hold(false)}
          onCountChange={(n) => w.teamCount.set(n)}
          onReadyChange={(ready) => w.teamReady.set(ready)}
          onBusyChange={(busy) => w.teamBusy.set(busy)}
          onApi={(api) => (w.team.api = api)}
        />
        <If
          when={w.teamBase().runner}
          else={<Desc>{t().onboarding.botModelHint}</Desc>}
        >
          <Desc>{w.teamBase().runner === "claude_code" ? t().onboarding.botClaudeHint : t().onboarding.botAgentHint.replace("{agent}", w.pickedLabel())}</Desc>
        </If>
      </View>
      <If when={w.startWay() === "carry"}>
        <ProjectDirPicker agent="claude_code" mode="import" items={w.terminalSessions()} sessions={runtime.snapshot.sessions} onDone={() => w.hold(false)} />
      </If>

      <StepFooter>
        <StepSecondary testID="onboarding-skip-start" label={w.startWay() === "carry" ? t().onboarding.skipStart : t().onboarding.skipBot} onPress={() => w.hold(false)} />
        <If when={w.startWay() === "team"}>
          <StepPrimary testID="team-create" disabled={w.teamBusy() || !w.teamReady()} label={`${t().templates.create(w.teamCount())} ✓`} onPress={() => void w.team.api?.create()} />
        </If>
      </StepFooter>
    </View>
  );
}
