/**
 * The skills this Bot shares with the others, and the ones shared with it (`SharedSkillsCard.svelte`,
 * ADR 0052). Shown only where sharing is available. A first press on Share only asks: a skill can
 * hold what the Bot learned about you (ADR 0021); an update shows the body it would share first.
 */
import { Scroll, Text, View, effect, signal } from "nsh";
import type { SharedSkill, Skill } from "@real-bot/protocol";
import { copy } from "../../runtime";
import { tip } from "../tip";
import { FIELD_ERROR, PANEL_CARD, PANEL_CARD_BODY, PANEL_CARD_HEAD, PANEL_CARD_TITLE, PANEL_SECTION } from "./panel-card";

/** The slice of the API this card uses (ADR 0052). */
export type SharedSkillsApi = {
  listSharedSkills: () => Promise<{ items: SharedSkill[]; available: boolean }>;
  shareSkill: (skillId: string) => Promise<SharedSkill>;
  setSharedSkillEnabled: (id: string, enabled: boolean) => Promise<SharedSkill>;
  unshareSkill: (id: string) => Promise<void>;
};

function Pill(props: { testID?: string; primary?: boolean; disabled?: boolean; onPress: () => void; children: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.children}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class="cursor-pointer select-none disabled:cursor-default group px-[10px] py-[2px] rounded-full border bg-pane hover:border-accent-border disabled:opacity-[0.6] border-line"
    >
      <Text class={`text-[12px] group-hover:text-brand ${props.primary ? "text-brand" : "text-ink-secondary"}`}>{props.children}</Text>
    </View>
  );
}

export function SharedSkillsCard(props: {
  api: SharedSkillsApi | null;
  botId: string;
  /** This Bot's own skills. */
  skills: readonly Skill[];
  /** Edge to edge under the skills list (ProfilePane on a wider window). */
  flush?: boolean;
}) {
  const shared = signal<SharedSkill[]>([]);
  const available = signal(false);
  const busy = signal<string | null>(null);
  /** A first press only asks. */
  const confirming = signal<string | null>(null);
  const failed = signal(false);
  /** The update waiting on you, with the body it would share. */
  const reviewing = signal<string | null>(null);

  async function load(): Promise<void> {
    const api = props.api;
    if (!api) return;
    try {
      const page = await api.listSharedSkills();
      shared.set(page.items);
      available.set(page.available);
    } catch {
      available.set(false);
    }
  }

  // Again whenever this Bot's skills change: an edit above may make a shared copy out of date.
  effect(() => {
    void props.botId;
    void props.skills.map((skill) => `${skill.id}:${skill.updated_at}`).join();
    void load();
  });

  const sharedBySource = () => new Map(shared().filter((row) => row.source_skill_id).map((row) => [row.source_skill_id!, row] as const));
  const fromOthers = () => shared().filter((row) => row.source_bot_id !== props.botId);

  async function act(key: string, run: () => Promise<unknown>): Promise<void> {
    if (busy()) return;
    busy.set(key);
    failed.set(false);
    try {
      await run();
      await load();
    } catch {
      failed.set(true);
    } finally {
      busy.set(null);
    }
  }
  const idle = () => busy() === null;
  const t = () => copy().sharedSkills;

  return (
    <If when={available()}>
      <View testID="shared-skills-card" class={props.flush ? `${PANEL_SECTION} border-t` : PANEL_CARD}>
        <View class={PANEL_CARD_HEAD}>
          <Text class={PANEL_CARD_TITLE}>{t().title}</Text>
        </View>
        <View class={`flex-col gap-3 ${PANEL_CARD_BODY}`}>
          <Text class="text-[12px] text-ink-muted">{t().hint}</Text>
          <If when={failed()}>
            <Text role="alert" testID="shared-skills-failed" class={FIELD_ERROR}>{t().failed}</Text>
          </If>
          <If when={props.skills.length > 0}>
            <View class="flex-col gap-[6px]" accessibilityLabel={t().ownTitle}>
              <Each of={props.skills} key={(skill) => skill.id}>
                {(skill) => {
                  const copyOf = () => sharedBySource().get(skill().id);
                  return (
                    <View testID={`shared-skill-${skill().id}`} class="flex-row flex-wrap items-center gap-x-2 gap-y-[6px] px-[10px] py-[7px] border border-line rounded-(--radius-md)">
                      <Text tooltip={tip(skill().name)} class="flex-1 min-w-[140px] text-[13px] text-ink line-clamp-1">{skill().name}</Text>
                      <If
                        when={copyOf()}
                        else={
                          <If
                            when={confirming() === skill().id}
                            else={
                              <Pill testID={`share-${skill().id}`} primary disabled={!idle()} onPress={() => confirming.set(skill().id)}>{t().share}</Pill>
                            }
                          >
                            <Text class="text-[11px] text-ink-muted">{t().confirmHint}</Text>
                            <Pill
                              testID={`share-confirm-${skill().id}`}
                              primary
                              disabled={!idle()}
                              onPress={() => {
                                confirming.set(null);
                                void act(skill().id, () => props.api!.shareSkill(skill().id));
                              }}
                            >
                              {t().confirm}
                            </Pill>
                            <Pill testID={`share-cancel-${skill().id}`} disabled={!idle()} onPress={() => confirming.set(null)}>{t().cancel}</Pill>
                          </If>
                        }
                      >
                        {(row) => (
                          <>
                            <Text class="text-[11px] text-ink-muted">
                              {row().enabled ? (row().source_changed ? t().changedSince : t().sharedState) : t().sharedOff}
                            </Text>
                            <If when={row().source_changed && reviewing() !== skill().id}>
                              <Pill testID={`share-update-${skill().id}`} disabled={!idle()} onPress={() => reviewing.set(skill().id)}>{t().update}</Pill>
                            </If>
                            <Pill
                              testID={`share-toggle-${skill().id}`}
                              disabled={!idle()}
                              onPress={() => void act(row().id, () => props.api!.setSharedSkillEnabled(row().id, !row().enabled))}
                            >
                              {row().enabled ? t().turnOff : t().turnOn}
                            </Pill>
                            <Pill testID={`share-unshare-${skill().id}`} disabled={!idle()} onPress={() => void act(row().id, () => props.api!.unshareSkill(row().id))}>
                              {t().unshare}
                            </Pill>
                            <If when={reviewing() === skill().id}>
                              <View testID={`share-review-${skill().id}`} class="basis-full flex-col gap-[6px]">
                                <Text class="text-[11px] text-ink-muted">{t().updateHint}</Text>
                                <Scroll class="max-h-[220px] px-[10px] py-2 border border-line rounded-(--radius-sm) bg-chip">
                                  <Text class="text-[12px] text-ink">{skill().body}</Text>
                                </Scroll>
                                <View class="flex-row gap-[6px]">
                                  <Pill
                                    testID={`share-update-confirm-${skill().id}`}
                                    primary
                                    disabled={!idle()}
                                    onPress={() => {
                                      reviewing.set(null);
                                      void act(skill().id, () => props.api!.shareSkill(skill().id));
                                    }}
                                  >
                                    {t().confirmUpdate}
                                  </Pill>
                                  <Pill testID={`share-update-cancel-${skill().id}`} disabled={!idle()} onPress={() => reviewing.set(null)}>{t().cancel}</Pill>
                                </View>
                              </View>
                            </If>
                          </>
                        )}
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>
          <If when={fromOthers().length > 0}>
            <Text class="text-[12px] font-semibold text-ink-secondary">{t().othersTitle}</Text>
            <View class="flex-col gap-[6px]">
              <Each of={fromOthers()} key={(row) => row.id}>
                {(row) => (
                  <View
                    testID={`shared-from-${row().id}`}
                    class={`flex-row flex-wrap items-center gap-x-2 gap-y-[6px] px-[10px] py-[7px] border border-line rounded-(--radius-md) ${row().enabled ? "" : "opacity-60"}`}
                  >
                    <Text tooltip={tip(row().description)} class="flex-1 min-w-[140px] text-[13px] text-ink line-clamp-1">{row().name}</Text>
                    <Text class="text-[11px] text-ink-muted">{row().source_bot_name ? t().from(row().source_bot_name!) : t().fromGone}</Text>
                    <Pill
                      testID={`shared-toggle-${row().id}`}
                      disabled={!idle()}
                      onPress={() => void act(row().id, () => props.api!.setSharedSkillEnabled(row().id, !row().enabled))}
                    >
                      {row().enabled ? t().turnOff : t().turnOn}
                    </Pill>
                    <Pill testID={`shared-unshare-${row().id}`} disabled={!idle()} onPress={() => void act(row().id, () => props.api!.unshareSkill(row().id))}>
                      {t().unshare}
                    </Pill>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </View>
    </If>
  );
}
