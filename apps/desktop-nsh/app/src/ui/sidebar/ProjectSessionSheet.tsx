/**
 * A project session (`ProjectSessionSheet.svelte`, ADR 0095), in one of two errands: `new` picks
 * the agent, then a directory to start in; `import` picks the agent, then a terminal session to
 * carry on, by the directory it ran in. Only Claude Code's terminal sessions can be carried on so
 * far (ADR 0099): the import sheet offers the agents that can. Mounted only while open, so a fresh
 * mount is the reset.
 *
 * Props: `mode` (default `new`), `agent` (the one it opens on: the one whose "new" was chosen),
 * `onClose`. The directories are `ProjectDirPicker`'s, held until the listing is in: the terminal's
 * directories would otherwise land above the app's under your pointer.
 */
import { signal, Text, untracked, View } from "nsh";
import { PROJECT_AGENT_CAPS, type ClaudeCodeSessionListing, type ProjectAgent } from "@real-bot/protocol";
import { PROJECT_AGENTS } from "../../m/sidebar/project-groups";
import { copy, runtime } from "../../runtime";
import { Modal, narrowWindow } from "../Modal";
import { AgentLogo } from "../settings/AgentLogo";
import { FieldError, FieldHint } from "../settings/provider-fields";
import { ProjectDirPicker } from "./ProjectDirPicker";

export function ProjectSessionSheet(props: { mode?: "new" | "import"; agent?: ProjectAgent; onClose: () => void }) {
  const t = () => copy();
  const mode = () => props.mode ?? "new";
  const agents = () => PROJECT_AGENTS.filter((each) => mode() === "new" || PROJECT_AGENT_CAPS[each].importable);
  const agent = signal<ProjectAgent>(
    untracked(() => {
      const opened = props.agent ?? "claude_code";
      return agents().includes(opened) ? opened : agents()[0]!;
    }),
  );
  /** The terminal sessions, read once; enough of them that a directory from last week still shows. */
  const items = signal<ClaudeCodeSessionListing[] | null>(null);
  const loadFailed = signal(false);

  const client = runtime.client;
  if (!client) loadFailed.set(true);
  else {
    void (async () => {
      try {
        items.set(await client.claudeCodeSessions(120));
      } catch {
        // The phone, or a daemon older than ADR 0095: it has no list to give.
        loadFailed.set(true);
      }
    })();
  }

  return (
    <Modal
      testID="project-session-sheet"
      title={mode() === "import" ? t().project.importTitle : t().project.newTitle}
      closeLabel={t().common.close}
      backLabel={t().common.back}
      pageOnPhone
      width={560}
      maxHeight={0.88}
      onClose={props.onClose}
      bodyClass={narrowWindow() ? "px-4 py-[18px] gap-4" : "px-6 py-5 gap-4"}
    >
      <View testID="project-agents" class="flex-col gap-1">
        <Text class={`${narrowWindow() ? "text-[14px]" : "text-[13px]"} font-semibold text-ink-secondary mb-[2px]`}>{t().project.agentHead}</Text>
        <View role="radiogroup" accessibilityLabel={t().project.agentHead} class="flex-row flex-wrap gap-2">
          <Each of={agents()} key={(each) => each}>
            {(each) => (
              <View
                role="radio"
                testID={`project-agent-${each()}`}
                accessibilityLabel={t().project.agentNames[each()]}
                accessibilityState={{ checked: agent() === each() }}
                onPress={() => agent.set(each())}
                class={`flex-row items-center gap-2 border rounded-(--radius-md) pl-2 pr-[14px] py-[6px] hover:bg-row-hover ${narrowWindow() ? "min-h-[44px]" : "min-h-[40px]"} ${agent() === each() ? "border-brand bg-accent-tint" : "border-line bg-pane"}`}
              >
                <AgentLogo runner={each()} size={20} />
                <Text class="text-[13px] font-semibold text-ink">{t().project.agentNames[each()]}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
      <View class="flex-col gap-2 pt-[14px] border-t border-line">
        <Text class={`${narrowWindow() ? "text-[14px]" : "text-[13px]"} font-semibold text-ink-secondary`}>{t().project.dirsHead}</Text>
        <If
          when={loadFailed()}
          else={
            <If when={!items()}>
              <FieldHint testID="import-loading">{t().sidebar.importClaudeLoading}</FieldHint>
            </If>
          }
        >
          <FieldError testID="import-failed">{t().sidebar.importClaudeFailed}</FieldError>
        </If>
        <If when={items() || loadFailed()}>
          {/* Keyed on the agent: another agent is a fresh picker. */}
          <Each of={[agent()]} key={(each) => each}>
            {(each) => <ProjectDirPicker agent={each()} mode={mode()} items={items()} sessions={runtime.snapshot.sessions} />}
          </Each>
        </If>
      </View>
    </Modal>
  );
}
