/**
 * The plan Claude Code asks you to approve in plan mode (ADR 0098, `ProjectPlanCard.svelte`), where a
 * run's approval card goes: the plan as it wrote it, then approve (it gets to work, plan mode off) or
 * keep planning. A line you send meanwhile is what to change, so the card says to just write it
 * below. A long plan can take the whole window to be read, its buttons still under it.
 *
 * Full window: a full-size dialog over the window (the Svelte one moved the card to the top layer);
 * the card's height is held in the conversation meanwhile, so the transcript under it does not move.
 */
import { effect, platform, Scroll, signal, Text, View, windowSize } from "nsh";
import { Dialog } from "nsh/base";
import type { AgentRunApproval } from "@real-bot/protocol";
import { holdFullscreenPreview } from "../../m/overlays/fullscreen-preview.ts";
import { copy } from "../../runtime";
import { Button } from "../Button";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { MarkdownBody } from "../MarkdownBody";
import { shadow } from "../styles";
import { WheelLayer } from "../../platform/wheel-layer";

const READING_WIDTH = 760;

export function ProjectPlanCard(props: {
  approval: AgentRunApproval;
  disabled: boolean;
  onAnswer: (allow: boolean) => void;
  onOpenPath: (path: string) => void;
}) {
  const t = () => copy();
  const full = signal(false);
  /** The card's height in the conversation, held while it is out of it. */
  const height = signal(0);
  const held = signal(0);
  const hasPlan = () => props.approval.summary.trim().length > 0;

  function enter(): void {
    held.set(height());
    full.set(true);
  }

  /** Answering and opening a file land behind the whole window, so both leave it first. */
  function answer(allow: boolean): void {
    full.set(false);
    props.onAnswer(allow);
  }

  function openPath(path: string): void {
    full.set(false);
    props.onOpenPath(path);
  }

  effect(() => {
    if (!full()) return;
    const release = holdFullscreenPreview(() => full.set(false));
    return () => {
      release();
      held.set(0);
    };
  });

  const card = (isFull: boolean) => {
    const side = () => (isFull ? Math.max(24, (windowSize().width - READING_WIDTH) / 2) : 16);
    return (
      <>
        <View
          testID={isFull ? "plan-head-full" : "plan-head"}
          class={`flex-row items-center gap-[6px] border-b border-accent-border bg-accent-tint ${isFull ? "min-h-[52px]" : "py-[9px]"}`}
          style={{ paddingLeft: isFull && platform.os === "macos" && platform.desktop ? 84 : 16, paddingRight: isFull ? 16 : 16 }}
        >
          <Icon name="list" size={12} class="tint-brand" />
          <Text class="text-[12px] font-semibold text-brand">{t().project.planHead}</Text>
          <Text class="text-[12px] font-medium text-ink-secondary">{`· ${t().project.agentNames.claude_code}`}</Text>
          <If when={hasPlan()}>
            <View class={isFull ? "ml-auto" : "ml-auto -my-[4px] -mr-[8px]"}>
              <IconButton
                testID="plan-full-toggle"
                size="xs"
                icon={isFull ? "minimize" : "maximize"}
                label={isFull ? t().project.planExitFullscreen : t().project.planFullscreen}
                pressed={isFull}
                onPress={() => (isFull ? full.set(false) : enter())}
              />
            </View>
          </If>
        </View>
        <Scroll class={isFull ? "flex-1 min-h-0" : "max-h-[420px]"}>
          <View class={isFull ? "p-[24px]" : "px-[16px] py-[12px]"}>
            <View style={isFull ? { maxWidth: READING_WIDTH, width: "100%", alignSelf: "center" } : undefined}>
              <If when={hasPlan()} else={<Text testID="plan-empty" class="text-[13px] text-ink-muted">{t().project.planEmpty}</Text>}>
                {/* In the conversation it is part of the transcript's selection, which leaves a right click
                    to the pane's menu (`pane-menu.ts`); over the whole window it is an area of its own. */}
                <MarkdownBody testID="plan-body" selectable={isFull} source={props.approval.summary} copyLabel={t().chat.copyCode} copiedLabel={t().chat.copied} onOpenArtifact={openPath} />
              </If>
            </View>
          </View>
        </Scroll>
        <View
          class="flex-row flex-wrap items-center gap-x-[12px] gap-y-[8px] border-t border-line-subtle pt-[10px] pb-[14px]"
          style={{ paddingLeft: side(), paddingRight: side() }}
        >
          <View class="flex-row flex-wrap gap-[8px]">
            <Button testID="plan-approve" variant="primary" icon="check" disabled={props.disabled} onPress={() => answer(true)}>
              {t().project.planApprove}
            </Button>
            <Button testID="plan-keep" disabled={props.disabled} onPress={() => answer(false)}>
              {t().project.planKeep}
            </Button>
          </View>
          {/* The composer is under the card, not under the whole window. */}
          <Text testID="plan-hint" class="text-[12px] text-ink-muted">{isFull ? t().project.planHintFull : t().project.planHint}</Text>
        </View>
      </>
    );
  };

  return (
    <>
      <If
        when={full()}
        else={
          <View
            testID="plan-card"
            onLayout={(e) => height.set(e.bounds.size.height)}
            class="overflow-hidden bg-pane border border-accent-border rounded-(--radius-lg)"
            style={{ boxShadow: shadow("sm") }}
          >
            {card(false)}
          </View>
        }
      >
        <View testID="plan-held" style={{ height: held() }} />
        <Dialog
          open
          animation="fade"
          closeOnEscape
          closeOnBackdropPress={false}
          onCancel={() => full.set(false)}
          onOpenChange={(e) => {
            if (!e.open) full.set(false);
          }}
          backdropClass="bg-pane"
          class="bg-pane overflow-hidden"
          style={{ width: windowSize().width, height: windowSize().height }}
        >
          <WheelLayer>
            <View testID="plan-card-full" class="flex-1 bg-pane">
              {card(true)}
            </View>
          </WheelLayer>
        </Dialog>
      </If>
    </>
  );
}
