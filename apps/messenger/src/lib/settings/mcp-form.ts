export type McpTransportKind = "stdio" | "http";

export type McpDraft = {
  name: string;
  transport: McpTransportKind;
  command: string;
  args: string;
  url: string;
  headers: string;
  auth: string;
  enabled: boolean;
  /** Roster-level note for every Bot: what this server is for, when to use it, when not to. */
  usageNote: string;
};

export type McpFieldErrors = {
  name?: "empty";
  command?: "empty";
  url?: "empty" | "invalid";
};

export type CreateMcpBody = {
  name: string;
  transport: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Array<{ name: string; value: string }>;
  auth?: string;
  enabled: boolean;
  usage_note?: string;
};

export type McpPatchBody = {
  name?: string;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Array<{ name: string; value: string }>;
  auth?: string;
  enabled?: boolean;
  /** `null` clears the note. Never needs the connection confirm step. */
  usage_note?: string | null;
};

export type McpAddPlan =
  | { ok: false; errors: McpFieldErrors }
  | { ok: true; phase: "confirm" }
  | { ok: true; phase: "submit"; body: CreateMcpBody };

export type McpSavePlan =
  | { ok: false; errors: McpFieldErrors }
  | { ok: true; phase: "confirm" }
  | { ok: true; phase: "submit"; patch: McpPatchBody };

export function parseMcpArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

export function formatMcpArgs(args: readonly string[]): string {
  return args.join(" ");
}

export function parseMcpHeaders(raw: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (name.toLowerCase() === "authorization") continue;
    out.push({ name, value });
  }
  return out;
}

export function formatMcpHeaders(headers: readonly { name: string; value: string }[]): string {
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
}

function looksLikeUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function planMcpDraft(draft: McpDraft): { ok: true; body: CreateMcpBody } | { ok: false; errors: McpFieldErrors } {
  const errors: McpFieldErrors = {};
  const name = draft.name.trim();
  const transport = draft.transport === "http" ? "http" : "stdio";
  const usageNote = (draft.usageNote ?? "").trim();
  const note = usageNote ? { usage_note: usageNote } : {};
  if (name.length === 0) errors.name = "empty";
  if (transport === "http") {
    const url = (draft.url ?? "").trim();
    if (url.length === 0) errors.url = "empty";
    else if (!looksLikeUrl(url)) errors.url = "invalid";
    if (errors.name || errors.url) return { ok: false, errors };
    const auth = (draft.auth ?? "").trim();
    return {
      ok: true,
      body: {
        name,
        transport,
        url,
        headers: parseMcpHeaders(draft.headers ?? ""),
        ...(auth ? { auth } : {}),
        enabled: draft.enabled ?? true,
        ...note,
      },
    };
  }
  const command = draft.command.trim();
  if (command.length === 0) errors.command = "empty";
  if (errors.name || errors.command) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      transport,
      command,
      args: parseMcpArgs(draft.args),
      enabled: draft.enabled ?? true,
      ...note,
    },
  };
}

export function requestMcpAdd(phase: "edit" | "confirm", draft: McpDraft): McpAddPlan {
  const plan = planMcpDraft(draft);
  if (!plan.ok) return plan;
  if (phase === "edit") return { ok: true, phase: "confirm" };
  return { ok: true, phase: "submit", body: plan.body };
}

export function requestMcpSave(
  phase: "edit" | "confirm",
  current: {
    name: string;
    transport?: McpTransportKind;
    command: string;
    args: readonly string[];
    url?: string | null;
    headers?: readonly { name: string; value: string }[];
    usage_note?: string | null;
  },
  draft: McpDraft,
): McpSavePlan {
  const plan = planMcpDraft(draft);
  if (!plan.ok) return plan;
  const patch: McpPatchBody = {};
  if (plan.body.name !== current.name) patch.name = plan.body.name;
  const nextNote = plan.body.usage_note ?? null;
  if (nextNote !== (current.usage_note ?? null)) patch.usage_note = nextNote;
  if (plan.body.transport !== current.transport) patch.transport = plan.body.transport;
  if (plan.body.transport === "stdio") {
    if ((plan.body.command ?? "") !== current.command) patch.command = plan.body.command;
    if (!sameArgs(plan.body.args ?? [], current.args)) patch.args = plan.body.args;
  } else {
    if ((plan.body.url ?? "") !== (current.url ?? "")) patch.url = plan.body.url;
    if (!sameHeaders(plan.body.headers ?? [], current.headers ?? [])) patch.headers = plan.body.headers;
    if (plan.body.auth) patch.auth = plan.body.auth;
  }
  if (Object.keys(patch).length === 0) return { ok: true, phase: "submit", patch };
  const needsConfirm =
    patch.command !== undefined ||
    patch.args !== undefined ||
    patch.url !== undefined ||
    patch.headers !== undefined ||
    patch.transport !== undefined ||
    patch.auth !== undefined;
  if (phase === "edit" && needsConfirm) {
    return { ok: true, phase: "confirm" };
  }
  return { ok: true, phase: "submit", patch };
}

export function mapMcpError(message: string): McpFieldErrors | { top: true } {
  if (message === "name is required") return { name: "empty" };
  if (message === "command is required") return { command: "empty" };
  if (message === "url is required") return { url: "empty" };
  if (message === "url must be an http or https URL") return { url: "invalid" };
  return { top: true };
}

function sameHeaders(
  a: readonly { name: string; value: string }[],
  b: readonly { name: string; value: string }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.name === b[i]?.name && row.value === b[i]?.value);
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}
