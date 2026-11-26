/**
 * One project session under its directory (`sidebar/ProjectSessionRow.svelte`, ADR 0095):
 * - On desktop: a compact single-line tree row (bare 16px agent mark, wider title, right-aligned
 *   inline status or timestamp, hover pin/more pill, and matching single-line inline rename).
 * - On phone: a touch-friendly two-line `SessionRow`.
 */
import { effect, keymap, platform, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef } from "nsh";
import type { Bot, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import { sessionPan, type SessionDrag } from "./session-drag";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { unreadBadge } from "../../m/sidebar/unread";
import { copy } from "../../runtime";
import { Icon } from "../Icon";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";
import { AgentAvatar } from "./AgentAvatar";
import { foldMotion } from "./fold-motion";
import { SessionRow, type MenuAt } from "./SessionRow";
import { SIDE_MUTED_TEXT, SIDE_MUTED_TINT, windowGlass } from "../glass";

const STATUS_DOT: Record<string, string> = {
  running: "bg-brand",
  replying: "bg-brand",
  waiting_approval: "bg-warn",
  waiting_ask: "bg-purple",
  failed: "bg-danger",
  interrupted: "bg-danger",
};
const STATUS_TEXT: Record<string, string> = {
  running: "text-brand font-semibold",
  replying: "text-brand font-semibold",
  waiting_approval: "text-warn-text font-semibold",
  waiting_ask: "text-purple-text font-semibold",
  failed: "text-danger-text font-semibold",
  interrupted: "text-danger-text font-semibold",
};

export function ProjectSessionRow(props: {
  session: SessionSummary;
  /** The open conversation. */
  on: boolean;
  /** The row the context menu belongs to. */
  contextOpen: boolean;
  title: string;
  /** The agent it runs: its mark leads the row. */
  agent: ProjectAgent;
  /** Its own name; null while your first line has not named it yet. */
  name?: string | null;
  /** The row is a name field: Enter or leaving it saves, Escape leaves the name as it was. */
  renaming?: boolean;
  /** The new name, or null to leave it; false when it did not go through, so the field stays. */
  onRename?: (name: string | null) => Promise<boolean>;
  time: string;
  /** The run at work or waiting on you in it, said as a Bot's turn would be. */
  status: SessionStatusResult;
  preview: string;
  unread: number;
  bots: ReadonlyMap<string, Bot>;
  botStatus: (botId: string) => SessionStatusResult | undefined;
  onSelect: () => void;
  onContextMenu: (at: MenuAt) => void;
  onDrag?: SessionDrag;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const fold = foldMotion();
  const t = () => copy();
  const draft = signal("");
  const failed = signal(false);
  const composing = signal(false);
  const hovered = signal(false);
  let field: InputRef | null = null;
  /** Enter and the blur that follows it are one save, not two; Escape's blur saves nothing. */
  let saving = false;
  let done = false;

  effect(() => {
    if (!props.renaming) return;
    draft.set(props.name ?? "");
    failed.set(false);
    done = false;
    queueMicrotask(() => {
      field?.focus();
      field?.setSelection(0, (props.name ?? "").length);
    });
  });

  // Escape leaves the name as it was; the blur that follows saves nothing.
  effect(() => {
    if (!props.renaming) return;
    return keymap.bind(
      "escape",
      () => {
        done = true;
        void props.onRename?.(null);
      },
      { when: "always" },
    );
  });

  async function commit(): Promise<void> {
    if (saving || done || !props.onRename) return;
    const next = draft().trim();
    saving = true;
    // Blank or unchanged leaves the name as it was.
    const ok = await props.onRename(next && next !== (props.name ?? "") ? next : null);
    saving = false;
    done = ok;
    failed.set(!ok);
    if (!ok) field?.focus();
  }

  const phone = () => narrowWindow();
  const idle = () => props.status.kind === "idle";
  const unreadOn = () => props.unread > 0;
  const showActions = () => Boolean(props.onTogglePin) && hovered() && !phone() && platform.desktop;
  const at = (e: { pagePosition: { x: number; y: number } }): MenuAt => ({ x: e.pagePosition.x, y: e.pagePosition.y });
  const desktopRowClass = () => {
    const base = "my-[1px] px-[7px] py-[5px] gap-[7px] rounded-(--radius-sm) border";
    if (props.on) return windowGlass ? `${base} bg-ink/10 border-ink/10` : `${base} bg-pane border-line`;
    if (props.contextOpen) return `${base} ${windowGlass ? "bg-ink/6" : "bg-line-subtle"} border-transparent`;
    return `${base} border-transparent hover:bg-row-hover`;
  };
  const rowTip = () => (props.preview ? tip(`${props.title}\n${props.preview}`) : tip(props.title));

  return (
    <If
      when={props.renaming}
      else={
        <If
          when={!phone()}
          else={
            <SessionRow
              session={props.session}
              on={props.on}
              contextOpen={props.contextOpen}
              agent={props.agent}
              title={props.title}
              time={props.time}
              status={props.status}
              preview={props.preview}
              unread={props.unread}
              bots={props.bots}
              botStatus={props.botStatus}
              onSelect={props.onSelect}
              onContextMenu={props.onContextMenu}
              onDrag={props.onDrag}
              pinned={props.pinned}
              onTogglePin={props.onTogglePin}
            />
          }
        >
          <View
            class="relative"
            onMouseEnter={() => hovered.set(true)}
            onMouseLeave={() => hovered.set(false)}
          >
            <View
              role="button"
              testID={`session-${props.session.id}`}
              accessibilityLabel={props.title}
              accessibilityState={{ selected: props.on }}
              tooltip={rowTip()}
              onPress={() => props.onSelect()}
              onContextMenu={(e) => props.onContextMenu(at(e))}
              {...sessionPan(() => props.onDrag)}
              class={`cursor-pointer select-none flex-row items-center active:scale-[0.985] ${desktopRowClass()}`}
              style={props.on && !windowGlass ? { boxShadow: shadow("xs") } : undefined}
            >
              <AgentAvatar
                agent={props.agent}
                title={t().project.agentNames[props.agent]}
                status={props.status}
                compact
                edge={18}
              />
              <Text
                testID="row-title"
                class={`flex-1 min-w-0 text-[13px] leading-[18px] line-clamp-1 text-ink ${
                  unreadOn() || props.on ? "font-semibold" : "font-medium"
                }`}
                style={fold?.text}
              >
                {props.title}
              </Text>
              <If when={!showActions()}>
                <If
                  when={!idle()}
                  else={
                    <View class="flex-row items-center gap-[5px] shrink-0" style={fold?.text}>
                      <If when={unreadOn()}>
                        <View
                          testID="unread-dot"
                          tooltip={tip(t().sidebar.unread)}
                          class="items-center justify-center rounded-full bg-mustard min-w-[16px] h-[16px] px-[4px]"
                        >
                          <Text class="font-bold text-on-mustard text-[10px]">{unreadBadge(props.unread)}</Text>
                        </View>
                      </If>
                      <Text
                        testID="row-time"
                        class={`text-[11px] leading-[16px] shrink-0 ${unreadOn() ? "text-mustard-ink font-semibold" : SIDE_MUTED_TEXT}`}
                      >
                        {props.time}
                      </Text>
                    </View>
                  }
                >
                  <View testID="row-status" class="flex-row items-center gap-[4px] shrink-0" style={fold?.text}>
                    <View class={`w-[6px] h-[6px] rounded-full shrink-0 ${STATUS_DOT[props.status.kind] ?? "bg-ok"}`} />
                    <Text class={`text-[11px] leading-[16px] ${STATUS_TEXT[props.status.kind] ?? SIDE_MUTED_TEXT}`}>
                      {props.status.label}
                    </Text>
                    <If when={props.status.count}>
                      {(count) => (
                        <View class="h-[15px] min-w-[15px] px-[3px] rounded-full bg-warn-text items-center justify-center">
                          <Text class="text-[10px] font-bold text-on-warn">{String(count())}</Text>
                        </View>
                      )}
                    </If>
                  </View>
                </If>
              </If>
            </View>
            <If when={showActions()}>
              <View
                testID={`session-actions-${props.session.id}`}
                class="absolute right-[6px] top-0 bottom-0 justify-center"
                style={{ pointerEvents: "box-none" }}
              >
                <View
                  class="flex-row gap-[2px] p-[2px] rounded-(--radius-pill-group) bg-pane border border-line"
                  style={{ boxShadow: shadow("md") }}
                >
                  <View
                    role="button"
                    testID={`session-pin-${props.session.id}`}
                    accessibilityLabel={props.pinned ? t().sidebar.unpin : t().sidebar.pin}
                    accessibilityState={{ selected: props.pinned === true }}
                    tooltip={tip(props.pinned ? t().sidebar.unpin : t().sidebar.pin)}
                    onPress={() => props.onTogglePin?.()}
                    class="cursor-pointer select-none group w-[22px] h-[22px] rounded-(--radius-control-sm) items-center justify-center hover:bg-row-hover active:scale-[0.9]"
                  >
                    <Icon name="pin" size={12} class={props.pinned ? "tint-brand" : `${SIDE_MUTED_TINT} group-hover:tint-ink`} />
                  </View>
                  <View
                    role="button"
                    testID={`session-more-${props.session.id}`}
                    accessibilityLabel={t().chat.moreActions}
                    tooltip={tip(t().chat.moreActions)}
                    onPress={(e) => props.onContextMenu(at(e))}
                    class="cursor-pointer select-none group w-[22px] h-[22px] rounded-(--radius-control-sm) items-center justify-center hover:bg-row-hover active:scale-[0.9]"
                  >
                    <Icon name="more" size={12} class={`${SIDE_MUTED_TINT} group-hover:tint-ink`} />
                  </View>
                </View>
              </View>
            </If>
          </View>
        </If>
      }
    >
      {/* The row it stands in for, line for line, so starting a rename moves nothing below it. */}
      <View
        testID="project-rename"
        class={`flex-row items-center ${
          phone()
            ? `px-[14px] py-[10px] gap-3 ${props.on ? "bg-accent-tint" : ""}`
            : `my-[1px] px-[7px] py-[4px] gap-[7px] rounded-(--radius-sm) border ${
                props.on ? (windowGlass ? "bg-ink/10 border-ink/10" : "bg-pane border-line") : "border-transparent"
              }`
        }`}
        style={props.on && !phone() && !windowGlass ? { boxShadow: shadow("xs") } : undefined}
      >
        <AgentAvatar
          agent={props.agent}
          title={t().project.agentNames[props.agent]}
          compact={!phone()}
          edge={phone() ? undefined : 18}
          ringColor={props.on ? token("pane") : undefined}
        />
        <View class="flex-1 min-w-0">
          <Input
            testID="project-rename-field"
            ref={(node: InputRef | null) => {
              field = node;
            }}
            value={draft()}
            maxLength={200}
            placeholder={t().project.untitled}
            accessibilityLabel={t().project.renameLabel}
            autoFocus
            tooltip={failed() ? tip(t().project.renameFailed) : undefined}
            submitBehavior="submit"
            onChange={(e) => {
              draft.set(e.value);
              failed.set(false);
            }}
            onCompositionChange={(e) => composing.set(e.composing)}
            onSubmit={() => {
              // Enter that confirms an input method's candidate is the input method's.
              if (!composing()) void commit();
            }}
            onBlur={() => void commit()}
            class={`min-w-0 px-[6px] -ml-[6px] rounded-(--radius-sm) bg-input-bg text-ink font-semibold border ${
              failed() ? "border-danger" : "border-field-focus-border"
            } ${phone() ? "h-[24px] text-[16px]" : "h-[22px] text-[13px]"}`}
          />
          <If when={phone()}>
            <Text testID="row-preview" class={`mt-[2px] line-clamp-1 ${SIDE_MUTED_TEXT} text-[13px] h-[18px]`}>
              {props.preview}
            </Text>
          </If>
        </View>
      </View>
    </If>
  );
}
