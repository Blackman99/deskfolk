import { CONSULT_MEMBERS_MAX, type ConsultMember, type ProjectConsultSetting } from "@real-bot/protocol";

/**
 * The composer's consultant switch (ADR 0116 addendum 2026-11-23): what the next setting is after
 * a press, so the menu only sends it. The rules: at most `CONSULT_MEMBERS_MAX` members, the same
 * agent on the same account, model and level only once (on another account or model it is another
 * consultant), the first member turns the switch on, the last one removed turns it off, and with
 * no members it cannot be on. Off keeps the members for the next time.
 */
const NONE: ProjectConsultSetting = { on: false, members: [] };

export function sameMember(a: ConsultMember, b: ConsultMember): boolean {
  return a.agent === b.agent && (a.config_dir ?? null) === (b.config_dir ?? null) && a.model === b.model && a.effort === b.effort;
}

/** Whether another one can be added: under the most, and not already there. */
export function canAddMember(now: ProjectConsultSetting | null | undefined, member: ConsultMember): boolean {
  const members = (now ?? NONE).members;
  return members.length < CONSULT_MEMBERS_MAX && !members.some((have) => sameMember(have, member));
}

/** The setting with `member` added, on; the same setting when it cannot be added. */
export function withMember(now: ProjectConsultSetting | null | undefined, member: ConsultMember): ProjectConsultSetting {
  const setting = now ?? NONE;
  if (!canAddMember(setting, member)) return setting;
  return { on: true, members: [...setting.members, member] };
}

/** The setting without the member at `index`; off when none is left. */
export function withoutMember(now: ProjectConsultSetting | null | undefined, index: number): ProjectConsultSetting {
  const setting = now ?? NONE;
  if (index < 0 || index >= setting.members.length) return setting;
  const members = setting.members.filter((_, at) => at !== index);
  return { on: setting.on && members.length > 0, members };
}

/** The switch pressed: it goes on only with members to ask. */
export function withSwitch(now: ProjectConsultSetting | null | undefined, on: boolean): ProjectConsultSetting {
  const setting = now ?? NONE;
  return { on: on && setting.members.length > 0, members: setting.members };
}
