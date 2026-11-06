/**
 * A Bot's change to your interface waiting on a card (ADR 0106, `InterfaceEditCard.svelte`): what it
 * changes, a way to try it here, and once allowed, its Undo.
 */
import { cleanup, effect, signal, Text, View } from "nsh";
import type { Approval, InterfaceRevisionHead } from "@real-bot/protocol";
import { parseInterfaceCard } from "../../m/chat/interface-card.ts";
import { interfaceController } from "../../m/interface/controller.svelte.ts";
import type { MessengerApi } from "../../m/messenger-api.ts";
import { copy } from "../../runtime";

function Link(props: { testID?: string; disabled?: boolean; onPress: () => void; children: string }) {
  return (
    <View role="button" testID={props.testID} disabled={props.disabled} onPress={props.onPress} class="disabled:opacity-[0.6]">
      <Text class="text-[12px] text-brand">{props.children}</Text>
    </View>
  );
}

export function InterfaceEditCard(props: {
  /** The card's text, as the daemon wrote it. */
  body: string;
  approval: Approval | null;
  api: MessengerApi | null;
  /** The newest changes (the snapshot's), to find the one this card let through. */
  recent: readonly InterfaceRevisionHead[];
}) {
  const c = () => copy().ui.card;
  const chip = () => copy().ui.chip;
  const card = () => parseInterfaceCard(props.body);
  const approvalId = () => props.approval?.id ?? null;
  const pending = () => props.approval?.status === "pending";
  const trying = () => approvalId() !== null && interfaceController.trying?.approvalId === approvalId();
  const canTry = () => pending() && (card().patch !== null || card().restore !== null);

  const cannotTry = signal(false);
  const undone = signal(false);
  const undoFailed = signal(false);
  const busy = signal(false);

  const head = () => {
    const id = approvalId();
    return id ? props.recent.find((row) => row.approval_id === id) : undefined;
  };

  async function tryHere(): Promise<void> {
    const id = approvalId();
    if (!id) return;
    cannotTry.set(false);
    const current = card();
    if (current.restore) {
      if (!props.api) {
        cannotTry.set(true);
        return;
      }
      try {
        const revision = await props.api.getInterfaceRevision(current.restore);
        interfaceController.tryProfile(id, revision.after.profile);
      } catch {
        cannotTry.set(true);
      }
      return;
    }
    if (current.patch && !interfaceController.tryPatch(id, current.patch)) cannotTry.set(true);
  }

  // Decided, or gone from the page: this window goes back to what it showed.
  effect(() => {
    if (!pending() && trying()) interfaceController.stopTrying();
  });
  cleanup(() => {
    const id = approvalId();
    if (id && interfaceController.trying?.approvalId === id) interfaceController.stopTrying();
  });

  async function undo(): Promise<void> {
    const found = head();
    if (!props.api || !found || busy()) return;
    busy.set(true);
    try {
      await props.api.undoInterfaceRevision(found.id);
      undone.set(true);
    } catch {
      undoFailed.set(true);
    } finally {
      busy.set(false);
    }
  }

  return (
    <View testID="interface-card" selectable class="min-w-0 gap-[6px]">
      <Text class="text-[13px] font-semibold text-ink">{c().head}</Text>
      <If when={card().reason}>
        <Text class="text-[12px] text-ink-secondary">{card().reason}</Text>
      </If>
      <If when={card().changes.length}>
        <View testID="interface-card-changes" class="border border-line rounded-(--radius-sm) pl-[6px] pr-[6px] py-[4px] gap-[1px]">
          <Each of={card().changes} key="index">
            {(change) => (
              <View class="flex-row gap-[6px]">
                <Text class="w-[14px] text-[12px] text-ink">{"•"}</Text>
                <Text class="flex-1 min-w-0 text-[12px] leading-[1.5] text-ink">{change()}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={canTry()}>
        <View class="flex-row flex-wrap items-baseline gap-x-[10px] gap-y-[4px] mt-[2px]">
          <If
            when={trying()}
            else={
              <Link testID="interface-try" onPress={() => void tryHere()}>
                {c().tryHere}
              </Link>
            }
          >
            <Text class="text-[12px] text-ink-secondary">{c().trying}</Text>
            <Link testID="interface-stop-trying" onPress={() => interfaceController.stopTrying()}>
              {c().stopTrying}
            </Link>
          </If>
          <If when={cannotTry()}>
            <Text testID="interface-cannot-try" class="text-[12px] text-ink-secondary">{c().cannotTry}</Text>
          </If>
        </View>
      </If>
      <If when={props.approval?.status === "allowed_once"}>
        <If
          when={undone()}
          else={
            <If
              when={undoFailed()}
              else={
                <If when={head()?.undoable}>
                  <View class="flex-row flex-wrap mt-[2px]">
                    <Link testID="interface-undo" disabled={busy()} onPress={() => void undo()}>
                      {chip().undo}
                    </Link>
                  </View>
                </If>
              }
            >
              <Text class="text-[12px] text-ink-secondary">{chip().cannotUndo}</Text>
            </If>
          }
        >
          <Text class="text-[12px] text-ink-secondary">{chip().undone}</Text>
        </If>
      </If>
    </View>
  );
}
