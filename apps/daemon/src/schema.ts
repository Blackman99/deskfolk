export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS remote_host (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  host_id TEXT NOT NULL, relay_origin TEXT NOT NULL, relay_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0)
);
CREATE TABLE IF NOT EXISTS remote_devices (
  device_id TEXT PRIMARY KEY, name TEXT NOT NULL, ua_hint TEXT NOT NULL,
  dh_pk TEXT NOT NULL UNIQUE, signing_pk TEXT NOT NULL UNIQUE, enrollment_pk TEXT NOT NULL UNIQUE,
  grant_epoch INTEGER NOT NULL, generation INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0, relay_pending INTEGER NOT NULL DEFAULT 1,
  pairing_id TEXT NOT NULL UNIQUE, onboarding_until INTEGER NOT NULL,
  onboarding_session TEXT, credential_id TEXT, cose_key TEXT, sign_count INTEGER NOT NULL DEFAULT 0,
  credential_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS remote_lifecycle (
  device_id TEXT NOT NULL, request_id TEXT NOT NULL, action TEXT NOT NULL,
  PRIMARY KEY (device_id, request_id)
);
CREATE TABLE IF NOT EXISTS remote_transition (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), kind TEXT NOT NULL,
  expected INTEGER NOT NULL, next INTEGER NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_revocations (
  request_id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, target_id TEXT NOT NULL,
  generation INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_replays (
  session_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, ephemeral_pk TEXT NOT NULL,
  expires_ms INTEGER NOT NULL, UNIQUE(device_id, ephemeral_pk)
);
CREATE INDEX IF NOT EXISTS remote_replays_expiry ON remote_replays(expires_ms);
CREATE TABLE IF NOT EXISTS remote_challenges (
  challenge TEXT PRIMARY KEY, device_id TEXT NOT NULL, session_id TEXT NOT NULL,
  record TEXT NOT NULL, expires_unix INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_push_subs (
  device_id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_push_subs_hash ON remote_push_subs(endpoint_hash);

CREATE TABLE IF NOT EXISTS request_receipts (
  device_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_keys', 'complete', 'expired')),
  status INTEGER,
  body TEXT,
  headers TEXT,
  key_ops TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, request_id)
);
CREATE INDEX IF NOT EXISTS receipts_created ON request_receipts(created_at);
CREATE TABLE IF NOT EXISTS request_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  settings_rev INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO request_meta(singleton) VALUES (1);
CREATE TABLE IF NOT EXISTS pending_keys (
  name TEXT PRIMARY KEY,
  value_sha256 TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  device_id TEXT,
  request_id TEXT
);
CREATE TABLE IF NOT EXISTS file_stages (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  temp_rel TEXT NOT NULL,
  final_rel TEXT NOT NULL,
  sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_commits (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  temp_rel TEXT NOT NULL,
  final_rel TEXT NOT NULL,
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  args TEXT NOT NULL,
  url TEXT,
  headers TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL,
  instructions TEXT,
  usage_note TEXT,
  tool_catalog TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  models TEXT NOT NULL,
  available_models TEXT NOT NULL DEFAULT '[]',
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duties TEXT NOT NULL,
  boundaries TEXT NOT NULL,
  avatar TEXT,
  model TEXT,
  provider_id TEXT,
  thinking_level TEXT,
  archived_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bots_name_alive
  ON bots (name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS profile_revisions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  name TEXT NOT NULL,
  duties TEXT NOT NULL,
  boundaries TEXT NOT NULL,
  avatar TEXT,
  actor TEXT NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  name TEXT,
  last_read_at TEXT,
  archived_at TEXT,
  origin_session_id TEXT,
  origin_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_participants (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  member TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (session_id, member)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  turn_id TEXT,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'bot', 'ask', 'approval', 'profile_change', 'system')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  source_turn_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id),
  workspace_relpath TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages (id),
  actor TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, actor, emoji)
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  bot_id TEXT NOT NULL REFERENCES bots (id),
  status TEXT NOT NULL CHECK (status IN (
    'running', 'waiting_approval', 'waiting_ask',
    'completed', 'redirected', 'interrupted', 'stopped'
  )),
  trigger_message_id TEXT NOT NULL REFERENCES messages (id),
  partial_text TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS judgements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  message_id TEXT NOT NULL REFERENCES messages (id),
  bot_id TEXT NOT NULL REFERENCES bots (id),
  decision TEXT NOT NULL CHECK (decision IN ('join', 'pass')),
  reason TEXT,
  error TEXT CHECK (error IS NULL OR error IN ('timeout', 'invalid_output', 'endpoint_error')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (id),
  message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed_once', 'denied', 'voided')),
  kind_key TEXT,
  summary TEXT,
  target TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  requires_api_key INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS allow_rules (
  id TEXT PRIMARY KEY,
  kind_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('daily', 'weekly')),
  schedule_time TEXT NOT NULL,
  weekdays TEXT,
  enabled INTEGER NOT NULL,
  last_fired_for_due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  uses TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS skills_bot_name
  ON skills (bot_id, lower(name));

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  source_session_id TEXT,
  source_message_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS memories_bot_subject
  ON memories (bot_id, lower(subject));

CREATE INDEX IF NOT EXISTS memories_bot_recent
  ON memories (bot_id, updated_at);

CREATE TABLE IF NOT EXISTS turn_route_decisions (
  turn_id TEXT PRIMARY KEY REFERENCES turns (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  bot_id TEXT NOT NULL DEFAULT '',
  trigger_message_id TEXT NOT NULL REFERENCES messages (id),
  provider_id TEXT,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  signature TEXT NOT NULL,
  outcome TEXT CHECK (
    outcome IS NULL OR outcome IN ('completed', 'failed', 'stopped', 'redirected', 'interrupted')
  ),
  fail_kind TEXT,
  reason TEXT,
  chain_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS turn_route_decisions_session
  ON turn_route_decisions (session_id, created_at);

CREATE TABLE IF NOT EXISTS route_feedback (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (id),
  message_id TEXT NOT NULL REFERENCES messages (id),
  bot_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  signature TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_learned (
  bot_id TEXT NOT NULL REFERENCES bots (id),
  signature TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  negative REAL NOT NULL DEFAULT 0,
  positive REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, signature, model, thinking_level)
);

CREATE TABLE IF NOT EXISTS route_reviews (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  chain_id TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turns (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  signature TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  fault TEXT NOT NULL CHECK (fault IN ('model', 'task', 'prompt', 'none')),
  direction TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS route_reviews_bot
  ON route_reviews (bot_id, created_at);

CREATE TABLE IF NOT EXISTS spend (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  bot_id TEXT NOT NULL REFERENCES bots (id),
  turn_id TEXT,
  judgement_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd_ticks INTEGER,
  missing_reason TEXT CHECK (
    missing_reason IS NULL OR missing_reason IN ('stream_interrupted', 'endpoint_omitted')
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (turn_id IS NOT NULL AND judgement_id IS NULL)
    OR (turn_id IS NULL AND judgement_id IS NOT NULL)
  )
);
`;
