import { forgetStored, readStored, writeStored } from "../storage.ts";

const STORAGE_KEY = "real-bot-chat-focus";

let on = $state(readStored(STORAGE_KEY) === "1");

/**
 * Focus mode: the transcript shows what was said and what waits on you, and leaves out what is
 * said about it — times, how long a reply took, the commands a turn ran, model tags, Bot↔Bot
 * entries. One switch for every conversation and pane, kept per browser.
 */
export const focusMode = {
  get on(): boolean {
    return on;
  },
  set(value: boolean): void {
    on = value;
    if (value) writeStored(STORAGE_KEY, "1");
    else forgetStored(STORAGE_KEY);
  },
  toggle(): void {
    focusMode.set(!on);
  },
};
