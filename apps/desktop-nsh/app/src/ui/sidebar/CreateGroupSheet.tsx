/**
 * The new-group dialog (`CreateGroupSheet.svelte`): a name and the members, picked among the Bots
 * (their own avatar, or their letter on their own colour, in the list and in the chips). A desktop
 * dialog; a whole page on a phone. Mounted only while open, so a fresh mount is the reset.
 *
 * Props: `bots` (who can be a member), `onClose`. The group is made through `runtime.createGroup`,
 * which closes the sheet itself when it lands; a refusal is shown on its field, or on top.
 */
import { Image, signal, Text, View } from "nsh";
import type { Bot } from "@real-bot/protocol";
import { avatarSrc, botAvatarColor } from "../../m/avatar";
import type { NormalizedSelectOption, SelectOption } from "../../m/select-options";
import { mapCreateGroupError, planCreateGroup, type CreateGroupFieldErrors } from "../../m/panels/create-form";
import { rosterLetter } from "../../m/sidebar/roster-letter";
import { copy, runtime } from "../../runtime";
import { Modal, ModalAction, narrowWindow } from "../Modal";
import { MultiSelect } from "../MultiSelect";
import { Field, FieldError, TextField } from "../settings/provider-fields";
import { cssColor } from "../styles";

export function CreateGroupSheet(props: { bots: Bot[]; onClose: () => void }) {
  const t = () => copy();
  const name = signal("");
  const members = signal<string[]>([]);
  const errors = signal<CreateGroupFieldErrors>({});
  const failed = signal(false);

  const botsById = () => new Map(props.bots.map((bot) => [bot.id, bot] as const));
  const memberOptions = (): SelectOption[] => props.bots.map((bot) => ({ value: bot.id, label: bot.name, hint: bot.duties }));

  function onNameInput(value: string): void {
    name.set(value);
    if (errors().name) errors.set({ ...errors(), name: undefined });
    failed.set(false);
  }

  function onMembersChange(values: string[]): void {
    members.set(values);
    if (errors().members) errors.set({ ...errors(), members: undefined });
    failed.set(false);
  }

  async function save(): Promise<void> {
    failed.set(false);
    errors.set({});
    const plan = planCreateGroup({ name: name(), members: members() });
    if (!plan.ok) {
      errors.set(plan.errors);
      return;
    }
    const error = await runtime.createGroup(plan.body);
    if (!error) return;
    const mapped = mapCreateGroupError(error.status, error.message);
    if ("top" in mapped) failed.set(true);
    else errors.set(mapped);
  }

  /** The same avatar the roster, the transcript and the group panel draw. */
  const memberAvatar = (option: NormalizedSelectOption, where: "chip" | "option") => {
    const bot = () => botsById().get(option.value);
    const palette = botAvatarColor(option.value);
    const size = where === "chip" ? 17 : 22;
    const src = () => (bot() ? avatarSrc(bot()!.avatar) : null);
    return (
      <View
        accessible={false}
        class="items-center justify-center border rounded-full overflow-hidden"
        style={{ width: size, height: size, backgroundColor: cssColor(palette.bg), borderColor: cssColor(palette.border) }}
      >
        <If
          when={src()}
          else={
            <Text class="font-bold" style={{ fontSize: where === "chip" ? 10 : 11, color: cssColor(palette.text) }}>
              {rosterLetter(option.label)}
            </Text>
          }
        >
          {(uri) => <Image src={uri()} style={{ width: "100%", height: "100%", objectFit: "cover" }} accessible={false} />}
        </If>
      </View>
    );
  };

  return (
    <Modal
      testID="create-group-sheet"
      title={t().sidebar.addGroup}
      closeLabel={t().common.close}
      backLabel={t().common.back}
      pageOnPhone
      width={440}
      onClose={props.onClose}
      bodyClass={narrowWindow() ? "px-4 py-[18px] gap-4" : "px-6 py-5 gap-4"}
      foot={
        <>
          <ModalAction kind="primary" testID="group-save" onPress={() => void save()}>
            {t().sidebar.create}
          </ModalAction>
          <ModalAction testID="group-cancel" onPress={props.onClose}>
            {t().common.close}
          </ModalAction>
        </>
      }
    >
      <If when={failed()}>
        <FieldError testID="group-failed">{t().sidebar.saveFailed}</FieldError>
      </If>
      <Field label={t().sidebar.groupName}>
        <TextField testID="group-name" label={t().sidebar.groupName} value={name()} invalid={Boolean(errors().name)} onInput={onNameInput} onSubmit={() => void save()} />
        <If when={errors().name}>
          <FieldError testID="group-name-error">{t().sidebar.groupNameEmpty}</FieldError>
        </If>
      </Field>
      <Field label={t().sidebar.groupMembers}>
        <MultiSelect
          testID="group-members"
          values={members()}
          options={memberOptions()}
          placeholder={t().sidebar.groupMembersPlaceholder}
          searchPlaceholder={t().sidebar.groupMemberSearch}
          emptyLabel={t().sidebar.groupMemberNone}
          noMatchLabel={t().sidebar.groupMemberNoMatch}
          removeLabel={t().sidebar.groupMemberRemove}
          ariaLabel={t().sidebar.groupMembers}
          media={memberAvatar}
          error={Boolean(errors().members)}
          onChange={onMembersChange}
        />
        <If when={errors().members}>
          <FieldError testID="group-members-error">{t().sidebar.membersTooFew}</FieldError>
        </If>
      </Field>
    </Modal>
  );
}
