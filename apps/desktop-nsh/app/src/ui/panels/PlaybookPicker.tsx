/**
 * The engine a conversation runs (ADR 0085): one of the engines, or follow the default
 * (`PlaybookPicker.svelte`). A row of a group's actions, or of a Bot's actions in your direct; the
 * engines themselves are on Roles. Not shown where the Mac has no engines yet.
 */
import { Text, View, effect, signal } from "nsh";
import { playbookName, Playbooks } from "../../m/settings/playbooks.svelte";
import { copy, runtime } from "../../runtime";
import { Select } from "../Select";
import { DangerDialog } from "../overlays/DangerDialog";
import { FIELD_ERROR } from "./panel-card";

export function PlaybookPicker(props: { sessionId: string }) {
  const c = () => copy().playbooks;
  const playbooks = new Playbooks(() => runtime.client);
  effect(() => {
    void runtime.client;
    void runtime.playbooksRevision;
    void playbooks.load();
  });

  const chosen = () => runtime.snapshot.sessions.find((session) => session.id === props.sessionId)?.playbook_id ?? null;
  const defaultName = () => playbookName(playbooks.find(playbooks.defaultId), c().builtin);
  const options = () => [
    { value: "", label: c().followDefault(defaultName()) },
    ...playbooks.items.map((item) => ({ value: item.id, label: playbookName(item, c().builtin) })),
  ];
  const failed = signal(false);
  /** Moving a conversation with open jobs to an engine with none leaves them where they are: said first (ADR 0103). */
  const moving = signal<{ value: string; jobs: number } | null>(null);
  /** A Select shows what you picked at once: a move you called off, or that failed, puts it back. */
  const shown = signal<string | null>(null);

  async function choose(value: string): Promise<void> {
    shown.set(value);
    const impact = await playbooks.impactOf(value || playbooks.defaultId, props.sessionId);
    if (impact && impact.open_jobs > 0) moving.set({ value, jobs: impact.open_jobs });
    else await move(value);
  }

  function confirmMove(): void {
    const target = moving();
    moving.set(null);
    if (target) void move(target.value);
  }

  async function move(value: string): Promise<void> {
    const api = runtime.client;
    if (!api) return;
    failed.set(false);
    try {
      await api.setSessionPlaybook(props.sessionId, value || null);
      shown.set(null);
    } catch {
      failed.set(true);
      shown.set(null);
    }
  }

  return (
    <>
      <If when={moving()}>
        {(target) => (
          <DangerDialog
            copy={{ title: c().moveTitle, body: c().moveBody(target().jobs), confirm: c().moveConfirm, cancel: c().cancel }}
            onDismiss={() => {
              moving.set(null);
              shown.set(null);
            }}
            onConfirm={confirmMove}
          />
        )}
      </If>
      <If when={playbooks.list}>
        <View testID="playbook-picker" class="flex-row items-center justify-between gap-[14px]">
          <View class="flex-1 min-w-0 gap-[2px]">
            <Text class="text-[13px] font-semibold text-ink">{c().label}</Text>
            <Text class="text-[12px] text-ink-muted">{c().pickerHint}</Text>
            <If when={failed()}>
              <Text role="alert" testID="playbook-failed" class={FIELD_ERROR}>{c().failed}</Text>
            </If>
          </View>
          <View class="w-[148px] shrink-0">
            <Select
              testID="playbook-select"
              value={shown() ?? chosen() ?? ""}
              options={options()}
              size="sm"
              ariaLabel={c().label}
              onChange={(value) => void choose(value)}
            />
          </View>
        </View>
      </If>
    </>
  );
}
