/**
 * Who does what in the job (`overlays/JobDivision.svelte`, ADR 0086): each Bot's tickets as written
 * down — owns, reviews — beside the turns it actually ran, and how many of those were on someone
 * else's ticket or under none. A Bot that owns tickets and ran nothing is marked: owners are filled
 * in from the plan's process when the organizer opens tickets, so the two drift apart.
 */
import { Image, Text, View, type JSX } from "nsh";
import type { Bot } from "@real-bot/protocol";
import { actorFace, actorName, ticketRuns } from "../../m/overlays/plan-board.ts";
import type { DivisionRow } from "../../m/overlays/ticket-lanes.ts";
import { copy } from "../../runtime";
import { cssColor } from "../styles";
import { tip } from "../tip";

function Cell(props: { class?: string; children?: JSX.Element }) {
  return <View class={`py-[5px] pr-2 border-b border-line-subtle min-w-0 ${props.class ?? ""}`}>{props.children}</View>;
}

function Head(props: { class?: string; children?: JSX.Element }) {
  return (
    <View class={`pb-[5px] pr-2 border-b border-line min-w-0 ${props.class ?? ""}`}>
      <Text class="text-[11px] font-medium text-ink-muted">{props.children}</Text>
    </View>
  );
}

export function JobDivision(props: {
  rows: readonly DivisionRow[];
  bots: readonly Bot[];
  youLabel: string;
  deletedLabel: string;
}) {
  const c = () => copy().plan.job.division;
  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  const idle = () => props.rows.some((row) => row.owns.length > 0 && row.turns === 0);
  const tags = (seqs: readonly number[]) => (seqs.length > 0 ? ticketRuns(seqs) : c().none);
  return (
    <If when={props.rows.length > 0}>
      <View accessibilityLabel={c().title} testID="job-division" class="gap-[6px] min-w-0">
        <Text class="text-[11px] font-bold text-ink-muted">{c().title}</Text>
        <View class="flex-row">
          <Head class="w-[120px]">{c().bot}</Head>
          <Head class="flex-1">{c().owns}</Head>
          <Head class="flex-1">{c().reviews}</Head>
          <Head class="w-[120px]">{c().turns}</Head>
        </View>
        <Each of={props.rows} key={(row) => row.bot}>
          {(row) => {
            const face = () => actorFace(row().bot, botsById(), props.youLabel, props.deletedLabel);
            const quiet = () => row().owns.length > 0 && row().turns === 0;
            const more = () =>
              [row().onOthers > 0 ? c().onOthers(row().onOthers) : "", row().loose > 0 ? c().loose(row().loose) : ""]
                .filter(Boolean)
                .join(" · ");
            return (
              <View
                testID={`job-division-${row().bot}`}
                tooltip={quiet() ? tip(c().idle) : undefined}
                class={`flex-row ${quiet() ? "bg-warn-bg" : ""}`}
              >
                <Cell class="w-[120px] flex-row items-center gap-[5px]">
                  <View
                    class="w-[15px] h-[15px] rounded-full border border-line overflow-hidden items-center justify-center"
                    style={{
                      backgroundColor: face().palette ? cssColor(face().palette!.bg) : undefined,
                      borderColor: face().palette ? cssColor(face().palette!.border) : undefined,
                    }}
                  >
                    <If
                      when={face().src}
                      else={
                        <Text
                          class="text-[9px] font-bold"
                          style={{ color: face().palette ? cssColor(face().palette!.text) : undefined }}
                        >
                          {face().letter}
                        </Text>
                      }
                    >
                      {(src) => <Image src={src()} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                    </If>
                  </View>
                  <Text class="text-[12px] font-medium text-ink line-clamp-1">
                    {actorName(row().bot, botsById(), props.youLabel, props.deletedLabel)}
                  </Text>
                </Cell>
                <Cell class="flex-1">
                  <Text class="text-[12px] font-mono text-ink">{tags(row().owns)}</Text>
                </Cell>
                <Cell class="flex-1">
                  <Text class="text-[12px] font-mono text-ink">{tags(row().reviews)}</Text>
                </Cell>
                <Cell class="w-[120px]">
                  <Text class="text-[12px] text-ink">
                    <Text class="font-mono font-semibold">{String(row().turns)}</Text>
                    <If when={more()}>
                      <Text class="text-[11px] text-ink-muted">{`  ${more()}`}</Text>
                    </If>
                  </Text>
                </Cell>
              </View>
            );
          }}
        </Each>
        <If when={idle()}>
          <Text class="text-[11px] leading-[1.45] text-ink-muted">{c().idleNote}</Text>
        </If>
      </View>
    </If>
  );
}
