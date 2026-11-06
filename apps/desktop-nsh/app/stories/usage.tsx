/**
 * Usage: the rings, the one-line summary, the tab's board of bars, the phone's page of dials and
 * the floating widget, on agents the story answers for in place of the runtime's `/v1/usage`.
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
  accounts: [account(null, null, "plus", [[300, null, 92]]), account("/x/.codex-b", null, "plus", [[300, null, 10]])],
};
const grok: UsageAgent = { runner: "grok", custom_id: null, label: "Grok", today: { turns: 12, tokens: 340_000, estimated_usd: 0 }, accounts: [] };
const AGENTS = [claude, codex, grok];

export default function Usage() {
  const none = signal(false);
  const ready = signal(false);
  const backs = signal(0);
  // The runtime's own answer is whatever this machine has: the story answers for it.
  effect(() => {
    const client = runtime.connection === "connected" ? runtime.client : null;
    if (!client) return;
    (client as unknown as { usage: () => Promise<{ agents: UsageAgent[] }> }).usage = async () => ({ agents: none() ? [] : AGENTS });
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
              </View>
            </View>
          }
        >
          <UsagePage onBack={() => backs.update((n) => n + 1)} />
        </If>
        <UsageWidget />
      </If>
      <Text testID="widget-state" class="absolute left-2 bottom-1 text-[10px] text-ink-muted">{state()}</Text>
      <Text testID="backs" class="absolute right-2 bottom-1 text-[10px] text-ink-muted">{`back:${backs()}`}</Text>
    </View>
  );
}
