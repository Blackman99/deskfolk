/**
 * The message box (`ComposerEditor.svelte`): an nsh/base `Input` that grows with its text up to a
 * cap, then scrolls. Enter sends, Shift+Enter breaks a line (with the interface profile's `mod_enter`
 * it is the other way round: ⌘/Ctrl+Enter sends); nothing is sent while an input method is composing,
 * nor in the moment after it committed (`composer-ime.ts`). Typing `@` offers the Bots (`MentionPopup`)
 * and, in a project session, a `/` that opens the line offers the agent's commands
 * (`ProjectCommandMenu`); ↑↓ move in the list, Enter or Tab choose, Esc or a press elsewhere closes it
 * until the text changes. ↑ in an empty box asks the owner to open your newest line for changing.
 *
 * The Svelte one is a contenteditable that turns `@Name` into inline chips with a close button; an
 * `Input` holds text only, so a mention stays `@Name ` in the box (the draft the Svelte serialised
 * to is the same text). The draft is the owner's: `value` and `onChange`.
 */
import { computed, effect, keymap, Overlay, platform, signal, untracked, View, windowSize, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import type { InputRef, PasteEvent } from "nsh/types";
import type { Bot, ClaudeCodeCommand } from "@real-bot/protocol";
import { COMPOSER_IME_IDLE, composerImeKeyAction, composerImeOnEnd, composerImeOnStart, type ComposerImeState } from "../../m/chat/composer-ime";
import type { MentionCandidate } from "../../m/chat/composer-mentions.svelte";
import { loadProjectCommands, matchCommands, projectCommandsOf, slashQuery, withCommand } from "../../m/chat/project-commands.svelte";
import { applyMentionCandidate, detectMentionTrigger } from "../../m/chat/mention-popup";
import { interfaceBehaviour } from "../../m/interface/behaviour.svelte";
import { copy, runtime } from "../../runtime";
import { boxHeight, caretAfterEdit, mentionCandidatesFor } from "./composer-editor";
import { MentionPopup } from "./MentionPopup";
import { ProjectCommandMenu } from "./ProjectCommandMenu";

/** What the owner can do to the box from outside: a quote reply or a starter chip lands the caret here. */
export type ComposerEditorHandle = { focus(): void; setSelection(start: number, end?: number): void };

export function ComposerEditor(props: {
  /** The draft. */
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  /** False: locked, or no conversation; the box shows dimmed and takes nothing. */
  editable: boolean;
  /** The file conversation: no Bot reads it, so there is no one to mention. */
  fileDrop?: boolean;
  /** The Bots an `@` offers: a group's present ones, else the Bots you can write to. */
  mentionBots?: readonly Bot[];
  /** A group: `@everyone` leads the list. */
  isGroup?: boolean;
  /** A project session's agent: its `/` commands, asked once per session. */
  commands?: { agentName: string; sessionId: string } | null;
  /** Enter (or ⌘/Ctrl+Enter), outside a list and while no input method is composing. */
  onSend: () => void;
  /** ↑ in an empty box: open your newest line for changing; true when one opened. */
  onEditLast?: () => boolean;
  /** Something was pasted (files go to the attachments). */
  onPaste?: (event: PasteEvent) => void;
  /** Gives the owner the handle. */
  onHandle?: (handle: ComposerEditorHandle | null) => void;
  testID?: string;
}) {
  const phone = () => !platform.desktop;
  const caret = signal(0);
  const composing = signal(false);
  const ime = { state: COMPOSER_IME_IDLE as ComposerImeState };
  const input = signal<InputRef | null>(null);
  const contentHeight = signal(0);
  const box = (): number => boxHeight(contentHeight(), phone(), windowSize().height);
  const at = () => Math.min(caret(), props.value.length);
  const editable = () => props.editable;

  // --- the @ list ---
  const mentionClosed = signal<{ anchor: number; query: string } | null>(null);
  const highlight = signal(0);
  const trig = (): { anchor: number; query: string } | null => {
    if (!editable() || props.fileDrop) return null;
    const found = detectMentionTrigger(props.value, at());
    return found.active ? { anchor: found.anchorIndex, query: found.query } : null;
  };
  const trigKey = computed(() => {
    const t = trig();
    return t ? `${t.anchor}:${t.query}` : "";
  });
  const candidates = (): MentionCandidate[] => {
    const t = trig();
    if (!t) return [];
    return mentionCandidatesFor({ query: t.query, isGroup: props.isGroup === true, bots: props.mentionBots ?? [], everyoneNote: copy().chat.mentionTooltip });
  };
  const mentionOpen = () => {
    const t = trig();
    const closed = mentionClosed();
    if (!t || candidates().length === 0) return false;
    return !(closed && closed.anchor === t.anchor && closed.query === t.query);
  };
  // Another word, or the same one elsewhere, starts at the first row and lifts an Esc.
  effect(() => {
    const key = trigKey();
    highlight.set(0);
    untracked(() => {
      const closed = mentionClosed();
      if (closed && `${closed.anchor}:${closed.query}` !== key) mentionClosed.set(null);
    });
  });
  const activeMention = () => Math.min(highlight(), Math.max(0, candidates().length - 1));

  function pickMention(candidate: MentionCandidate): void {
    const t = trig();
    if (!t) return;
    const next = applyMentionCandidate(props.value, t.anchor, at(), candidate.name);
    props.onChange(next.nextDraft);
    caret.set(next.nextCursor);
    place(next.nextCursor);
  }

  // --- the / list (a project session's commands) ---
  const closedAt = signal<string | null>(null);
  const commandActive = signal(0);
  const commandQuery = () => (props.commands && editable() ? slashQuery(props.value, at()) : null);
  const commandsShown = () => commandQuery() !== null && closedAt() !== props.value;
  const commandsState = () => (commandsShown() && props.commands ? projectCommandsOf(props.commands.sessionId) : null);
  const commandMatches = (): ClaudeCodeCommand[] => {
    const state = commandsState();
    const query = commandQuery();
    return Array.isArray(state) && query !== null ? matchCommands(state, query) : [];
  };
  const commandsListed = () => commandsShown() && commandMatches().length > 0;
  effect(() => {
    if (!commandsShown() || !props.commands) return;
    loadProjectCommands(runtime.client, props.commands.sessionId);
  });
  effect(() => {
    void commandQuery();
    commandActive.set(0);
  });
  const activeCommand = () => Math.min(commandActive(), Math.max(0, commandMatches().length - 1));
  const enterSends = () => interfaceBehaviour().send_key !== "mod_enter";

  /** A picked command fills the line's first word; `run` sends it as it stands. */
  function pickCommand(command: ClaudeCodeCommand, run: boolean): void {
    const next = withCommand(props.value, command.name, run);
    props.onChange(next.text);
    caret.set(next.caret);
    if (run) {
      props.onSend();
      return;
    }
    place(next.caret);
  }

  /** The caret after the text the owner has just set. */
  function place(position: number): void {
    setTimeout(() => {
      input()?.focus();
      input()?.setSelection(position);
    }, 0);
  }

  // --- keys ---
  // While a list is open the arrows, Tab and Enter are the list's: the input does not use them itself in a way that matters here.
  effect(() => {
    if (!editable()) return;
    const off: (() => void)[] = [];
    const bind = (stroke: string, fn: () => void, repeat = false) => off.push(keymap.bind(stroke, fn, { when: "always", repeat }));
    if (mentionOpen()) {
      const count = () => candidates().length;
      bind("down", () => highlight.set((activeMention() + 1) % count()), true);
      bind("up", () => highlight.set((activeMention() - 1 + count()) % count()), true);
      const choose = () => {
        const candidate = candidates()[activeMention()];
        if (candidate) pickMention(candidate);
      };
      bind("enter", choose);
      bind("tab", choose);
    } else if (commandsListed()) {
      const count = () => commandMatches().length;
      bind("down", () => commandActive.set((activeCommand() + 1) % count()), true);
      bind("up", () => commandActive.set((activeCommand() + count() - 1) % count()), true);
      // With ⌘/Ctrl+Enter the key that sends, Enter only fills the command in, as Tab does.
      bind("enter", () => pickCommand(commandMatches()[activeCommand()]!, enterSends()));
      bind("tab", () => pickCommand(commandMatches()[activeCommand()]!, false));
    } else if (props.onEditLast && !props.value.trim()) {
      bind("up", () => void props.onEditLast?.());
    }
    bind("mod+enter", () => submit());
    return () => off.forEach((fn) => fn());
  });

  /** Enter, unless an input method is composing or just committed (the Enter that confirms a candidate must not send). */
  function submit(): void {
    if (!editable()) return;
    const action = composerImeKeyAction({ isComposing: composing(), key: "Enter", keyCode: 13 }, ime.state, performance.now());
    if (action === "swallow") {
      ime.state = COMPOSER_IME_IDLE;
      return;
    }
    if (action === "ignore") return;
    props.onSend();
  }

  const closeLists = () => {
    const t = trig();
    if (t && mentionOpen()) mentionClosed.set(t);
    if (commandsShown()) closedAt.set(props.value);
  };

  const popupWidth = (max: number) => Math.min(max, Math.max(240, windowSize().width - 32));
  const anchor = (): ViewRef | null => input() as unknown as ViewRef | null;

  return (
    <View class="flex-1 min-w-0">
      <Input
        testID={props.testID ?? "composer-input"}
        ref={(node: InputRef | null) => {
          input.set(node);
          props.onHandle?.(node ? { focus: () => node.focus(), setSelection: (a, b) => node.setSelection(a, b) } : null);
        }}
        value={props.value}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        multiline
        submitBehavior={interfaceBehaviour().send_key === "mod_enter" ? "newline" : "submit"}
        pasteBehavior={editable() ? "insert" : "report"}
        readonly={!editable()}
        onChange={(e) => {
          caret.set(caretAfterEdit(props.value, e.value));
          props.onChange(e.value);
        }}
        onSelectionChange={(e) => caret.set(e.end)}
        onSubmit={() => submit()}
        onPaste={(e) => props.onPaste?.(e)}
        onCompositionChange={(e) => {
          if (e.composing) {
            composing.set(true);
            if (!ime.state.composing) ime.state = composerImeOnStart();
          } else {
            composing.set(false);
            ime.state = composerImeOnEnd(performance.now());
          }
        }}
        onContentSizeChange={(e) => contentHeight.set(e.size.height)}
        class={`min-w-0 text-ink placeholder:text-ink-muted ${phone() ? "text-[15px] px-1 py-[9px]" : "text-[14px] pl-1 pr-[6px] py-[6px]"} ${editable() ? "" : "opacity-[0.45]"}`}
        style={{ height: box() }}
      />
      <If when={anchor() && mentionOpen()}>
        <Overlay anchor={anchor()} placement="top" align="start" offset={6} margin={8} onPressOutside={closeLists} onCancel={closeLists}>
          <MentionPopup
            candidates={candidates()}
            highlight={activeMention()}
            width={popupWidth(380)}
            onHover={(i) => highlight.set(i)}
            onPick={pickMention}
          />
        </Overlay>
      </If>
      <If when={anchor() && !mentionOpen() && commandsShown()}>
        <Overlay anchor={anchor()} placement="top" align="start" offset={6} margin={8} onPressOutside={closeLists} onCancel={closeLists}>
          <ProjectCommandMenu
            agentName={props.commands?.agentName ?? ""}
            status={commandsState()}
            matches={commandMatches()}
            active={activeCommand()}
            width={popupWidth(520)}
            onHover={(i) => commandActive.set(i)}
            onPick={(command) => pickCommand(command, false)}
          />
        </Overlay>
      </If>
    </View>
  );
}
