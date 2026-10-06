import { expect, test } from "bun:test";
import { Store } from "../store";
import { TABLE_NOTES } from "./catalog";
import { DENIED_TABLES, deniedTable } from "./guard";

test("every table the catalog describes, and every one it denies, is a table the store has", () => {
  const store = new Store();
  try {
    const tables = new Set(store.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map((row) => row.name));
    for (const name of Object.keys(TABLE_NOTES)) expect(tables.has(name)).toBe(true);
    for (const name of DENIED_TABLES) expect(tables.has(name)).toBe(true);
    // Remote access keeps its keys in remote_* tables; all of them are denied, and nothing described is.
    expect([...tables].filter((name) => name.startsWith("remote_")).length).toBeGreaterThan(3);
    for (const name of Object.keys(TABLE_NOTES)) expect(deniedTable(name)).toBe(false);
  } finally {
    store.close();
  }
});

/**
 * Tables Bots read as they are, with no line in the catalog. None holds a credential: endpoint and MCP
 * keys are in the keychain (settings keeps only a reference), MCP commands, args and urls are what
 * list_mcp_servers already shows, and the delivery tokens are the push queue's own leases.
 */
const READ_AS_THEY_ARE = [
  "allow_rules", "attachments", "external_jobs", "file_commits", "file_stages", "held_scopes", "inbox_items",
  "live_procs", "mcp_servers", "message_edits", "notification_counters", "notification_deliveries",
  "notification_delivery_items", "notification_policy", "notification_retention_notice", "notifications",
  "providers", "reactions", "request_meta", "requirement_exclusions", "requirement_mentions", "route_feedback",
  "route_learned", "route_learnings", "route_reviews", "session_notification_preferences", "settings",
  "user_quote_filings", "work_items",
];

test("every table is described, denied, or read as it is: a new one is decided before a Bot can read it", () => {
  const store = new Store();
  try {
    const names = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')").all().map((row) => row.name);
    const undecided = names.filter((name) => !deniedTable(name) && !(name in TABLE_NOTES) && !READ_AS_THEY_ARE.includes(name));
    expect(undecided).toEqual([]);
    for (const name of READ_AS_THEY_ARE) expect(names).toContain(name);
  } finally {
    store.close();
  }
});
