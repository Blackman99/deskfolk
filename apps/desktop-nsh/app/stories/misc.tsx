/**
 * Four loose parts of the messenger: the onboarding's language switch and team step, the routines'
 * calendar and the ⌘K search. Onboarding itself is a later job, so this story is the caller: the
 * card the switch sits in, the footer button that makes the team. One part shows at a time
 * (`story-show-<part>`). Data is made and read back through `runtime.client` from buttons
 * (`story-add-routine`, `story-read`, ...) because the test host has no network.
 */
import { Scroll, signal, Text, View } from "nsh";
import { copy, runtime } from "../src/runtime";
import { searchJump } from "../src/m/sidebar/search-jump.ts";
import { RoutineCalendar } from "../src/ui/calendar/RoutineCalendar";
import { LocaleSwitch } from "../src/ui/onboarding/LocaleSwitch";
import { TeamStep, type TeamStepApi } from "../src/ui/onboarding/TeamStep";
import { GlobalSearch } from "../src/ui/search/GlobalSearch";

const PARTS = ["locale", "team", "calendar", "search"] as const;
type Part = (typeof PARTS)[number];
const KEEP = ["Writer", "Editor"];

function Btn(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.id} accessibilityLabel={props.label} onPress={props.onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{props.label}</Text>
    </View>
  );
}

export default function Misc() {
  const part = signal<Part>("locale");
  const state = signal("");
  const count = signal(0);
  const ready = signal(false);
  const busy = signal(false);
  const done = signal(0);
  const picked = signal("");
  const searchOpen = signal(false);
  let team: TeamStepApi | null = null;
  const locale = () => (runtime.snapshot.settings.locale === "en" ? "en" : "zh");

  /** The search as a one-letter query leaves it on a long history: `count` message hits (`many-<i>`),
   * each with some Markdown in it, in a conversation that can be opened except for the first
   * `closed`, whose conversation is gone. */
  const openWithMany = (count: number, closed = 0) => {
    const session = runtime.snapshot.sessions[0];
    runtime.searchQuery = "a";
    runtime.searchError = false;
    runtime.searchLoading = false;
    runtime.searchHits = Array.from({ length: count }, (_, i) => ({
      kind: "message" as const,
      id: `many-${i}`,
      snippet: `Line ${i}: **a** summary with \`code\`, a [link](https://example.com) and enough words after it to fill two lines of the row`,
      session_id: i < closed ? "gone" : session?.id,
      session_title: session?.name ?? "Writer",
      parent_id: null,
    }));
    searchOpen.set(true);
  };

  /** What the runtime itself says (a fresh GET), for the test to read. */
  const read = async () => {
    const api = runtime.client;
    if (!api) return;
    const fresh = await api.snapshot();
    state.set(
      JSON.stringify({
        locale: fresh.settings.locale,
        bots: fresh.bots.map((bot) => bot.name),
        writer: fresh.bots.find((bot) => bot.name === "Writer")?.id ?? null,
        sessions: fresh.sessions.map((s) => s.name ?? "").filter(Boolean),
        routines: fresh.routines.map((r) => r.title),
      }),
    );
  };
  const addRoutine = async () => {
    const writer = runtime.snapshot.bots.find((bot) => bot.name === "Writer");
    if (!writer) return;
    await runtime.createRoutine({
      bot_id: writer.id,
      title: "Morning brief",
      instruction: "Summarize today's work",
      enabled: true,
      schedule: { kind: "daily", time: "23:59" },
    });
    await read();
  };
  const delRoutines = async () => {
    const api = runtime.client;
    if (!api) return;
    for (const routine of (await api.snapshot()).routines) await runtime.deleteRoutine(routine.id, routine.updated_at);
    await read();
  };
  const restoreLocale = async () => {
    await runtime.patchSettings({ locale: "zh" });
    await read();
  };
  /** Takes away what the team step made: every Bot but the fixture's, and the groups that held them. */
  const cleanTeam = async () => {
    const api = runtime.client;
    if (!api) return;
    const fresh = await api.snapshot();
    const extra = new Set(fresh.bots.filter((bot) => !KEEP.includes(bot.name)).map((bot) => bot.id));
    // The groups it made (a direct has no name); the fixture's own stays.
    for (const session of fresh.sessions) {
      if (session.name && session.name !== "周报小组") await api.deleteSession(session.id).catch(() => undefined);
    }
    for (const id of extra) await api.deleteBot(id).catch(() => undefined);
    await read();
  };

  return (
    <View class="flex-1 min-h-0 bg-bg">
      <View class="flex-row flex-wrap items-center gap-2 p-2 border-b border-line">
        <Each of={PARTS.slice()} key={(p) => p}>{(p) => <Btn id={`story-show-${p()}`} label={p()} onPress={() => part.set(p())} />}</Each>
        <Btn id="story-read" label="read" onPress={() => void read()} />
        <Text testID="api-state" class="text-[10px] text-ink-muted">{state()}</Text>
        <Text testID="story-locale" class="text-[12px] text-ink-muted">{`locale:${locale()}`}</Text>
      </View>

      <If when={part() === "locale"}>
        <View class="p-6">
          <View testID="story-card" class="w-[420px] h-[160px] p-6 bg-pane border border-line rounded-(--radius-lg)">
            <LocaleSwitch locale={locale()} />
            <Text class="text-[14px] text-ink">{copy().onboarding.welcome}</Text>
          </View>
          <Btn id="story-restore-locale" label="restore zh" onPress={() => void restoreLocale()} />
        </View>
      </If>

      <If when={part() === "team"}>
        <View class="flex-1 min-h-0">
          <View class="flex-row items-center gap-2 p-2">
            <Text testID="team-state" class="text-[12px] text-ink-muted">{`count:${count()} ready:${ready()} busy:${busy()} done:${done()}`}</Text>
            <Btn id="story-team-create" label="make team" onPress={() => void team?.create()} />
            <Btn id="story-team-clean" label="clean team" onPress={() => void cleanTeam()} />
          </View>
          <Scroll class="flex-1 min-h-0">
            <View class="p-6 w-[560px] self-center">
              <TeamStep
                base={{}}
                onCountChange={(n) => count.set(n)}
                onReadyChange={(r) => ready.set(r)}
                onBusyChange={(b) => busy.set(b)}
                onApi={(api) => (team = api)}
                onDone={() => done.set(done() + 1)}
              />
            </View>
          </Scroll>
        </View>
      </If>

      <If when={part() === "calendar"}>
        <View class="flex-1 min-h-0">
          <View class="flex-row items-center gap-2 p-2">
            <Btn id="story-add-routine" label="add routine" onPress={() => void addRoutine()} />
            <Btn id="story-del-routine" label="delete routines" onPress={() => void delRoutines()} />
          </View>
          <RoutineCalendar />
        </View>
      </If>

      <If when={part() === "search"}>
        <View class="p-4 gap-2">
          <Btn id="story-open-search" label="open search" onPress={() => searchOpen.set(true)} />
          <Btn id="story-open-many" label="open with 2000 hits" onPress={() => openWithMany(2000)} />
          <Btn id="story-open-many-closed" label="open with 2000 hits, the first 49 gone" onPress={() => openWithMany(2000, 49)} />
          <Text testID="story-picked" class="text-[12px] text-ink-muted">{`picked:${picked()}`}</Text>
          <If when={searchOpen()}>
            <GlobalSearch
              onClose={() => {
                searchOpen.set(false);
                runtime.closeSearch();
                picked.set(`${picked()}|closed`);
              }}
              onSelect={(hit) => {
                const jump = searchJump(hit, runtime.snapshot.sessions, runtime.snapshot.routines, runtime.snapshot.bots);
                picked.set(hit.kind === "file" ? `file:${hit.path}` : JSON.stringify(jump));
                searchOpen.set(false);
                runtime.closeSearch();
              }}
            />
          </If>
        </View>
      </If>
    </View>
  );
}
