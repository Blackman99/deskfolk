/**
 * The narrow host for the board (`overlays/TaskTrace.svelte`): a page that fills the screen, with
 * Back to step out of it. On a wide window the same `JobLayout` is a pane instead.
 *
 * Not carried over: the page's slide-in (`pageSlide`).
 */
import type { JSX } from "nsh";
import { View } from "nsh";
import type { Attachment, Bot, BuiltinModelRole, Hold, Provider, SessionSummary } from "@real-bot/protocol";
import { copy } from "../../runtime";
import type { StopChoice } from "../../m/chat/stop-menu.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import type { TraceFocus } from "../../m/overlays/task-trace.ts";
import { JobLayout } from "./JobLayout";

export function TaskTrace(props: {
  api: MessengerApi | null;
  taskId: string | null;
  /** A line filed under no job, as its own board (ADR 0083). */
  line?: string | null;
  callEditor?: (role: BuiltinModelRole) => JSX.Element;
  focus?: TraceFocus | null;
  focusToken?: number;
  sessionId: string;
  activeSessionId: string;
  sessions: readonly SessionSummary[];
  bots: readonly Bot[];
  providers?: readonly Provider[];
  youLabel: string;
  deletedLabel: string;
  workspacePath: string | null;
  reloadToken: number;
  onClose: () => void;
  onJump: (sessionId: string, messageId: string) => void;
  onTask?: (taskId: string) => void;
  onOpenArtifact?: (
    relpath: string,
    att?: Attachment,
    messageId?: string | null,
    forceTree?: boolean,
    taskId?: string | null,
    siblings?: Attachment[] | null,
  ) => void;
  holds?: readonly Hold[] | null;
  onStop?: (choice: StopChoice) => Promise<unknown> | void;
  onLift?: (hold: Hold) => Promise<unknown> | void;
  controlsDisabled?: boolean;
  onOpenRoles?: (playbookId: string) => void;
}) {
  return (
    <View role="group" accessibilityLabel={copy().trace.title} testID="flow-board" class="absolute inset-0 bg-pane" style={{ zIndex: 70 }}>
      <JobLayout
        host="page"
        api={props.api}
        taskId={props.taskId}
        line={props.line}
        callEditor={props.callEditor}
        focus={props.focus}
        focusToken={props.focusToken}
        sessionId={props.sessionId}
        activeSessionId={props.activeSessionId}
        sessions={props.sessions}
        bots={props.bots}
        providers={props.providers}
        youLabel={props.youLabel}
        deletedLabel={props.deletedLabel}
        reloadToken={props.reloadToken}
        onClose={props.onClose}
        onJump={props.onJump}
        onTask={props.onTask}
        onOpenArtifact={props.onOpenArtifact}
        holds={props.holds}
        onStop={props.onStop}
        onLift={props.onLift}
        controlsDisabled={props.controlsDisabled}
        onOpenRoles={props.onOpenRoles}
      />
    </View>
  );
}
