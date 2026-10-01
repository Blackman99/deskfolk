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
  last_active_at INTEGER NOT NULL DEFAULT 0,
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
  generation INTEGER NOT NULL DEFAULT 1,
  vapid_fingerprint TEXT,
  last_diagnostics TEXT,
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
  read_through_seq INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  origin_session_id TEXT,
  origin_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A shell you opened. The process dies with the daemon; the row is what the next one
-- starts again, in the same place, so a split layout can put it back where it was.
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  scrollback BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS session_participants (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  member TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (session_id, member)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions (id),
  title TEXT NOT NULL,
  dir TEXT NOT NULL UNIQUE,
  brief TEXT,
  kind TEXT,
  spec TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'parked')),
  spec_updated_at TEXT,
  routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  -- Set aside rather than ended (休眠, ADR 0040): clearing or deleting the conversation it lives in
  -- does this now instead of closing it. closed_at is written with it, so an older build reads the
  -- plan as closed; whatever puts the plan back in its conversation's slot clears closed_at, and
  -- the trigger tasks_dormant_ends (store/tasks.ts) clears this with it, whoever wrote it.
  dormant_since TEXT
);

CREATE INDEX IF NOT EXISTS tasks_session_open
  ON tasks (session_id, closed_at, created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  dir TEXT NOT NULL UNIQUE,
  spec TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'review', 'done', 'parked')),
  worker TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (task_id, seq)
);

CREATE INDEX IF NOT EXISTS tickets_task_status ON tickets (task_id, status, seq);

CREATE TABLE IF NOT EXISTS task_spec_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id),
  revision INTEGER NOT NULL,
  spec TEXT NOT NULL,
  tickets_snapshot TEXT NOT NULL,
  source_message_id TEXT,
  source_turn_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('app', 'user')),
  created_at TEXT NOT NULL,
  -- NULL for a filing (the organizer's or yours); 'hold' for a hold parking or restoring the plan.
  cause TEXT CHECK (cause IS NULL OR cause IN ('hold')),
  UNIQUE (task_id, revision)
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
  task_id TEXT REFERENCES tasks (id),
  ticket_id TEXT REFERENCES tickets (id),
  message_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- JSON MessageControl (ADR 0040 P2): what the app made of your stops on this line — the buttons
  -- on a line of yours it did not act on, or its own receipt or status answer. Null on every other line.
  control TEXT,
  -- 1 on a line only the Bot it wakes reads (ADR 0041): the note stopped work opens again on once
  -- you lift the stop. The conversation, search, unread and every other transcript leave it out,
  -- as they do a check-back's own line (store/check-backs.ts, notBotOnlyLine).
  bot_only INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id),
  workspace_relpath TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'resolved')),
  relpath TEXT NOT NULL,
  file_key TEXT,
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('text_range', 'image_region', 'pdf_region', 'html_element', 'media_time')),
  anchor TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  target_message_id TEXT NOT NULL REFERENCES messages (id),
  target_session_id TEXT NOT NULL REFERENCES sessions (id),
  target_turn_id TEXT,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  session_id TEXT NOT NULL REFERENCES sessions (id),
  message_id TEXT REFERENCES messages (id),
  body TEXT NOT NULL,
  crop_mime TEXT,
  crop BLOB,
  resolved_by TEXT,
  resolved_note TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS annotations_relpath ON annotations (relpath, status);
CREATE INDEX IF NOT EXISTS annotations_session ON annotations (session_id, status);
CREATE INDEX IF NOT EXISTS annotations_message ON annotations (message_id);
CREATE INDEX IF NOT EXISTS annotations_target ON annotations (target_message_id);

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
  task_id TEXT REFERENCES tasks (id),
  ticket_id TEXT REFERENCES tickets (id),
  pending_ask_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
  routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL,
  routine_due_at TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- What the turn may do (ADR 0040): 'work', or 'readonly' for the one kind a hold lets open, the
  -- turn a line of yours opens to answer you; 'desk' is a later phase's. Null on rows an older build
  -- wrote. The hold triggers on this table (store/holds.ts) read it.
  mode TEXT CHECK (mode IS NULL OR mode IN ('work', 'desk', 'readonly'))
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

CREATE TABLE IF NOT EXISTS check_backs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  task_id TEXT,
  ticket_id TEXT,
  note TEXT NOT NULL,
  due_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fired_at TEXT,
  fired_turn_id TEXT,
  message_id TEXT,
  voided_at TEXT,
  -- Null for one the Bot booked itself; 'plan_nudge' for the app's call-back on a plan that went
  -- quiet with work still left.
  kind TEXT,
  -- Why it wakes someone: 'self' (the Bot's own booking), 'delegation' (a Bot↔Bot direct went
  -- quiet), 'supervisor' (the app calling a plan back); ADR 0040 names the rest. Null on rows from
  -- before the column.
  cause TEXT,
  -- What an event wait waits for (a job, a reply); null for a wait on the clock, the only kind yet.
  wait_spec TEXT,
  -- Set while a hold covers it. voided_at is written with it, so a build that knows nothing of
  -- holds reads the row as cancelled and never fires it; lifting the hold clears both.
  suspended_at TEXT,
  -- What a new booking replaces: '<bot id>:<session id>', one pending per Bot per session.
  dedupe_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS check_backs_pending
  ON check_backs (due_at) WHERE fired_at IS NULL AND voided_at IS NULL;

-- A hold (叫停, ADR 0040): your stop as state. Nothing it covers starts or wakes, and only you lift
-- it (lifted_by has no value but yours). Never deleted, and no foreign keys: it outlives a cleared
-- or deleted conversation, which only nulls the message ids. targets is what it covers besides its
-- own scope, fixed when it was made, as [{scope, id}]; effect is what it changed, only added to.
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'bot', 'session', 'plan', 'ticket', 'bot_plan', 'turn')),
  -- Null only for global; bot_plan's is '<bot id>:<plan id>'.
  scope_id TEXT,
  action TEXT NOT NULL DEFAULT 'pause' CHECK (action IN ('pause', 'cancel')),
  cascade INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL CHECK (source IN ('user_text', 'user_button', 'legacy', 'migration')),
  source_message_id TEXT,
  lift_on_next_user_message INTEGER NOT NULL DEFAULT 0,
  targets TEXT NOT NULL DEFAULT '[]',
  effect TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  lifted_at TEXT,
  lifted_by TEXT CHECK (lifted_by IN ('user_text', 'user_button')),
  lifted_message_id TEXT,
  CHECK ((scope = 'global') = (scope_id IS NULL)),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);

CREATE INDEX IF NOT EXISTS holds_in_force ON holds (scope, scope_id) WHERE lifted_at IS NULL;

-- Every scope a hold in force covers, one row each: its own, then each of its targets. The one
-- place "is this held?" is answered, by the store and by triggers alike.
CREATE VIEW IF NOT EXISTS held_scopes AS
  SELECT id AS hold_id, scope, scope_id FROM holds WHERE lifted_at IS NULL
  UNION ALL
  SELECT h.id, json_extract(t.value, '$.scope'), json_extract(t.value, '$.id')
  FROM holds h, json_each(h.targets) t
  WHERE h.lifted_at IS NULL;

-- What happened to the work (ADR 0040), one row per event, only ever appended, and ordered by seq,
-- never by at: the store's clock runs ahead of the wall's in bursts. The kinds so far (ADR 0041):
-- 'wake.suppressed', a wake a hold turned away, payload {cause, holds}; 'control.hold', a hold made,
-- payload {hold, scope, scope_id, source, stopped}; 'control.lift', a hold lifted, payload {hold, by}
-- (plus next_line, undo or narrowed_to where that is how); 'hold.violation', a turn still running
-- under a hold and ended there, payload {hold}; 'daemon.restart', one per boot, payload {cause, cut}.
-- The ledger's (ADR 0040 P3): 'requirement.add', payload {requirement, scope, scope_id, source_kind,
-- status}; 'requirement.raise', payload {requirement, quote}; 'requirement.purge', your purge, payload
-- {requirements}, the one row the trigger requirements_purge_only lets a requirement be deleted
-- under; 'requirement.rescope', entries moved to another scope, payload {requirements, scope,
-- scope_id, cause} (a deleted conversation's project entries, to a null scope_id; or yours on the
-- board or a card: cause whole_project or standing);
-- 'requirement.confirm', a proposed entry or an old rule you took up (a replacement also marks the
-- entry it replaces superseded), payload {requirement, task, replaced}; 'requirement.reject', one you
-- said is no requirement, payload {requirement, task}; 'requirement.waive', one in force you let go
-- (on the board, or by taking its line off the plan), payload {requirement, task};
-- 'requirement.not_here' / 'requirement.here_again', an entry a plan inherits set not to hold for it,
-- or back, payload {requirement, task} (and quote, when the scribe read your words in the plan as
-- it again, actor scribe). Each of these written by your edit of a plan's rules or Done when on the
-- board also names the plan's version that edit made, as action. 'requirement.import', the old
-- rules and Done-when lines of every plan taken into the ledger once, payload {requirements};
-- 'requirement.card', a line of the app's about entries, payload {card: legacy | standing,
-- requirements, category, message, each (a standing card about one entry alone, when present)}.
-- 'quotes.erased', payload {quotes, waived}; 'plan.dormant', a
-- plan set aside because its conversation was cleared or deleted, payload {cause}. The scribe's
-- (scribe.ts): 'scribe.answer', each answer as it came back, payload {quote, model, fail, raw};
-- 'scribe.rejected', an item of it dropped, payload {quote, item, index, reason, requirement}.
-- Checks from your words (store/derived-checks.ts): 'check.derived', one offered, or a gate turned
-- back into an offer because the words you confirmed it on were erased, payload {check, quote,
-- dimension, measure, change: proposed | demoted}; 'check.confirmed', one you confirmed (a card's
-- button or the board), payload {check, dimension, removed, quote} naming the check your choice took
-- away and the words it stood on then; 'check.bound', one pointed at the job's final deliverable,
-- payload {check, path, glob}; 'check.dropped', one the app took away because the words it stood on
-- were erased or filed elsewhere, or a later number replaced the offer, payload {check, quote}.
-- Kept when a conversation's history is cleared or it is deleted; no foreign keys.
CREATE TABLE IF NOT EXISTS work_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- Who did it: 'app' for the engine's own gates.
  actor TEXT NOT NULL,
  bot_id TEXT,
  task_id TEXT,
  ticket_id TEXT,
  part_key TEXT,
  work_item_id TEXT,
  turn_id TEXT,
  session_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS work_events_kind ON work_events (kind, seq);
-- One plan's own events, newest first: its board's 「上次变化」 reads the latest change to its
-- requirements on every read of the plan.
CREATE INDEX IF NOT EXISTS work_events_task ON work_events (task_id, seq);

-- Your words (原话, ADR 0040): a copy of each line you send, each answer you give a Bot's question,
-- each annotation you send and each line you write on the board, taken in the same write as the
-- thing itself. Clearing a conversation deletes its transcript, not these: only the id of what went
-- is nulled (message_id, and session_id as well when the conversation itself is deleted). Erasing
-- one empties body and sets redacted_at; no row is ever deleted. No foreign keys.
CREATE TABLE IF NOT EXISTS user_quotes (
  id TEXT PRIMARY KEY,
  -- Your line; the question an answer is written on; the message a batch of annotations went out
  -- as. Null for the board.
  message_id TEXT,
  session_id TEXT,
  -- The plan and ticket it is about. A line you send is filed after it lands: the trigger
  -- user_quotes_follow_filing (store/quotes.ts) copies the line's filing here when it is written.
  task_id TEXT,
  ticket_id TEXT,
  -- One part of a ticket; parts come in a later phase, so null for now.
  part_key TEXT,
  via TEXT NOT NULL CHECK (via IN ('message', 'ask_answer', 'annotation', 'board')),
  -- As it came, at most QUOTE_MAX code points: a longer one keeps its head and tail.
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redacted_at TEXT
);

CREATE INDEX IF NOT EXISTS user_quotes_task ON user_quotes (task_id, created_at);
CREATE INDEX IF NOT EXISTS user_quotes_message ON user_quotes (message_id);
CREATE INDEX IF NOT EXISTS user_quotes_session ON user_quotes (session_id);

-- The requirements ledger (需求台账, ADR 0040): what you asked of the work, each entry standing on
-- words of yours in user_quotes. Only ever added to, and never deleted but by your purge, which the
-- trigger requirements_purge_only (store/requirements.ts) checks for (I4). Kept whole when a
-- conversation is cleared; deleting the conversation nulls a project entry's scope_id. No foreign
-- keys: a plan that goes does not take its requirements, or the transaction, with it.
CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('part', 'ticket', 'plan', 'project', 'standing')),
  -- The part, ticket or plan it holds for; for project, the conversation the plan lives in (a
  -- project is that conversation), null once it is deleted; for standing, null (domain says where).
  scope_id TEXT,
  domain TEXT,
  -- Your words, at most 300 code points out of one user_quotes body; empty once you erase them.
  quote TEXT NOT NULL,
  -- A Bot's restatement, shown beside your words, never instead of them.
  restated TEXT,
  category TEXT,
  polarity TEXT NOT NULL DEFAULT 'must' CHECK (polarity IN ('must', 'must_not')),
  -- A number you gave: duration, resolution, aspect or fps, and its value as JSON, as the fixed
  -- rules of quote-dimensions.ts read the words: a later, different number for it is proposed as
  -- its replacement whatever category the scribe gives, the same number again only raises it.
  dimension TEXT,
  value TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'ask_answer', 'annotation', 'board', 'accepted_suggestion', 'legacy')),
  source_quote_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'open', 'superseded', 'waived', 'not_requirement', 'unverified')),
  -- A replacement names the entry it replaces, and is proposed until you take it up; a superseded
  -- entry names what replaced it (the trigger requirements_superseded_by_later holds that
  -- replacement to later words of yours). No writer supersedes an entry yet: nothing leaves the
  -- open set without you (I9).
  supersedes TEXT,
  superseded_by TEXT,
  times_raised INTEGER NOT NULL DEFAULT 1,
  last_raised_at TEXT NOT NULL,
  -- 'user', 'app', or the writer that proposed it: 'scribe', 'capture' for the fallback capture of
  -- a complaint the scribe filed nothing for, 'import' for an old rule taken into the ledger.
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The ledger's own number (R-N), one more than the highest so far; how an entry is named in the
  -- Bots' situation and on the board.
  seq INTEGER,
  -- The plan the words were said about, whatever the scope: an entry of the conversation or a
  -- standing one reads as inherited in every other plan.
  origin_task_id TEXT
);

CREATE INDEX IF NOT EXISTS requirements_scope ON requirements (scope, scope_id, status);
CREATE INDEX IF NOT EXISTS requirements_source_quote ON requirements (source_quote_id);

-- An entry a plan inherits (of its conversation, or standing) that you said does not hold for it
-- (不适用这件事). The entry itself is untouched: every other plan still has it.
CREATE TABLE IF NOT EXISTS requirement_exclusions (
  requirement_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (requirement_id, task_id)
);

-- Each time words of yours raised an entry, the first time included.
CREATE TABLE IF NOT EXISTS requirement_mentions (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS requirement_mentions_requirement ON requirement_mentions (requirement_id);
CREATE INDEX IF NOT EXISTS requirement_mentions_quote ON requirement_mentions (quote_id);

-- A working Bot's inbox (收件, ADR 0040 P4a): each line said to a Bot while a turn of its works —
-- a line of yours in your direct with it, a Bot naming it, its own check-back coming due, the note
-- a go on of yours sends, your line about its job said in another conversation — from the moment it
-- arrives to what the Bot said it did with it. The live turn's in-memory list is only a copy of its
-- queued rows. body_snapshot keeps the words, so clearing a conversation, which nulls message_id and
-- the turn ids, leaves a queued or held item whole. No foreign keys.
CREATE TABLE IF NOT EXISTS inbox_items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  -- Work items come in a later phase; null for now.
  work_item_id TEXT,
  -- Where it is heard: the conversation of the turn it was queued for; null once that conversation
  -- is deleted.
  session_id TEXT,
  -- The turn it was queued for, kept after that turn ends: an item still waiting then is the Bot's
  -- next turn's in session_id.
  turn_id TEXT,
  -- The job it is about: the line's own plan and ticket, else those of the turn it was queued for.
  task_id TEXT,
  ticket_id TEXT,
  message_id TEXT,
  -- Who said it as the note names them: 'user' for you, a Bot's name, '' for a check-back.
  author TEXT NOT NULL,
  body_snapshot TEXT NOT NULL,
  -- Where it was said, when that is another conversation than session_id, as the hearing Bot calls it.
  said_in TEXT,
  source TEXT NOT NULL CHECK (source IN ('user', 'annotation', 'delegation', 'delegation_reply', 'review', 'job', 'timer', 'system', 'peer_note')),
  kind TEXT NOT NULL CHECK (kind IN ('change', 'question', 'info', 'result', 'wake', 'control_note')),
  -- 1 yours, 2 a hand-back or a review, 3 everything else.
  priority INTEGER NOT NULL,
  -- 0: read only when the Bot next wakes, never waking it; nothing writes 0 yet.
  wakes INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('queued', 'held', 'delivered', 'adopted', 'answered', 'declined', 'deferred', 'unacked', 'merged', 'superseded')),
  possible_control INTEGER NOT NULL DEFAULT 0,
  delivered_turn_id TEXT,
  delivered_hop INTEGER,
  disposition_note TEXT,
  created_at TEXT NOT NULL,
  disposed_at TEXT
);

CREATE INDEX IF NOT EXISTS inbox_items_waiting ON inbox_items (bot_id, session_id, state);
CREATE INDEX IF NOT EXISTS inbox_items_turn ON inbox_items (turn_id, state);
CREATE INDEX IF NOT EXISTS inbox_items_delivered ON inbox_items (delivered_turn_id, state);
CREATE INDEX IF NOT EXISTS inbox_items_message ON inbox_items (message_id);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots (id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  uses TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The correction chain whose learning hop last wrote this skill. Null when a turn wrote it.
  learned_chain_id TEXT
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
  -- The correction chain whose learning hop wrote this memory. Null when a turn wrote it.
  learned_chain_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS memories_bot_subject
  ON memories (bot_id, lower(subject));

CREATE INDEX IF NOT EXISTS memories_bot_recent
  ON memories (bot_id, updated_at);

-- What a turn actually ran, in order: each shell command with its exit code, and each MCP call.
-- The closing check and the organizer read it, so "the tests pass" can be held against a run
-- instead of against the Bot's word. Written as each call finishes, so a turn that is redirected
-- or interrupted keeps what it ran.
CREATE TABLE IF NOT EXISTS turn_runs (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id TEXT,
  ticket_id TEXT,
  bot_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  ok INTEGER NOT NULL,
  error TEXT,
  -- Where the shell actually ran, workspace-relative; null for MCP calls and for runs from before
  -- this column. commandSeenInPlan reads it to tell an acceptance check's command apart from one
  -- that only looks the same but ran somewhere else.
  cwd TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS turn_runs_turn ON turn_runs (turn_id, created_at);
CREATE INDEX IF NOT EXISTS turn_runs_task ON turn_runs (task_id, created_at);

-- A command a turn's shell started and that has not exited yet (ADR 0040 I10). The row goes in as
-- soon as the spawn returns a pid and comes out when that process exits, so it is on disk however
-- the daemon dies; the next boot kills the process group of every row another boot left, but only
-- after the OS confirms the pid still started at proc_start_time, since pids are reused, and that
-- the daemon which wrote the row is gone. turn_runs could not do this: it is written after a call
-- ends and caps out per turn. No foreign keys: a row goes when its process exits, never with a
-- cleared or deleted session.
CREATE TABLE IF NOT EXISTS live_procs (
  boot_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  -- The group Stop and the boot cleanup signal; null on win32, which has none (the tree is walked).
  pgid INTEGER,
  turn_id TEXT,
  tool_call_id TEXT,
  command TEXT NOT NULL,
  started_at TEXT NOT NULL,
  -- How the OS itself reports the start (ps lstart, /proc starttime, the Windows start time);
  -- filled in moments after the spawn, and null when the process was gone before it could be read.
  proc_start_time TEXT,
  platform TEXT NOT NULL,
  -- The daemon that wrote the row, and its start as the OS reports it (read with proc_start_time,
  -- null until then). A daemon started on a copy of this file sees the live daemon's rows under a
  -- boot id not its own; these say that their daemon is still running and the rows are not its.
  daemon_pid INTEGER NOT NULL,
  daemon_start_time TEXT,
  PRIMARY KEY (boot_id, pid)
);

-- An executable acceptance check (可执行验收): the app's own proof that one acceptance line holds,
-- run on this Mac. Bots never write these — the organizer may only turn a command into a check
-- when a turn of this plan already ran it, or the user wrote it themselves (enforced in the store).
-- The app also makes some from numbers in your words (origin 'derived', store/derived-checks.ts,
-- ADR 0040 P3). Its CHECK lists stay as they are until the last phase: what they cannot hold goes
-- in the new columns, and the old ones get the nearest value an older build understands.
CREATE TABLE IF NOT EXISTS acceptance_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  ticket_id TEXT REFERENCES tickets (id) ON DELETE SET NULL,
  item TEXT NOT NULL,
  -- A measure check (a video's running time, resolution, aspect or frame rate) is 'exists' here,
  -- with measure set: an older build checks that the file is there, and this one measures it.
  kind TEXT NOT NULL CHECK (kind IN ('exists', 'contains', 'matches', 'command', 'continuity')),
  path TEXT,
  pattern TEXT,
  negate INTEGER NOT NULL DEFAULT 0,
  command TEXT,
  cwd TEXT,
  expect_exit INTEGER,
  expect_stdout TEXT,
  timeout_sec INTEGER,
  -- 'user' for a derived check too: your words are what it stands on (origin says the rest).
  source TEXT NOT NULL CHECK (source IN ('organizer', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  defined_at TEXT NOT NULL,
  first_passed_at TEXT,
  removed_at TEXT,
  -- 'derived' for a check the app read from your words; null for the rest (read source then).
  origin TEXT,
  -- A derived check's range, as JSON (protocol CheckMeasure); its kind reads as measure.
  measure TEXT,
  -- The quote (user_quotes) the number was read from, the latest words to give it.
  quote_id TEXT,
  -- How a derived check found the file it measures (path): 'glob', the job's final deliverable by
  -- its name, bind_glob saying which name. Null while none is delivered: it never runs then.
  bind_kind TEXT,
  bind_glob TEXT,
  -- A derived check's standing: 'proposed' (offered to you; measured, never a gate) or 'active' (a
  -- gate, which only your confirm makes). Null reads as proposed.
  derived_state TEXT
);

CREATE INDEX IF NOT EXISTS acceptance_checks_task ON acceptance_checks (task_id, removed_at, created_at);

CREATE TABLE IF NOT EXISTS acceptance_check_runs (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL REFERENCES acceptance_checks (id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  cause TEXT NOT NULL CHECK (cause IN ('settle', 'user', 'edit')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('pass', 'fail', 'blocked', 'error')),
  exit_code INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  output TEXT
);

CREATE INDEX IF NOT EXISTS acceptance_check_runs_check ON acceptance_check_runs (check_id, started_at);
CREATE INDEX IF NOT EXISTS acceptance_check_runs_open ON acceptance_check_runs (task_id) WHERE finished_at IS NULL;

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
  finished_at TEXT,
  -- How the work went, written once when the turn closes. Null means the process stopped before
  -- it could count, which a review reads as unknown rather than as zero errors.
  hops INTEGER,
  tool_calls INTEGER,
  tool_errors INTEGER,
  repeated_failures INTEGER,
  files_written INTEGER,
  -- The first few failed calls as JSON [{tool, target, error}], for the learning hop to name.
  tool_failures TEXT
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
  created_at TEXT NOT NULL,
  -- Set when the conclusion was followed twice and neither time got cleaner. The picker skips it.
  retired_at TEXT
);

CREATE INDEX IF NOT EXISTS route_reviews_bot
  ON route_reviews (bot_id, created_at);

CREATE TABLE IF NOT EXISTS route_learnings (
  chain_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('memory', 'skill', 'none')),
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Ledger. Rows outlive the session, bot, turn and judgement they name: no foreign keys.
-- Indexes live in migrate.ts so an older database does not index columns it does not have yet.
CREATE TABLE IF NOT EXISTS spend (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  session_name TEXT,
  bot_id TEXT,
  bot_name TEXT,
  turn_id TEXT,
  judgement_id TEXT,
  kind TEXT NOT NULL CHECK (
    kind IN ('turn', 'judgement', 'route_pick', 'route_review', 'route_learn', 'composer_suggest', 'organize', 'acceptance_check')
  ),
  -- What the call was for where the kind is shared (ADR 0042): the scribe and a reflection bill
  -- as organize, a judgement of pictures as acceptance_check. Added by migrate.ts on older ledgers.
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('scribe', 'vision', 'reflect')),
  chain_id TEXT,
  provider_id TEXT,
  provider_name TEXT,
  model TEXT,
  thinking_level TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd_ticks INTEGER,
  estimated_cost_usd_ticks INTEGER,
  missing_reason TEXT CHECK (
    missing_reason IS NULL OR missing_reason IN ('stream_interrupted', 'endpoint_omitted')
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'turn' AND turn_id IS NOT NULL)
    OR (kind = 'judgement' AND judgement_id IS NOT NULL)
    OR (kind = 'route_pick' AND turn_id IS NOT NULL)
    OR (kind = 'route_review' AND chain_id IS NOT NULL AND turn_id IS NOT NULL)
    OR (kind = 'route_learn' AND chain_id IS NOT NULL)
    OR kind = 'composer_suggest'
    OR kind = 'organize'
    OR kind = 'acceptance_check'
  )
);

-- One organizer call (message-filing or settle), win or lose: the model's raw answer, what it
-- could pick from and what it picked (before and after candidate-set validation), and whether the
-- filing landed or why not. GET /v1/debug/organizer-runs?task_id= is the only reader; no foreign
-- keys, so a deleted plan's history stays readable (deleting or clearing a session removes its own
-- rows instead — see store/sessions.ts). Indexed on task_id and applied_task_id (a resume or join
-- run's filing can land on a different plan than the one it started against) and, expression-
-- indexed, on the raw resume/join target inside candidates_apply, so organizerRunsForTask's fourth
-- way of finding a row — named as a target but rejected before landing anywhere — need not scan
-- every row. Pruned to the newest ORGANIZER_RUNS_KEPT_PER_SESSION per session on every write,
-- through organizer_runs_session so a write never reads the session's whole history.
CREATE TABLE IF NOT EXISTS organizer_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('message', 'settle')),
  message_id TEXT,
  spend_id TEXT,
  raw_answer TEXT,
  fail_kind TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('continue', 'new', 'resume', 'join')),
  candidates_payload TEXT NOT NULL,
  candidates_apply TEXT,
  candidates_at_parse TEXT,
  downgrade_reason TEXT,
  applied INTEGER NOT NULL,
  reject_reason TEXT,
  held TEXT,
  applied_task_id TEXT,
  applied_ticket_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS organizer_runs_session ON organizer_runs (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS organizer_runs_task ON organizer_runs (task_id, created_at);
CREATE INDEX IF NOT EXISTS organizer_runs_applied_task ON organizer_runs (applied_task_id, created_at);
CREATE INDEX IF NOT EXISTS organizer_runs_resume_named ON organizer_runs (json_extract(candidates_apply, '$.resume_plan_id'));
CREATE INDEX IF NOT EXISTS organizer_runs_join_named ON organizer_runs (json_extract(candidates_apply, '$.join_plan_id'));

CREATE TABLE IF NOT EXISTS notification_counters (
  name TEXT PRIMARY KEY,
  val INTEGER NOT NULL
);
INSERT OR IGNORE INTO notification_counters (name, val) VALUES ('ordinal', 0), ('message_seq', 0), ('cleanup_revision', 1);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL UNIQUE,
  semantic_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'ask', 'failure', 'interrupted', 'reply', 'routine_result')),
  session_id TEXT REFERENCES sessions (id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages (id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns (id) ON DELETE CASCADE,
  approval_id TEXT REFERENCES approvals (id) ON DELETE CASCADE,
  routine_id TEXT REFERENCES routines (id) ON DELETE SET NULL,
  routine_due_at TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT,
  terminal_at TEXT,
  action_state TEXT NOT NULL CHECK (action_state IN ('none', 'open', 'resolved', 'voided')),
  resolution_reason TEXT,
  fail_kind TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS notifications_ordinal ON notifications (ordinal);
CREATE INDEX IF NOT EXISTS notifications_kind_action ON notifications (kind, action_state);
CREATE INDEX IF NOT EXISTS notifications_unread ON notifications (read_at, ordinal);
CREATE INDEX IF NOT EXISTS notifications_session ON notifications (session_id);
CREATE INDEX IF NOT EXISTS notifications_retention ON notifications (terminal_at, ordinal) WHERE action_state != 'open';

CREATE TABLE IF NOT EXISTS notification_retention_notice (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  pruned_at TEXT NOT NULL,
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS notification_policy (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL DEFAULT 1,
  cat_approval INTEGER NOT NULL DEFAULT 1,
  cat_ask INTEGER NOT NULL DEFAULT 1,
  cat_failure INTEGER NOT NULL DEFAULT 1,
  cat_interrupted INTEGER NOT NULL DEFAULT 1,
  cat_reply INTEGER NOT NULL DEFAULT 1,
  cat_routine_result INTEGER NOT NULL DEFAULT 1,
  quiet_enabled INTEGER NOT NULL DEFAULT 0,
  quiet_start TEXT NOT NULL DEFAULT '22:00',
  quiet_end TEXT NOT NULL DEFAULT '08:00',
  quiet_tz TEXT NOT NULL DEFAULT 'UTC'
);
INSERT OR IGNORE INTO notification_policy (singleton, revision, cat_approval, cat_ask, cat_failure, cat_interrupted, cat_reply, cat_routine_result, quiet_enabled, quiet_start, quiet_end, quiet_tz)
VALUES (1, 1, 1, 1, 1, 1, 1, 1, 0, '22:00', '08:00', 'UTC');

CREATE TABLE IF NOT EXISTS notification_push_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  contact_uri TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO notification_push_config (singleton, contact_uri, revision)
VALUES (1, NULL, 1);

CREATE TABLE IF NOT EXISTS session_notification_preferences (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  muted INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notification_devices (
  receiver_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 0,
  sound TEXT NOT NULL DEFAULT 'default',
  preview TEXT NOT NULL DEFAULT 'generic',
  badge INTEGER NOT NULL DEFAULT 1,
  push_generation INTEGER NOT NULL DEFAULT 1,
  planned_ordinal INTEGER NOT NULL DEFAULT 0,
  last_invalid_endpoint_hash TEXT,
  last_invalid_reason TEXT,
  last_attempt_at INTEGER,
  next_send_at INTEGER,
  last_diagnostics TEXT
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  receiver_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  batch_key TEXT NOT NULL,
  upper_ordinal INTEGER NOT NULL,
  click_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'accepted', 'retry_wait', 'suppressed', 'expired', 'failed', 'unknown')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  absolute_expires_at INTEGER NOT NULL,
  claim_token TEXT,
  claim_expires_at INTEGER,
  permit TEXT,
  push_generation INTEGER NOT NULL DEFAULT 1,
  trust_generation INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(receiver_id, channel, batch_key)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_state ON notification_deliveries (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_receiver ON notification_deliveries (receiver_id, channel);
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_active
  ON notification_deliveries (receiver_id, channel)
  WHERE state IN ('pending', 'claimed', 'retry_wait');

CREATE TABLE IF NOT EXISTS notification_delivery_items (
  delivery_id TEXT NOT NULL REFERENCES notification_deliveries (delivery_id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  PRIMARY KEY (delivery_id, notification_id)
);
`;
