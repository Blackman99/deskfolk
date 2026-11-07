/**
 * The message box (`ComposerEditor.svelte`): an nsh/base `RichEditor` that grows with its text up to
 * a cap, then scrolls. A picked mention is an inline chip, one atom (the document's `mention` node,
 * carrying the member id) that Backspace and Delete take away whole, with the space after it, and
 * that the draft reads as `@Name` (`composer-doc.ts`), as the Svelte contenteditable serialises its
 * chips. Enter sends, Shift+Enter breaks a line (with the interface profile's `mod_enter` it is the
 * other way round: ⌘/Ctrl+Enter sends); nothing is sent while an input method is composing, nor in
 * the moment after it committed (`composer-ime.ts`). Typing `@` offers the Bots (`MentionPopup`)
 * and, in a project session, a `/` that opens the line offers the agent's commands
 * (`ProjectCommandMenu`); ↑↓ move in the list, Enter or Tab choose, Esc or a press elsewhere closes it
 * until the text changes. ↑ in an empty box asks the owner to open your newest line for changing.
 *
 * The draft is the owner's string (`value` and `onChange`); the editor's document follows it when the
 * owner changes it (a quote, a suggestion, a send that clears it), turning each `@Name` of a Bot the
 * list names into a chip. Not as the Svelte one: a chip has no avatar and no close button (the
 * editor has no node views for the app), and a `@Name` typed by hand stays text until picked.
 */
import { cleanup, computed, effect, Overlay, platform, signal, untracked, View, windowSize, type ViewRef } from "nsh";
import { baseKeymap, command, createRichEditor, defineSchema, deleteRange, history, insertContentAt, keymap as editorKeymap, RichEditor, RichEditorPlugin, setTextSelection, withMention } from "nsh/base";
import type { RichEditorRef, RichEditorSession, RichNodeJSON } from "nsh/base";
import type { PasteEvent } from "nsh/types";
import type { Bot, ClaudeCodeCommand } from "@real-bot/protocol";
import { COMPOSER_IME_IDLE, composerImeKeyAction, composerImeOnEnd, composerImeOnStart, type ComposerImeState } from "../../m/chat/composer-ime";
import type { MentionCandidate } from "../../m/chat/composer-mentions.svelte";
import { loadProjectCommands, matchCommands, projectCommandsOf, slashQuery, withCommand } from "../../m/chat/project-commands.svelte";
import { detectMentionTrigger } from "../../m/chat/mention-popup";
import { interfaceBehaviour } from "../../m/interface/behaviour.svelte";
import { copy, runtime } from "../../runtime";
import { backspaceRange, chipNode, chipsOf, deleteRange as chipDeleteRange, docFromText, offsetToPos, posToOffset, textOfDoc, type DocNode } from "./composer-doc";
import { boxHeight, mentionCandidatesFor } from "./composer-editor";
import { MentionPopup } from "./MentionPopup";
import { ProjectCommandMenu } from "./ProjectCommandMenu";

/** Paragraphs of text and chips: the composer's whole schema. */
const SCHEMA = withMention(
  defineSchema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: ["p", 0] },
      text: { group: "inline" },
    },
  }),
);

/** What the owner can do to the box from outside: a quote reply or a starter chip lands the caret here. */
export type ComposerEditorHandle = {
  focus(): void;
  setSelection(start: number, end?: number): void;
  /** The selection now, as offsets into the draft (where a voice transcript goes in). */
  selection(): { start: number; end: number };
  /** The chips now, in order (the member ids a send carries; tests read them). */
  chips(): { id: string; label: string }[];
};

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
  /** Who a draft's `@Name` may be a chip for: the Bots the @ list offers. */
  const roster = (): { id: string; name: string }[] => (props.mentionBots ?? []).map((bot) => ({ id: bot.id, name: bot.name }));
  const asDoc = (text: string) => docFromText(text, roster()) as unknown as RichNodeJSON[];

  /** The draft the editor last held or was given: the owner's value is the editor's own change until it differs. */
  let known = props.value;
  /** The captured keys (see `// --- keys ---`): created with the session, handled and switched on below. */
  type KeyPlugin = { plugin: RichEditorPlugin; handler: (key: string) => void };
  const keyPlugin = (name: string, keys: string[]): KeyPlugin => {
    const entry: KeyPlugin = { plugin: undefined as unknown as RichEditorPlugin, handler: () => {} };
    entry.plugin = new RichEditorPlugin(`composer-${name}`).captureKeys(keys, (key) => entry.handler(key));
    return entry;
  };
  const keyPlugins = {
    list: keyPlugin("list", ["ArrowDown", "ArrowUp", "Tab"]),
    enter: keyPlugin("enter", ["Enter"]),
    modEnter: keyPlugin("mod-enter", ["Mod-Enter"]),
    up: keyPlugin("up", ["ArrowUp"]),
    back: keyPlugin("backspace", ["Backspace"]),
    del: keyPlugin("delete", ["Delete"]),
  };
  const session: RichEditorSession = createRichEditor({
    schema: SCHEMA,
    doc: { type: "doc", content: asDoc(props.value) },
    // Shift+Enter breaks the line (Enter does too, unless the keymap below takes it to send).
    plugins: [history(), editorKeymap({ "Shift-Enter": command("splitBlock") }), ...Object.values(keyPlugins).map((k) => k.plugin), baseKeymap()],
    editable: props.editable,
  });
  cleanup(() => session.dispose());
  const composing = signal(false);
  const ime = { state: COMPOSER_IME_IDLE as ComposerImeState };
  const editorRef = signal<RichEditorRef | null>(null);
  /** Bumped by every change of the document or the selection: what the derived values below follow. */
  const tick = signal(0);
  const docOf = (): { content?: DocNode[] } => session.doc as unknown as { content?: DocNode[] };
  /** The selection now, as draft offsets (read straight from the editor: the owner's handle needs it at once). */
  const selectionNow = (): { start: number; end: number } => {
    const doc = docOf();
    const sel = session.selection as unknown as { anchor?: number; head?: number };
    const head = sel.head ?? 1;
    const anchor = sel.anchor ?? head;
    return { start: posToOffset(doc, Math.min(anchor, head)), end: posToOffset(doc, Math.max(anchor, head)) };
  };
  const view = computed(() => {
    tick();
    const selection = selectionNow();
    const doc = docOf();
    return { selection, caret: selection.end, doc, text: textOfDoc(doc) };
  });
  const contentHeight = computed(() => {
    tick();
    const doc = docOf();
    const end = offsetToPos(doc, Number.MAX_SAFE_INTEGER);
    try {
      const at = session.coordsAtPos(end) as { y: number; height: number } | null;
      if (at) return Math.max(0, at.y + at.height - 6);
    } catch {
      // Not laid out yet: the lines count stands in.
    }
    return textOfDoc(doc).split("\n").length * 22;
  });
  const box = (): number => boxHeight(contentHeight(), phone(), windowSize().height);
  const at = () => view().caret;
  const editable = () => props.editable;

  // The editor to the owner: each change of the document hands the draft up.
  const changed = (): void => {
    const text = session.getText();
    if (text !== known) {
      known = text;
      props.onChange(text);
    }
  };
  let wasComposing = false;
  const follow = (): void => {
    tick.set(tick() + 1);
    const now = session.composing;
    if (now !== wasComposing) {
      wasComposing = now;
      composing.set(now);
      ime.state = now ? composerImeOnStart() : composerImeOnEnd(performance.now());
    }
  };
  session.on("revision", () => {
    changed();
    follow();
  });
  session.on("selectionUpdate", follow);
  session.on("transaction", follow);

  // The owner to the editor: a draft the editor did not make (a quote, a suggestion, a send that cleared it) replaces the document.
  effect(() => {
    const text = props.value;
    untracked(() => {
      if (text === known) return;
      known = text;
      session.setContent(asDoc(text) as unknown as RichNodeJSON[]);
      session.run(setTextSelection(offsetToPos(docOf(), Number.MAX_SAFE_INTEGER)));
      tick.set(tick() + 1);
    });
  });
  effect(() => {
    session.setEditable(props.editable);
  });

  // --- the @ list ---
  const mentionClosed = signal<{ anchor: number; query: string } | null>(null);
  const highlight = signal(0);
  const trig = (): { anchor: number; query: string } | null => {
    if (!editable() || props.fileDrop) return null;
    const found = detectMentionTrigger(view().text, at());
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
    const doc = docOf();
    // `@Name ` where `@query` was, as `applyMentionCandidate` makes the draft: the chip reads as `@Name`, the space is text.
    const range = { from: offsetToPos(doc, t.anchor), to: offsetToPos(doc, at()) };
    session.run(insertContentAt(range, [chipNode({ id: candidate.id, label: candidate.name }), { type: "text", text: " " }]));
    session.focus();
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
    if (run) {
      props.onSend();
      return;
    }
    place(next.caret);
  }

  /** The caret after the text the owner has just set (the editor takes the draft in its next turn). */
  function place(position: number): void {
    setTimeout(() => {
      session.focus();
      const doc = docOf();
      session.run(setTextSelection(offsetToPos(doc, position)));
    }, 0);
  }

  // --- keys ---
  // The editor swallows app-level `keymap` bindings while it has the focus, so its keys are `RichEditorPlugin.captureKeys`:
  // the native editor consumes them while the plugin is `capturing` and tells the handler after. One plugin per
  // condition, since a plugin captures all its keys or none.
  const listOpen = () => mentionOpen() || commandsListed();
  const capture = (entry: KeyPlugin, handler: (key: string) => void, on: () => boolean) => {
    entry.handler = handler;
    effect(() => {
      entry.plugin.capturing = editable() && on();
    });
  };
  const chooseMention = () => {
    const candidate = candidates()[activeMention()];
    if (candidate) pickMention(candidate);
  };
  capture(
    keyPlugins.list,
    (key) => {
      if (mentionOpen()) {
        const count = candidates().length;
        if (key === "ArrowDown") highlight.set((activeMention() + 1) % count);
        else if (key === "ArrowUp") highlight.set((activeMention() - 1 + count) % count);
        else chooseMention();
      } else if (commandsListed()) {
        const count = commandMatches().length;
        if (key === "ArrowDown") commandActive.set((activeCommand() + 1) % count);
        else if (key === "ArrowUp") commandActive.set((activeCommand() + count - 1) % count);
        else pickCommand(commandMatches()[activeCommand()]!, false);
      }
    },
    listOpen,
  );
  // Enter: a list's choice; else, unless ⌘/Ctrl+Enter is the send key, a send (with `mod_enter` the editor's own keymap breaks the line).
  capture(
    keyPlugins.enter,
    () => {
      if (mentionOpen()) chooseMention();
      else if (commandsListed()) pickCommand(commandMatches()[activeCommand()]!, enterSends());
      else submit();
    },
    () => listOpen() || enterSends(),
  );
  capture(keyPlugins.modEnter, () => submit(), () => true);
  capture(keyPlugins.up, () => void props.onEditLast?.(), () => !listOpen() && !!props.onEditLast && !props.value.trim());
  // A chip goes whole: Backspace right after it (or after the space that follows it) and Delete right before it take the
  // chip and that space away. The keys are captured only where the caret is next to a chip.
  const caretNow = (): number => (session.selection as unknown as { head?: number }).head ?? 0;
  const collapsed = (): boolean => {
    const sel = session.selection as unknown as { anchor?: number; head?: number };
    return sel.anchor === undefined || sel.anchor === sel.head;
  };
  const take = (range: { from: number; to: number } | null) => {
    if (range) session.run(deleteRange(range));
  };
  capture(keyPlugins.back, () => take(backspaceRange(docOf(), caretNow())), () => {
    tick();
    return !composing() && collapsed() && backspaceRange(docOf(), caretNow()) !== null;
  });
  capture(keyPlugins.del, () => take(chipDeleteRange(docOf(), caretNow())), () => {
    tick();
    return !composing() && collapsed() && chipDeleteRange(docOf(), caretNow()) !== null;
  });

  /** Enter, unless an input method is composing or just committed (the Enter that confirms a candidate must not send). */
  function submit(): void {
    if (!editable()) return;
    const action = composerImeKeyAction({ isComposing: session.composing, key: "Enter", keyCode: 13 }, ime.state, performance.now());
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
  const anchor = (): ViewRef | null => editorRef()?.node ?? null;

  /** What a paste brings besides text: files go to the attachments (the editor reports them, inserts nothing). */
  const pasted = (event: { paste: { files: { name: string; mime: string; data: Uint8Array }[]; uris: string[] } }): void => {
    const files = event.paste.files.map((file) => new File([file.data as unknown as BlobPart], file.name, { type: file.mime }));
    props.onPaste?.({ files, uris: event.paste.uris } as unknown as PasteEvent);
  };

  return (
    <View class="flex-1 min-w-0">
      <RichEditor
        testID={props.testID ?? "composer-input"}
        editor={session}
        ref={(node: RichEditorRef | null) => {
          editorRef.set(node);
          props.onHandle?.(
            node
              ? {
                  focus: () => session.focus(),
                  setSelection: (a, b) => {
                    const doc = docOf();
                    session.run(setTextSelection(offsetToPos(doc, a), offsetToPos(doc, b ?? a)));
                  },
                  selection: () => selectionNow(),
                  chips: () => chipsOf(docOf()).map(({ id, label }) => ({ id, label })),
                }
              : null,
          );
        }}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        editable={editable()}
        onPasteFiles={pasted}
        classes={{
          content: phone() ? "text-[15px] px-1 py-[9px]" : "text-[14px] pl-1 pr-[6px] py-[6px]",
          nodes: { mention: "bg-accent-tint text-accent-hover font-semibold rounded-full px-[6px]" },
        }}
        class={`min-w-0 text-ink ${editable() ? "" : "opacity-[0.45]"}`}
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
