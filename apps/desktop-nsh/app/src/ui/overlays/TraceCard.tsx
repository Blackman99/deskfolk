/**
 * One turn on the trace board: who acted, what it said, what it waits on, the model it ran on and
 * the files it handed over. A line of yours is drawn with rounded ends and a decision of yours
 * with pointed ends, as a flowchart draws a start and a decision; the cut outline is a `Canvas`
 * behind the content (`trace-shape.tsx`).
 */
import { Image, Text, View, signal, token } from "nsh";
import { USER_MEMBER, type TaskTraceNode, type Ticket } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { buildCitedPathTree, citedBundleName, countCitedFiles } from "../../m/overlays/artifact-tree.ts";
import { type ActorFace } from "../../m/overlays/plan-board.ts";
import type { RouteLogRow } from "../../m/overlays/route-log.ts";
import { saidNothing, traceFileName, traceNodeShape } from "../../m/overlays/task-trace.ts";
import { Icon } from "../Icon";
import { cssColor } from "../styles";
import { tip } from "../tip";
import { TicketTag } from "./trace-parts";
import { TraceShape } from "./trace-shape";

const POINT = 12;

/** Each status sets its colours; the outline of the card (its shape) is drawn from them. */
function palette(status: TaskTraceNode["status"]): { edge: string; bar: string; fill: string } {
  switch (status) {
    case "running": return { edge: token("brand"), bar: token("brand"), fill: token("accent-tint") };
    case "waiting_approval": return { edge: token("warn"), bar: token("warn"), fill: token("warn-bg") };
    case "waiting_ask": return { edge: token("purple"), bar: token("purple"), fill: token("purple-bg") };
    // A finished turn is most of any job, so it wears no colour (ADR 0094).
    case "completed": return { edge: token("line"), bar: token("line"), fill: token("pane") };
    case "redirected": return { edge: token("line"), bar: token("ink-muted"), fill: token("chip") };
    case "interrupted":
    case "stopped": return { edge: token("danger"), bar: token("danger"), fill: token("danger-bg") };
    default: return { edge: token("line"), bar: token("muted-light"), fill: token("pane") };
  }
}

function statusClass(status: TaskTraceNode["status"]): string {
  switch (status) {
    case "running": return "text-brand";
    case "waiting_approval": return "text-warn-text";
    case "waiting_ask": return "text-purple-text";
    case "interrupted":
    case "stopped": return "text-danger-text";
    default: return "text-ink-muted";
  }
}

function Avatar(props: { node: TaskTraceNode; face: ActorFace }) {
  const you = () => props.node.actor === USER_MEMBER;
  const colours = () => {
    const p = props.face.palette;
    return you()
      ? { backgroundColor: token("ink"), borderColor: "transparent" }
      : p
        ? { backgroundColor: cssColor(p.bg), borderColor: cssColor(p.border) }
        : {};
  };
  return (
    <View class="shrink-0 w-[22px] h-[22px] rounded-full border items-center justify-center overflow-hidden" style={colours()}>
      <If
        when={props.face.src}
        else={
          <Text class="text-[11px] font-bold" style={{ color: you() ? token("pane") : props.face.palette ? cssColor(props.face.palette.text) : token("ink") }}>
            {props.face.letter}
          </Text>
        }
      >
        {(src: () => string) => <Image src={src()} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </If>
    </View>
  );
}

export function TraceCard(props: {
  node: TaskTraceNode;
  here: boolean;
  focused: boolean;
  lit: boolean;
  litBlamed: boolean;
  dim: boolean;
  name: string;
  avatar: ActorFace;
  ticket: Ticket | null;
  /** Who a card says woke it, once the connectors are gone; null draws no line. */
  from: string | null;
  /** Where a card from another conversation happened; null when it is this job's own. */
  place: string | null;
  route: RouteLogRow | null;
  /** The model choice repeats the same Bot's previous card: a chip on the first line, not a line of its own. */
  routeCompact?: boolean;
  routeOpen: boolean;
  onToggleRoute: () => void;
  onOpen: () => void;
  onOpenArtifacts: () => void;
}) {
  const node = () => props.node;
  const shape = () => traceNodeShape(node());
  const hover = signal(false);
  const colours = () => palette(node().status);
  /** Where you are, as a ring — but only on a card with no status of its own. */
  const hereRing = () => props.here && !["running", "waiting_approval", "waiting_ask", "completed", "interrupted", "stopped"].includes(node().status);
  const ringColour = () => (props.lit || props.focused ? (props.lit && props.litBlamed ? token("warn") : token("brand")) : null);
  const plainStyle = () => {
    const c = colours();
    const line = shape() === "line";
    const ring = ringColour();
    return {
      borderColor: c.edge,
      borderLeftColor: line ? c.edge : c.bar,
      borderLeftWidth: line ? 1 : 3,
      borderRadius: line ? 20 : 10,
      backgroundColor: c.fill,
      boxShadow: ring ? `0 0 0 2px ${ring}` : hereRing() ? `inset 0 0 0 1px ${token("brand")}` : "none",
    };
  };
  const decision = () => shape() === "decision";
  const inset = () => (decision() ? POINT + 8 : shape() === "line" ? 14 : 10);
  const bundle = () => {
    if (node().artifacts.length < 2) return null;
    const tree = buildCitedPathTree(node().artifacts.map((a) => a.path));
    return { fileCount: countCitedFiles(tree), name: citedBundleName(tree) };
  };
  const chip = () => props.route !== null && props.routeCompact === true;
  return (
    <View
      testID={`trace-card-${node().turn_id}`}
      class={`relative border ${decision() ? "" : "overflow-hidden"} ${props.dim ? "opacity-[0.32]" : ""}`}
      style={decision() ? { borderWidth: 0 } : plainStyle()}
    >
      <If when={decision()}>
        <TraceShape
          kind="decision"
          cut={POINT}
          edge={() => colours().edge}
          fill={() => (hover() ? token("line-subtle") : colours().fill)}
          ring={ringColour}
        />
      </If>
      <View
        role="button"
        testID={`trace-card-open-${node().turn_id}`}
        accessibilityLabel={copy().trace.jump}
        tooltip={tip(copy().trace.jump)}
        onPress={props.onOpen}
        onMouseEnter={() => hover.set(true)}
        onMouseLeave={() => hover.set(false)}
        class={`cursor-pointer select-none w-full items-start gap-[4px] py-[9px] ${!decision() ? "hover:bg-line-subtle" : ""}`}
        style={{ paddingLeft: inset(), paddingRight: inset() }}
      >
        <View class="flex-row items-center gap-[6px] w-full" style={{ paddingRight: chip() ? 70 : 0 }}>
          <Avatar node={node()} face={props.avatar} />
          <Text class="min-w-0 shrink text-[12px] font-semibold text-ink line-clamp-1">{props.name}</Text>
          <If when={props.ticket}>{(ticket: () => Ticket) => <TicketTag ticket={ticket()} />}</If>
          <If
            when={node().actor !== USER_MEMBER}
            else={
              <If when={node().decision}>
                {(decisionRow: () => NonNullable<TaskTraceNode["decision"]>) => (
                  <Text
                    class={`ml-auto text-[11px] ${
                      decisionRow().kind === "approve" ? "text-ok-text" : decisionRow().kind === "answer" ? "text-purple" : decisionRow().kind === "reject" || decisionRow().kind === "rework" ? "text-danger-text" : "text-ink-muted"
                    }`}
                  >
                    {copy().trace.decision[decisionRow().kind]}
                  </Text>
                )}
              </If>
            }
          >
            {/* Your own line has no status worth reading: it was sent. Nor has a finished turn. */}
            <If when={node().status !== "completed"}>
              <Text class={`ml-auto text-[11px] ${statusClass(node().status)}`}>{copy().trace.status[node().status]}</Text>
            </If>
          </If>
        </View>
        <If when={props.from}>
          <Text class="text-[11px] leading-[16px] text-ink-muted">{copy().trace.wokenBy(props.from!)}</Text>
        </If>
        <If
          when={saidNothing(node())}
          else={
            <If when={node().summary}>
              <Text tooltip={tip(node().summary)} class="w-full text-[12px] leading-[17px] text-ink-secondary line-clamp-2">{node().summary}</Text>
            </If>
          }
        >
          {/* Its summary would be the line that woke it, read as the Bot saying it. */}
          <Text class="text-[11px] leading-[16px] text-ink-muted">{copy().trace.silent}</Text>
        </If>
        <If when={node().ask}>
          <Text class="text-[12px] leading-[17px] text-brand">{`${copy().trace.waitingAsk} · ${node().ask!.question}`}</Text>
        </If>
        <If when={node().decision?.question}>
          <Text class="text-[12px] leading-[17px] text-brand">{copy().trace.asked(node().decision!.question!)}</Text>
        </If>
        <If when={!node().decision?.question && node().decision?.result}>
          <Text class="text-[12px] leading-[17px] text-brand">{node().decision!.result!}</Text>
        </If>
        <If when={node().approval}>
          <Text class="text-[12px] leading-[17px] text-brand">
            {`${copy().trace.waitingApproval}${node().approval!.summary ? ` · ${node().approval!.summary}` : ""}`}
          </Text>
        </If>
        <If when={node().passed > 0}>
          <Text class="text-[11px] leading-[16px] text-ink-muted">{copy().trace.passed(node().passed)}</Text>
        </If>
        <If when={props.place !== null}>
          {/* The header names the job's own conversation; only a card from elsewhere says where. */}
          <Text class="text-[11px] leading-[16px] text-ink-muted">{props.place!}</Text>
        </If>
      </View>
      <If when={props.route}>
        {(route: () => RouteLogRow) => (
          <If
            when={chip()}
            else={
              <View class="py-0 pb-[9px]" style={{ paddingLeft: shape() === "line" ? 14 : 10, paddingRight: shape() === "line" ? 14 : 10 }}>
                <View
                  role="button"
                  testID={`trace-route-toggle-${node().turn_id}`}
                  accessibilityLabel={copy().routes.cardToggle}
                  accessibilityState={{ expanded: props.routeOpen }}
                  tooltip={tip(copy().routes.cardToggle)}
                  onPress={props.onToggleRoute}
                  class={`cursor-pointer select-none flex-row items-center gap-[6px] w-full px-[8px] py-[4px] border rounded-(--radius-sm) ${
                    props.routeOpen ? "border-accent-border bg-accent-tint" : "border-line bg-chip hover:border-accent-border hover:bg-accent-tint"
                  }`}
                >
                  <Text class="shrink min-w-0 text-[11px] font-semibold text-ink font-mono line-clamp-1" style={{ maxWidth: "50%" }}>{route().model}</Text>
                  <Text class="flex-1 min-w-0 text-[11px] text-ink-muted line-clamp-1">
                    {`${copy().routes.thinkingPrefix} ${route().thinkingLabel} · ${route().signatureLabel}`}
                  </Text>
                  <View class="flex-row items-center gap-[5px] shrink-0">
                    <If when={route().review?.blamedModel}>
                      <View tooltip={tip(copy().routes.filterBlamed)}>
                        <Icon name="alert-triangle" size={12} class="tint-warn-text" />
                      </View>
                    </If>
                    <If when={route().feedback.length > 0}>
                      <View tooltip={tip(copy().routes.feedbackCount(route().feedback.length))} class="flex-row items-center gap-[2px]">
                        <Icon name="message" size={12} class="tint-brand" />
                        <Text class="text-[10px] text-brand font-mono">{String(route().feedback.length)}</Text>
                      </View>
                    </If>
                    <If when={route().failReason}>
                      <View tooltip={tip(route().failReason ?? "")}>
                        <Icon name="alert-circle" size={12} class="tint-danger-text" />
                      </View>
                    </If>
                  </View>
                  <View class="shrink-0" style={{ transform: props.routeOpen ? "rotate(180deg)" : "none" }}>
                    <Icon name="chevron-down" size={12} />
                  </View>
                </View>
              </View>
            }
          >
            {/* The same model choice as this Bot's card before: named in a chip, which still opens what came of it. */}
            <View
              role="button"
              testID={`trace-route-toggle-${node().turn_id}`}
              accessibilityLabel={copy().routes.cardToggle}
              accessibilityState={{ expanded: props.routeOpen }}
              tooltip={tip(`${route().model} · ${copy().routes.thinkingPrefix} ${route().thinkingLabel} · ${route().signatureLabel}\n${copy().routes.cardToggle}`)}
              onPress={props.onToggleRoute}
              class={`cursor-pointer select-none absolute rounded-(--radius-sm) px-[6px] justify-center ${props.routeOpen ? "bg-chip" : "hover:bg-chip"}`}
              style={{ top: 9, right: 8, maxWidth: 76, height: 22 }}
            >
              <Text class="text-[10px] text-ink-muted font-mono line-clamp-1">{route().model}</Text>
            </View>
          </If>
        )}
      </If>
      <If when={node().artifacts.length > 0}>
        <View class="pb-[9px]" style={{ paddingLeft: inset() === 10 ? 10 : inset(), paddingRight: inset() === 10 ? 10 : inset() }}>
          <View
            role="button"
            testID={`trace-card-files-${node().turn_id}`}
            tooltip={tip(node().artifacts.length > 1 ? node().artifacts.map((a) => a.path).join("\n") : node().artifacts[0]!.path)}
            onPress={props.onOpenArtifacts}
            class="cursor-pointer select-none flex-row items-center gap-[8px] w-full px-[10px] py-[6px] bg-chip border border-line rounded-(--radius-md) hover:border-accent-border hover:bg-line-subtle"
          >
            <Icon name={bundle() ? "folder" : "file"} class="tint-brand" />
            <View class="flex-1 min-w-0">
              <Text class="text-[12px] font-semibold text-ink leading-[15px] line-clamp-1">
                {bundle() ? (bundle()!.name ?? copy().stream.artifactBundle) : traceFileName(node().artifacts[0]!.path)}
              </Text>
              <Text class={`text-[10px] text-ink-muted leading-[13px] line-clamp-1 ${bundle() ? "" : "font-mono"}`} style={{ marginTop: 1 }}>
                {bundle() ? copy().stream.artifactBundleCount(bundle()!.fileCount) : node().artifacts[0]!.path}
              </Text>
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}
