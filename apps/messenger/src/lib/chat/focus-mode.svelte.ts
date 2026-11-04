import { forgetStored, readStored, writeStored } from "../storage.ts";

const STORAGE_KEY = "real-bot-chat-focus";

let on = $state(readStored(STORAGE_KEY) === "1");
/** The interface profile's (ADR 0106), shared by every window; undefined where it says nothing. */
let kept = $state<boolean | undefined>(undefined);
let write: ((value: boolean) => void) | null = null;

/**
 * Focus mode: the transcript shows what was said and what waits on you, and leaves out what is
 * said about it — times, how long a reply took, the commands a turn ran, model tags, Bot↔Bot
 * entries. One switch for every conversation and pane. Since ADR 0106 it is part of your interface
 * profile, so every window and a paired phone follow it; this browser's own choice is kept too, for
 * a daemon that predates it.
 */
export const focusMode = {
  get on(): boolean {
    return kept ?? on;
  },
  set(value: boolean): void {
    on = value;
    if (value) writeStored(STORAGE_KEY, "1");
    else forgetStored(STORAGE_KEY);
    if (write) {
      kept = value;
      write(value);
    }
  },
  toggle(): void {
    focusMode.set(!focusMode.on);
  },
};

/** What the interface profile says, and how to change it there; a null writer keeps it in this browser only. */
export function adoptFocusMode(value: boolean | undefined, writer: ((value: boolean) => void) | null): void {
  kept = value;
  write = writer;
}

/** This browser's own choice, for carrying it into the profile once. */
export function localFocusMode(): boolean {
  return on;
}
