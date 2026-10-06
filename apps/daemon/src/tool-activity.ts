/**
 * What a watcher is told about a tool call as it starts, beyond its name: the few words that say
 * what it is about. A path for the file tools, the Bot or group a roster tool acts on, a skill's
 * name, a memory's subject. Never a body — a write's content, a message's text and a skill's
 * instructions stay in the turn's record — and nothing at all for a call whose arguments name no
 * subject (`send_message`, `ask_user`, the list tools without a filter).
 */
const TARGET_KEYS: Readonly<Record<string, readonly string[]>> = {
  read_file: ["path"],
  write_file: ["path"],
  delete_file: ["path"],
  list_dir: ["path"],
  list_annotations: ["path"],
  create_bot: ["name"],
  create_group: ["name"],
  create_direct: ["name"],
  add_member: ["name"],
  remove_member: ["name"],
  read_skill: ["name"],
  create_skill: ["name"],
  update_skill: ["name"],
  remember: ["subject"],
  forget: ["subject"],
  create_routine: ["title"],
  update_routine: ["title"],
  add_endpoint: ["name"],
  update_endpoint: ["name"],
  add_mcp_server: ["name"],
  update_mcp_server: ["name"],
  read_prompt: ["id"],
  edit_prompt: ["id"],
  reset_prompt: ["id"],
};

/** Long enough for a deep path; the view clips again to what fits. */
export const TARGET_MAX = 200;

export function toolTargetOf(name: string, args: Record<string, unknown>): string | undefined {
  for (const key of TARGET_KEYS[name] ?? []) {
    const value = args[key];
    if (typeof value !== "string") continue;
    const line = value.split("\n")[0]!.trim();
    if (!line) continue;
    if (line.length <= TARGET_MAX) return line;
    // A path is read from its end: the file name is the part that says which one.
    return key === "path" ? `…${line.slice(line.length - TARGET_MAX + 1)}` : `${line.slice(0, TARGET_MAX - 1)}…`;
  }
  return undefined;
}
