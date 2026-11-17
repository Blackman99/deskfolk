/**
 * A project session (`ProjectSessionSheet.svelte`, ADR 0095), in one of two errands: `new` picks
 * the agent, then a directory to start in; `import` picks the agent, then a terminal session to
 * carry on, by the directory it ran in. The import sheet offers the agents whose terminal sessions
 * can be carried on (`PROJECT_AGENT_CAPS`). Mounted only while open, so a fresh mount is the reset.
 *
 * Props: `mode` (default `new`), `agent` (the one it opens on: the one whose "new" was chosen),
 * `onClose`. The directories are `ProjectDirPicker`'s, held until the listing is in: the terminal's
 * directories would otherwise land above the app's under your pointer.
 */
import { computed, signal, Text, untracked, View } from "nsh";
import { PROJECT_AGENT_CAPS, type ProjectAgent } from "@real-bot/protocol";
import { loadAgentSessions, type ImportListing } from "../../m/sidebar/import-claude-session";
import { PROJECT_AGENTS } from "../../m/sidebar/project-groups";
import { copy, runtime } from "../../runtime";
import { Modal, narrowWindow } from "../Modal";
import { FieldError, FieldHint } from "../settings/provider-fields";
import { ProjectAgentTiles } from "./ProjectAgentTiles";
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
  /**
   * Each agent's terminal sessions, read once and side by side (another agent's are asked of the
   * agent itself, which takes a moment); enough of them that a directory from last week still
   * shows. Every agent's place the folders; the picked agent's are listed under them.
   */
  const importable = PROJECT_AGENTS.filter((each) => PROJECT_AGENT_CAPS[each].importable);
  const lists = signal<Partial<Record<ProjectAgent, ImportListing[]>>>({});
  const failed = signal<Partial<Record<ProjectAgent, boolean>>>({});
  /** Held until the picked agent's list is in (or could not be had); the others join as they come. */
  const items = computed<ImportListing[] | null>(() =>
    lists()[agent()] || failed()[agent()] || !importable.includes(agent()) ? Object.values(lists()).flat() : null,
  );
  const loadFailed = () => failed()[agent()] === true;

  const client = runtime.client;
  for (const each of importable) {
    if (!client) {
      failed.set({ ...failed(), [each]: true });
      continue;
    }
    loadAgentSessions(client, each, 120).then(
      (listed) => lists.set({ ...lists(), [each]: listed }),
      // The phone, or a daemon older than this agent's list: it has none to give.
      () => failed.set({ ...failed(), [each]: true }),
    );
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
        <ProjectAgentTiles agents={agents()} agent={agent()} onPick={(each) => agent.set(each)} />
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
