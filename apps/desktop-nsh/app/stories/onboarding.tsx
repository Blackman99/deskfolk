/**
 * The first-run wizard on the fixture's runtime. Shell's `showOnboarding` is not here, so the story
 * is the caller: it mounts `Onboarding`, shows what `onDismiss` and `onHoldingChange` told it, and
 * has the buttons a test needs. The test VM has no network, so what a save wrote is read back
 * through `runtime.client` (`story-read` fills `api-state`) and put back by `story-restore`.
 */
import { effect, signal, Text, View } from "nsh";
import { copy, runtime } from "../src/runtime";
import { Onboarding } from "../src/ui/Onboarding";

type Baseline = { workspace: string; locale: string; provider: { id: string; name: string; base_url: string; models: string[]; default_model: string } | null };

function Btn(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.id} onPress={props.onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{props.label}</Text>
    </View>
  );
}

export default function OnboardingStory() {
  const shown = signal(true);
  const holding = signal(false);
  const dismissed = signal(0);
  const apiState = signal("");
  let baseline: Baseline | null = null;
  let seq = 0;

  const read = async () => {
    const api = runtime.client;
    if (!api) return;
    const fresh = await api.snapshot();
    const provider = fresh.providers[0] ?? null;
    baseline ??= {
      workspace: fresh.settings.workspace_path ?? "",
      locale: fresh.settings.locale,
      provider: provider ? { id: provider.id, name: provider.name, base_url: provider.base_url ?? "", models: provider.models.map((m) => (typeof m === "string" ? m : (m as { name: string }).name)), default_model: provider.default_model ?? "" } : null,
    };
    apiState.set(
      JSON.stringify({
        seq: (seq += 1),
        workspace: fresh.settings.workspace_path ?? "",
        providers: fresh.providers.map((p) => ({ name: p.name, url: p.base_url, models: p.models.length, default: p.default_model })),
        builtin: fresh.settings.builtin_models ?? null,
        bots: fresh.bots.length,
        groups: fresh.sessions.filter((s) => s.name).length,
      }),
    );
  };
  effect(() => {
    if (runtime.client && !baseline) void read();
  });

  const remount = () => {
    shown.set(false);
    setTimeout(() => shown.set(true), 0);
  };
  /**
   * Puts back what a save wrote, and the runtime's endpoint form with it. A settings write is an
   * event every window's runtime takes its endpoint form from, so nothing is written when nothing
   * changed.
   */
  const restore = async () => {
    const api = runtime.client;
    if (!api) return;
    const base = baseline;
    runtime.hosted = false;
    if (base) {
      const fresh = await api.snapshot();
      const now = fresh.providers[0];
      if ((fresh.settings.workspace_path ?? "") !== base.workspace) await runtime.patchSettings({ workspace_path: base.workspace });
      if (base.provider && now && (now.name !== base.provider.name || now.base_url !== base.provider.base_url || now.models.length !== base.provider.models.length || (now.default_model ?? "") !== base.provider.default_model)) {
        await runtime.patchProvider(base.provider.id, { name: base.provider.name, base_url: base.provider.base_url, api_key: "fixture-key", models: base.provider.models, default_model: base.provider.default_model });
      }
      runtime.workspacePath = base.workspace;
      if (base.provider) {
        runtime.endpointUrl = base.provider.base_url;
        runtime.endpointKey = "";
        runtime.endpointModelsText = base.provider.models.join("\n");
        runtime.endpointDefaultModel = base.provider.default_model;
      }
    }
    if (Object.values(((await api.snapshot()).settings.builtin_models ?? {}) as Record<string, unknown>).some((choice) => choice !== null)) await runtime.patchSettings({ builtin_models: { reader: null } });
    holding.set(false);
    await read();
    remount();
  };

  return (
    <View class="flex-1 min-h-0 bg-bg">
      <View class="flex-row flex-wrap items-center gap-2 p-2 border-b border-line">
        <Btn id="story-read" label="read" onPress={() => void read()} />
        <Btn id="story-restore" label="restore" onPress={() => void restore()} />
        <Btn id="story-remount" label="remount" onPress={remount} />
        <Btn
          id="story-hosted"
          label="hosted"
          onPress={() => {
            runtime.hosted = true;
            remount();
          }}
        />
        <Text testID="api-state" class="text-[10px] text-ink-muted">{apiState()}</Text>
        <Text testID="story-holding" class="text-[12px] text-ink-muted">{`holding:${holding()}`}</Text>
        <Text testID="story-dismissed" class="text-[12px] text-ink-muted">{`dismissed:${dismissed()}`}</Text>
        <Text testID="story-locale" class="text-[12px] text-ink-muted">{`locale:${copy() ? runtime.snapshot.settings.locale : ""}`}</Text>
      </View>
      <If when={shown()}>
        <Onboarding holding={holding()} onHoldingChange={(value) => holding.set(value)} onDismiss={() => dismissed.set(dismissed() + 1)} />
      </If>
    </View>
  );
}
