/**
 * The dialogs that create things from the sidebar: a new Bot, a new group, a new project session
 * (and carrying a terminal session on). The shell mounts them from the runtime's own flags
 * (`createBotOpen`, `createGroupOpen`, `createProjectOpen`), as `Shell.svelte` does; the buttons
 * here set them as the sidebar's menus do. `story-read` asks the runtime itself (a fresh GET of the
 * snapshot) what exists, so a test can see what a sheet created.
 */
import { Scroll, signal, Text, View } from "nsh";
import { runtime } from "../src/runtime";
import { CreateBotSheet } from "../src/ui/sidebar/CreateBotSheet";
import { CreateGroupSheet } from "../src/ui/sidebar/CreateGroupSheet";
import { ProjectSessionSheet } from "../src/ui/sidebar/ProjectSessionSheet";

function StoryButton(props: { id: string; label: string; onPress: () => void }) {
  return (
    <View role="button" testID={props.id} onPress={props.onPress} class="px-2 py-1 border border-line rounded-(--radius-sm)">
      <Text class="text-[12px] text-ink">{props.label}</Text>
    </View>
  );
}

export default function SidebarSheets() {
  const read = signal("");
  const refresh = async () => {
    const api = runtime.client;
    if (!api) return;
    const fresh = await api.snapshot();
    read.set(
      JSON.stringify({
        bots: fresh.bots.map((bot) => ({ name: bot.name, runner: bot.runner ?? "", duties: bot.duties, model: bot.model ?? "" })),
        groups: fresh.sessions.filter((s) => s.kind === "group").map((s) => s.name),
        projects: fresh.sessions.filter((s) => s.kind === "project").map((s) => ({ dir: s.project_dir, agent: s.project_agent ?? "claude_code" })),
      }),
    );
  };
  const visibleBots = () => runtime.snapshot.bots.filter((bot) => !bot.archived_at);

  return (
    <View class="flex-1 bg-pane">
      <View class="flex-row flex-wrap items-center gap-2 p-2 border-b border-line">
        <StoryButton id="story-open-bot" label="new bot" onPress={() => (runtime.createBotOpen = true)} />
        <StoryButton id="story-open-group" label="new group" onPress={() => (runtime.createGroupOpen = true)} />
        <StoryButton id="story-open-project" label="new project" onPress={() => runtime.openCreateProject("new", "claude_code")} />
        <StoryButton id="story-open-codex" label="new codex project" onPress={() => runtime.openCreateProject("new", "codex")} />
        <StoryButton id="story-open-import" label="carry on" onPress={() => runtime.openCreateProject("import", "claude_code")} />
        <StoryButton id="story-read" label="read" onPress={() => void refresh()} />
        <Text testID="story-open" class="text-[12px] text-ink-muted">
          {`open:${runtime.createBotOpen ? "bot," : ""}${runtime.createGroupOpen ? "group," : ""}${runtime.createProjectOpen ? "project" : ""}`}
        </Text>
      </View>
      <Scroll class="flex-1">
        <Text testID="story-state" class="p-2 text-[11px] text-ink-muted">{read()}</Text>
      </Scroll>
      <If when={runtime.createBotOpen}>
        <CreateBotSheet onClose={() => (runtime.createBotOpen = false)} />
      </If>
      <If when={runtime.createProjectOpen}>
        <ProjectSessionSheet mode={runtime.createProjectMode} agent={runtime.createProjectAgent} onClose={() => (runtime.createProjectOpen = false)} />
      </If>
      <If when={runtime.createGroupOpen}>
        <CreateGroupSheet bots={visibleBots()} onClose={() => (runtime.createGroupOpen = false)} />
      </If>
    </View>
  );
}
