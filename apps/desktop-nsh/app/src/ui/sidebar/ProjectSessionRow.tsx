/**
 * One project session under its directory (`sidebar/ProjectSessionRow.svelte`, ADR 0095), the size
 * of a Bot's row and saying the same: its agent's mark, its name and time, the run's status or else
 * the last line, and the unread count. The mark is the session's, not the directory's: one
 * directory can hold sessions of different agents. Renaming turns the row into a name field of the
 * same height.
 */
import { effect, keymap, signal, Text, token, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef } from "nsh";
import type { Bot, ProjectAgent, SessionSummary } from "@real-bot/protocol";
import type { SessionDrag } from "./session-drag";
import type { SessionStatusResult } from "../../m/sidebar/session-status";
import { copy } from "../../runtime";
import { narrowWindow } from "../Modal";
import { shadow } from "../styles";
import { tip } from "../tip";
import { AgentAvatar } from "./AgentAvatar";
import { SessionRow, type MenuAt } from "./SessionRow";
import { SIDE_MUTED_TEXT } from "../glass";

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
  const t = () => copy();
  const draft = signal("");
  const failed = signal(false);
  const composing = signal(false);
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

  return (
    <If
      when={props.renaming}
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
      {/* The row it stands in for, line for line, so starting a rename moves nothing below it. */}
      <View
        testID="project-rename"
        class={`flex-row items-center ${phone() ? "px-[14px] py-[10px] gap-3" : "my-[1px] px-[10px] py-2 gap-[10px] rounded-(--radius-md) border"} ${props.on ? (phone() ? "bg-accent-tint" : "bg-pane border-line") : phone() ? "" : "border-transparent"}`}
        style={props.on && !phone() ? { boxShadow: shadow("sm") } : undefined}
      >
        <AgentAvatar agent={props.agent} title={t().project.agentNames[props.agent]} ringColor={props.on ? token("pane") : undefined} />
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
            class={`min-w-0 px-[6px] -ml-[7px] rounded-(--radius-sm) bg-input-bg text-ink font-semibold border ${failed() ? "border-danger" : "border-field-focus-border"} ${phone() ? "h-[24px] text-[16px]" : "h-[21px] text-[14px]"}`}
          />
          <Text testID="row-preview" class={`mt-[2px] line-clamp-1 ${SIDE_MUTED_TEXT} ${phone() ? "text-[13px] h-[18px]" : "text-[12px] h-[17px]"}`}>
            {props.preview}
          </Text>
        </View>
      </View>
    </If>
  );
}
