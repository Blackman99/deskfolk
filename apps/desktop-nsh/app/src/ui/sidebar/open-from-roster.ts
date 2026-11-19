/**
 * A row of the roster pressed. On the phone's page the conversation's address gets its entry
 * before the conversation shows (`entryFirst`, `platform/page-route.ts`), so the picture Chrome on
 * Android keeps of the roster's entry, shown under a back swipe, is the roster. A Bot↔Bot direct
 * opens its popup over the screen instead and has no address of its own, so it opens at once, as
 * everything does on the desktop. Of presses that come while an entry is on its way, the last
 * one opens.
 */
import { classifySession } from "../../m/sidebar/session-groups";
import { entryFirst } from "../../platform/page-route";
import { runtime } from "../../runtime";

let latest = 0;

export async function openFromRoster(id: string): Promise<void> {
  const press = ++latest;
  const session = runtime.snapshot.sessions.find((s) => s.id === id);
  const entry = session && classifySession(session) !== "bot-bot" ? entryFirst(id) : null;
  if (entry) {
    await entry;
    if (press !== latest) return;
  }
  await runtime.selectSession(id);
}
