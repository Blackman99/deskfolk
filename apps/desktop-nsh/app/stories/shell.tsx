/**
 * The whole window (`Shell`) on the runtime's own conversations, at whatever size the test opens
 * it. `shell-state` reads back what a test checks (the open conversation, which layers are up);
 * the buttons are the test's hands where a press in the shell is not enough (the test cannot
 * reach the network itself): `story-open-file` opens the file the tests seed outside the workspace
 * (`host.params.elsewhere`) in the preview. `--open-session <id>` opens that conversation, for
 * looking at one in a real window.
 */
import { effect, host, Text, View } from "nsh";
import { initialSession } from "../src/launch";
import { runtime } from "../src/runtime";
import { Button } from "../src/ui/Button";
import { Shell } from "../src/ui/shell/Shell";

/**
 * The shell past onboarding whatever the runtime says, so the story shows the window itself on any
 * runtime (the dev instance's wizard may be unfinished); onboarding has a story of its own.
 */
const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(runtime), "snapshot")!;
Object.defineProperty(runtime, "snapshot", {
  configurable: true,
  set: descriptor.set,
  get() {
    const snap = descriptor.get!.call(runtime);
    return snap.settings.wizard_complete ? snap : { ...snap, settings: { ...snap.settings, wizard_complete: true } };
  },
});

export default function ShellStory() {
  // `--open-session <id>` (the shell's development flag) opens that conversation once connected, as the app's own window does.
  let opened = false;
  effect(() => {
    if (opened || !initialSession || runtime.connection !== "connected") return;
    opened = true;
    void runtime.selectSession(initialSession);
  });
  const state = () =>
    [
      `selected:${runtime.selectedId ?? "-"}`,
      `settings:${runtime.settingsOpen ? 1 : 0}`,
      `workspace:${runtime.workspaceOpen ? 1 : 0}`,
      `trace:${runtime.traceOpen ? 1 : 0}`,
      `preview:${runtime.previewRelpath ? 1 : 0}`,
      `conn:${runtime.connection}`,
    ].join(" ");
  return (
    <View class="flex-1">
      <View class="flex-row items-center gap-2 px-2 py-1 bg-line-subtle">
        <Button variant="secondary" testID="story-settings" onPress={() => runtime.openSettings()}>
          settings
        </Button>
        <Button variant="secondary" testID="story-deselect" onPress={() => (runtime.selectedId = null)}>
          deselect
        </Button>
        <Button variant="secondary" testID="story-open-file" onPress={() => (runtime.previewRelpath = String((host.params as { elsewhere?: string }).elsewhere ?? ""))}>
          file
        </Button>
        <Text testID="shell-state" class="flex-1 text-[11px] text-ink-muted">
          {state()}
        </Text>
      </View>
      <View class="flex-1 min-h-0">
        <Shell />
      </View>
    </View>
  );
}
