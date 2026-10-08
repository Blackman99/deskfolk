import type { Message } from "./messages.ts";

export const LOCAL_API_BIND = "127.0.0.1:17890" as const;
export const LOCAL_API_HOST = "127.0.0.1" as const;
export const LOCAL_API_PORT = 17890 as const;
export const LOCAL_API_NAME = "real-bot" as const;
export const LOCAL_API_PREFIX = "/v1" as const;

export const KEYCHAIN_SERVICE = "com.real-bot.daemon" as const;
export const KEYCHAIN_NAME = "endpoint-api-key" as const;
export const KEYCHAIN_REF = "keychain:com.real-bot.daemon/endpoint-api-key" as const;

export function providerKeychainName(id: string): string {
  return `${KEYCHAIN_NAME}:${id}`;
}

export function providerKeychainRef(id: string): string {
  return `keychain:${KEYCHAIN_SERVICE}/${providerKeychainName(id)}`;
}

export const MCP_AUTH_KEYCHAIN_NAME = "mcp-auth" as const;

export function mcpAuthKeychainName(id: string): string {
  return `${MCP_AUTH_KEYCHAIN_NAME}:${id}`;
}

export type McpTransport = "stdio" | "http";

export type McpHeader = {
  name: string;
  value: string;
};

export const APP_SUPPORT_DIRNAME = "real-bot" as const;
export const LOCAL_API_DESCRIPTOR_NAME = "local-api.json" as const;
export const STATE_DB_NAME = "state.sqlite" as const;



export const USER_MEMBER = "user" as const;

/**
 * The one you↔Mac conversation that exists only to receive files sent over remote control.
 * Not a Bot: a file posted here is copied into `inbox/` and never starts a turn.
 */
export const FILE_DROP_SESSION_ID = "filedrop" as const;

/** Bot `update_profile` used to insert these; they are no longer shown. */
export function isHiddenTranscriptKind(kind: string): boolean {
  return kind === "profile_change";
}

/** Transcript body when a live turn is marked interrupted. Chinese in every locale. */
export const INTERRUPT_NOTE_BODY = "中断" as const;

export const UNREACHABLE_NOTE_BODIES = [
  "这一轮没写完：连不上端点",
  "This turn did not finish: Couldn't reach the endpoint",
] as const;

/** A turn that stopped on its own, in either locale: 「这一轮没写完：…」. */
const FAIL_NOTE = /^(?:这一轮没写完：|This turn did not finish:)/;

export function isInterruptNote(message: Pick<Message, "kind" | "body">): boolean {
  return message.kind === "system" && message.body === INTERRUPT_NOTE_BODY;
}

export function isUnreachableNote(message: Pick<Message, "kind" | "body">): boolean {
  return (
    message.kind === "system" &&
    (UNREACHABLE_NOTE_BODIES as readonly string[]).includes(message.body)
  );
}

export function isContinuableNote(message: Pick<Message, "kind" | "body">): boolean {
  return isInterruptNote(message) || (message.kind === "system" && FAIL_NOTE.test(message.body));
}

/** Encrypted Web Push body. Visible copy is fixed; never titles, filenames or Bot names. */
export const WEB_PUSH_PAYLOAD = { t: "pending" } as const;
export const WEB_PUSH_COPY = {
  zh: "Deskfolk 有待处理事项",
  en: "Deskfolk has pending items",
} as const;

export const REACTION_EMOJI = ["👍", "👀", "❤️", "❗"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
