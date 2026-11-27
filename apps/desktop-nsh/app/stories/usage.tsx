/**
 * Usage: the rings, the one-line summary, the tab's board of bars, the phone's page of dials and
 * the floating widget, on agents the story answers for in place of the runtime's `/v1/usage`.
 * `staged` answers as a daemon still asking does: nothing for a moment (the placeholders), then
 * every account pending, Claude's answering first, Codex's own after it, Codex's second last behind
 * the numbers it already had.
 */
import { effect, signal, Text, View } from "nsh";
import type { UsageAccount, UsageAgent } from "@real-bot/protocol";
import { runtime } from "../src/runtime";
import { usageFeedOf } from "../src/m/usage/usage-feed.svelte.ts";
import { USAGE_WIDGET_DEFAULT, usageWidget } from "../src/m/usage/usage-widget.svelte.ts";
import { Button } from "../src/ui/Button";
import { narrowWindow } from "../src/ui/Modal";
import { UsageLine } from "../src/ui/usage/UsageLine";
import { UsagePage } from "../src/ui/usage/UsagePage";
import { UsageRing } from "../src/ui/usage/UsageRing";
import { UsageTab } from "../src/ui/usage/UsageTab";
import { UsageWidget } from "../src/ui/usage/UsageWidget";
import { paneResize } from "../src/ui/workbench/drag-settle";

const checked_at = "2026-10-10T08:00:00.000Z";
const inAnHour = () => new Date(Date.now() + 65 * 60_000).toISOString();

const account = (dir: string | null, email: string | null, plan: string, windows: Array<[number, string | null, number]>, patch: Partial<UsageAccount> = {}): UsageAccount => ({
  config_dir: dir,
  email,
  available: true,
  reason: null,
  plan,
  credits: null,
  checked_at,
  error: null,
  windows: windows.map(([minutes, model, percent]) => ({ minutes, model, percent, resets_at: percent < 50 ? inAnHour() : null })),
  ...patch,
});

const claude: UsageAgent = {
  runner: "claude_code",
  custom_id: null,
  label: "Claude Agent",
  today: { turns: 31, tokens: 1_234_567, estimated_usd: 0 },
  accounts: [account(null, "a@example.com", "max", [[300, null, 38], [10_080, null, 19], [10_080, "Opus", 45]])],
};
const codex: UsageAgent = {
  runner: "codex",
  custom_id: null,
  label: "Codex",
  today: { turns: 0, tokens: 0, estimated_usd: 0 },
  // Uneven on purpose: in one column each card keeps its own height, the short one's room never
  // lent to the tall one.
  accounts: [account(null, null, "plus", [[300, null, 92]]), account("/x/.codex-b", null, "plus", [[300, null, 10], [10_080, null, 61], [43_200, null, 27]])],
};
const grok: UsageAgent = { runner: "grok", custom_id: null, label: "Grok", today: { turns: 12, tokens: 340_000, estimated_usd: 0 }, accounts: [] };
const AGENTS = [claude, codex, grok];

/** When each account answers in the staged run, after its start: Claude's, then Codex's two. */
const STAGED_MS = { claude: 1200, codexOwn: 2000, codexB: 3200 } as const;
/** The first answer of the staged run comes this late: the board's placeholders show until then. */
const STAGED_FIRST_MS = 600;

/** An account still being asked: nothing yet, or (`kept`) the numbers it had. */
const pendingOf = (item: UsageAccount, kept: boolean): UsageAccount =>
  kept ? { ...item, pending: true } : { ...item, available: false, plan: null, windows: [], credits: null, checked_at: null, pending: true };

/** The agents as the staged run answers them `ms` after it started. */
function stagedAgents(ms: number): UsageAgent[] {
  const done = (item: UsageAccount, at: number, kept = false) => (ms >= at ? { ...item, pending: false } : pendingOf(item, kept));
  return [
    { ...claude, accounts: [done(claude.accounts[0]!, STAGED_MS.claude)] },
    { ...codex, accounts: [done(codex.accounts[0]!, STAGED_MS.codexOwn), done(codex.accounts[1]!, STAGED_MS.codexB, true)] },
    grok,
  ];
}

export default function Usage() {
  const none = signal(false);
  const ready = signal(false);
  /** When the staged run started; null for the plain answer. */
  let stagedAt: number | null = null;
  /** The next ask fails, as a runtime gone away would. */
  let failNext = false;
  const staged = () => {
    stagedAt = Date.now();
    const feed = usageFeedOf(runtime);
    feed.agents = null;
    const client = runtime.client;
    if (client) void feed.load(client as never, true);
  };
  const backs = signal(0);
  // The runtime's own answer is whatever this machine has: the story answers for it.
  effect(() => {
    const client = runtime.connection === "connected" ? runtime.client : null;
    if (!client) return;
    (client as unknown as { usage: (refresh?: boolean, quick?: boolean) => Promise<{ agents: UsageAgent[] }> }).usage = async (refresh, quick) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("down"), { status: 502 });
      }
      if (none()) return { agents: [] };
      if (stagedAt === null || !quick) return { agents: AGENTS };
      if (refresh) await new Promise((done) => setTimeout(done, STAGED_FIRST_MS));
      return { agents: stagedAgents(Date.now() - stagedAt) };
    };
    ready.set(true);
  });
  const state = () => {
    const place = usageWidget.place;
    return JSON.stringify({ dock: place.dock, left: place.dock === null ? Math.round(place.left * 100) : undefined, hidden: usageWidget.hidden, open: usageWidget.open });
  };
  return (
    <View class="flex-1 bg-bg">
      <If when={ready()}>
        <If
          when={narrowWindow()}
          else={
            <View class="flex-1 flex-row min-h-0">
              <View class="flex-1 min-w-0">
                <UsageTab />
              </View>
              <View class="w-[220px] gap-3 p-4 border-l border-line">
                <View class="flex-row gap-2 items-center">
                  <UsageRing percent={10} />
                  <UsageRing percent={80} />
                  <UsageRing percent={95} size={24} />
                </View>
                <UsageLine account={claude.accounts[0]!} />
                <UsageLine account={account(null, null, "", [], { available: false, reason: "signed_out" })} />
                <Button testID="show-widget" onPress={() => usageWidget.show()}>show</Button>
                <Button testID="place-free" onPress={() => usageWidget.move({ dock: null, left: 0.5, top: 0.4 })}>free</Button>
                <Button testID="place-default" onPress={() => usageWidget.move(USAGE_WIDGET_DEFAULT)}>default</Button>
                <Button
                  testID="no-agents"
                  onPress={() => {
                    none.set(true);
                    const client = runtime.client;
                    if (client) void usageFeedOf(runtime).load(client as never, true);
                  }}
                >
                  none
                </Button>
                <Button testID="staged" onPress={staged}>staged</Button>
                <Button
                  testID="fail-first"
                  onPress={() => {
                    failNext = true;
                    const feed = usageFeedOf(runtime);
                    feed.agents = null;
                    const client = runtime.client;
                    if (client) void feed.load(client as never, true);
                  }}
                >
                  fail
                </Button>
                {/* A divider in hand, as the workbench's sashes say it: the board is not among what waits for the release. */}
                <Button testID="resize-begin" onPress={() => paneResize.begin()}>hold</Button>
                <Button testID="resize-end" onPress={() => paneResize.end()}>release</Button>
              </View>
            </View>
          }
        >
          <UsagePage onBack={() => backs.update((n) => n + 1)} />
          <View class="absolute right-2 bottom-6">
            <Button testID="staged-phone" onPress={staged}>staged</Button>
          </View>
        </If>
        <UsageWidget />
      </If>
      <Text testID="widget-state" class="absolute left-2 bottom-1 text-[10px] text-ink-muted">{state()}</Text>
      <Text testID="backs" class="absolute right-2 bottom-1 text-[10px] text-ink-muted">{`back:${backs()}`}</Text>
    </View>
  );
}
