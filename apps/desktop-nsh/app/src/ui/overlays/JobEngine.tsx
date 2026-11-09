/**
 * The app's own share of the job (`overlays/JobEngine.svelte`, ADR 0086): the engine its calls run
 * under (ADR 0085), why it is that one, the steps it leaves off and how many conversations run it,
 * and the way to Roles to change it. An engine with no jobs (ADR 0103) says what that means here.
 */
import { Text, View } from "nsh";
import type { JobEngineWhy } from "../../m/overlays/job-engine.ts";
import { copy } from "../../runtime";

export function JobEngine(props: {
  name: string;
  why: JobEngineWhy;
  /** The steps it switches off, named. */
  off: readonly string[];
  sessions: number;
  /** The job's conversation has moved to an engine with no jobs. */
  stopped?: boolean;
  onOpen?: () => void;
}) {
  const c = () => copy().plan.job.engine;
  return (
    <View accessibilityLabel={c().title} testID="job-engine" class="items-start gap-[5px] min-w-0">
      <Text class="text-[11px] font-bold text-ink-muted">{c().title}</Text>
      <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <View class="px-2 py-px border border-line rounded-full bg-chip">
          <Text testID="job-engine-chip" class="text-[12px] font-semibold text-ink">{c().chip(props.name)}</Text>
        </View>
        <Text class="text-[12px] text-ink-muted">{c()[props.why]}</Text>
      </View>
      <If when={props.stopped}>
        <Text testID="job-engine-stopped" class="text-[11px] leading-[1.45] text-ink-muted">{c().stopped}</Text>
      </If>
      <Text class="text-[11px] leading-[1.45] text-ink-muted">
        {`${props.off.length > 0 ? c().off(props.off.join("、")) : c().allOn} · ${c().sessions(props.sessions)}`}
      </Text>
      <If when={props.onOpen}>
        <View role="button" testID="job-engine-open" onPress={() => props.onOpen?.()} class="cursor-pointer select-none group">
          <Text class="text-[12px] font-semibold text-brand group-hover:underline">{c().open}</Text>
        </View>
      </If>
    </View>
  );
}
