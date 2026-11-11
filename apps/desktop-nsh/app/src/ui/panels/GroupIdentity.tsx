/**
 * A group's identity in the settings head (`GroupIdentity.svelte`): its avatar, its name as an
 * editable title (saved when you leave the field or press Enter, and on closing), and who is in it.
 */
import { Input } from "nsh/base";
import { Text, View, cleanup, effect, signal, untracked, type InputRef } from "nsh";
import type { SessionSummary } from "@real-bot/protocol";
import { presentBotIds } from "../../m/sidebar/session-groups";
import { botWorkStatus } from "../../m/sidebar/session-status";
import { groupNameCommit, mapGroupEditError, type GroupDetailDraft } from "../../m/panels/group-edit";
import { copy, runtime } from "../../runtime";
import { SessionAvatar } from "../SessionAvatar";
import { FIELD_ERROR } from "./panel-card";

export function GroupIdentity(props: {
  session: SessionSummary;
  /** The shell's draft; changes go out through `onDetailChange` (the Svelte `bind:detail`). */
  detail: GroupDetailDraft;
  onDetailChange: (detail: GroupDetailDraft) => void;
}) {
  const botsById = () => new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot] as const));
  const present = () => presentBotIds(props.session);
  const statusLabels = () => {
    const t = copy().sidebar;
    return {
      running: t.statusRunning,
      replying: t.statusReplying,
      waitingApproval: t.statusWaitingApproval,
      waitingAsk: t.statusWaitingAsk,
      failed: t.statusFailed,
      interrupted: t.statusInterrupted,
      idle: t.statusIdle,
    };
  };
  const botStatusOf = (botId: string) =>
    botWorkStatus(botId, runtime.snapshot.turns, runtime.snapshot.approvals, statusLabels(), runtime.snapshot.pendingJudgements);

  // The last name the server has, so leaving the field does not send a name that is already saved.
  let savedName = untracked(() => (props.session.name ?? "").trim());
  let seenSession: string | null = null;
  let nameSaving = false;
  let nameSaveQueued = false;
  const nameFailed = signal(false);
  let mounted = true;
  let field: InputRef | null = null;

  const patch = (change: Partial<GroupDetailDraft>) => props.onDetailChange({ ...props.detail, ...change });

  effect(() => {
    const id = props.session.id;
    const next = (props.session.name ?? "").trim();
    if (seenSession === id) return;
    seenSession = id;
    savedName = next;
    nameFailed.set(false);
  });

  // Closing the panel unmounts this field; a name still being typed goes out with it.
  cleanup(() => {
    mounted = false;
    void commitGroupName();
  });

  async function commitGroupName(): Promise<void> {
    if (props.session.kind !== "group") return;
    if (nameSaving) {
      nameSaveQueued = true;
      return;
    }
    const sessionId = props.session.id;
    const decision = groupNameCommit(props.detail.name, savedName);
    if (decision.action === "invalid") {
      if (mounted && props.detail.sessionId === sessionId) patch({ nameError: "empty" });
      return;
    }
    if (decision.action === "noop") {
      if (mounted && props.detail.sessionId === sessionId) patch({ name: savedName, nameError: undefined });
      return;
    }
    const sent = decision.name;
    nameSaving = true;
    if (mounted) {
      patch({ nameError: undefined });
      nameFailed.set(false);
    }
    const error = await runtime.patchSession(sessionId, { name: sent });
    nameSaving = false;
    if (!error) {
      savedName = sent;
      if (props.detail.sessionId === sessionId) patch({ name: sent });
    } else if (mounted && props.detail.sessionId === sessionId) {
      const mapped = mapGroupEditError(error.message);
      if ("name" in mapped) patch({ nameError: mapped.name });
      else nameFailed.set(true);
    }
    if (nameSaveQueued) {
      nameSaveQueued = false;
      void commitGroupName();
    }
  }

  return (
    <View testID="group-identity" class="flex-row items-center gap-3 flex-1 min-w-0">
      <View accessible={false} class="w-[36px] h-[36px] shrink-0 items-center justify-center">
        <SessionAvatar session={props.session} bots={botsById()} size="top" botStatus={botStatusOf} />
      </View>
      <View class="flex-1 min-w-0 gap-[1px]">
        <Input
          ref={(node) => (field = node)}
          testID="detail-group-name"
          accessibilityLabel={copy().sidebar.groupName}
          autoCorrect={false}
          value={props.detail.name}
          placeholder={copy().sidebar.groupName}
          onChange={(e) => {
            nameFailed.set(false);
            props.onDetailChange({ ...props.detail, name: e.value, nameError: undefined });
          }}
          onBlur={() => void commitGroupName()}
          onSubmit={() => {
            void commitGroupName();
            field?.blur();
          }}
          class="w-full min-w-0 px-1 py-[1px] rounded-(--radius-sm) border border-transparent bg-transparent text-ink text-[15px] font-bold hover:border-line hover:bg-input-bg focus:border-brand focus:bg-input-bg"
        />
        <If when={props.detail.nameError}>
          <Text testID="group-name-error" class={FIELD_ERROR}>{copy().sidebar.groupNameEmpty}</Text>
        </If>
        <If when={!props.detail.nameError && nameFailed()}>
          <Text testID="group-name-error" class={FIELD_ERROR}>{copy().detail.saveFailed}</Text>
        </If>
        <View class="flex-row items-center gap-[6px] min-w-0 pl-1">
          <Text testID="group-member-count" class="text-[12px] font-medium text-ink-muted">{`${present().length + 1} ${copy().detail.members}`}</Text>
          <If when={props.session.archived_at}>
            <View class="px-[6px] py-[1px] rounded-full bg-warn-bg border border-warn-line">
              <Text class="text-[11px] font-semibold text-warn-text">{copy().top.archived}</Text>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}
