/**
 * The daemon's one door to SQLite and the keychain. Every domain lives in its own module under
 * `store/`; this facade owns the connection, runs schema catch-up, and exposes each module's
 * functions as methods with the database context already bound, so callers keep writing
 * `store.getBot(id)` while the code behind it stays small enough to read in one sitting.
 */
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { defaultAppDataDir, providerKeychainName, mcpAuthKeychainName, type CapabilitiesResponse, type ClientEvent, type RuntimeSnapshot } from "@real-bot/protocol";
import { installChangeJournal, committedEvents } from "./events";
import { Transactions } from "./transactions";
import { Receipts } from "./receipts";
import * as acceptanceChecks from "./acceptance-checks";
import * as credentials from "./credentials";
import * as files from "./files";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../schema";
import { ulid } from "../ids";
import * as annotations from "./annotations";
import * as approvals from "./approvals";
import * as bots from "./bots";
import * as checkBacks from "./check-backs";
import * as holds from "./holds";
import * as inbox from "./inbox";
import * as filing from "./filing";
import * as desk from "./desk";
import * as jobConversations from "./job-conversations";
import * as newPlanCards from "./new-plan-cards";
import * as delegations from "./delegations";
import * as workOn from "./work-on";
import * as peerNotes from "./peer-notes";
import * as endContract from "./end-contract";
import * as supervisor from "./supervisor";
import * as submissions from "./submissions";
import * as externalJobs from "./external-jobs";
import * as modelDefaults from "./model-defaults";
import * as modelLadder from "./model-ladder";
import * as claudeCode from "./claude-code";
import * as escalation from "./escalation";
import * as toolExecutions from "./tool-executions";
import * as workQuestions from "./work-questions";
import * as workItems from "./work-items";
import * as judgements from "./judgements";
import * as liveProcs from "./live-procs";
import * as mcp from "./mcp";
import * as memories from "./memories";
import * as messages from "./messages";
import * as messageEdits from "./message-edits";
import { migrateSchema } from "./migrate";
import * as notifications from "./notifications";
import * as organizerRuns from "./organizer-runs";
import * as providers from "./providers";
import * as quotes from "./quotes";
import * as requirements from "./requirements";
import * as planRequirements from "./plan-requirements";
import * as routines from "./routines";
import * as routing from "./routing";
import * as scribePatch from "./scribe-patch";
import * as derivedChecks from "./derived-checks";
import {
  acceptOlderApp,
  assertSchemaGate,
  capabilitiesOf,
  ENGINE_LEVELS,
  markCleanShutdown,
  raiseEngineLevel,
  readAndResetShutdownFlag,
  readEngineGateOptIn,
  readEngineLevel,
  withdrawOlderAppOptIn,
  type EngineGateOptIn,
  type SharedInstall,
} from "./schema-gate";
import * as search from "./search";
import * as sessions from "./sessions";
import * as settings from "./settings";
import {
  KeyCache,
  defaultProviderId,
  memoryKeyStore,
  workspacePath,
  type StoreContext,
  type StoreOptions,
} from "./shared";
import * as skills from "./skills";
import * as spend from "./spend";
import * as planSpec from "./plan-spec";
import * as tasks from "./tasks";
import * as terminals from "./terminals";
import * as tickets from "./tickets";
import * as turnRuns from "./turn-runs";
import * as turns from "./turns";
import * as workEvents from "./work-events";
import * as quality from "./quality";
import * as lessons from "./lessons";
import * as reflection from "./reflection";
import * as retrospectives from "./retrospectives";
import * as prompts from "./prompts";
import * as sharedSkills from "./shared-skills";
import * as planItemsModule from "./plan-items";
import * as largeJobs from "./large-jobs";
import * as newJobModule from "./new-job-from-line";

export { HttpError } from "../errors";
export { isReservedTaskPath, localDate, BRIEF_MAX, PLAN_MAP_FILE, RESERVED_SUBDIRS, TICKET_FILE, WORK_ROOT } from "./tasks";
export type { Task, PlanSpec, PlanStatus } from "./tasks";
export { normalizePlanSpec, parsePlanSpec, emptyPlanSpec, normalizeSpecLine, PLAN_STATUSES } from "./plan-shape";
export {
  CHECKS_MAX,
  ORGANIZER_NEW_CHECKS_MAX,
  CHECK_RUNS_KEPT,
  CHECK_OUTPUT_MAX,
  CHECK_DETAIL_MAX,
  CHECK_TIMEOUT_DEFAULT_SEC,
  CHECK_TIMEOUT_MIN_SEC,
  CHECK_TIMEOUT_MAX_SEC,
  CHECK_ITEM_MAX,
  CHECK_COMMAND_MAX,
  CHECK_PATTERN_MAX,
  CHECK_EXPECT_STDOUT_MAX,
  CHECK_PATH_MAX,
  CHECK_KINDS,
  checkDefinitionKey,
  checkNeverRanSinceDefinition,
  derivedNotGate,
} from "./acceptance-checks";
export type { CheckDefinition, OrganizerCheckInput } from "./acceptance-checks";
export { derivedChanged } from "./derived-checks";
export type { DerivedChecksChange } from "./derived-checks";
export { TICKET_STATUSES, TICKETS_MAX, TICKET_SPEC_MAX, TICKET_TITLE_MAX, isTicketStatus } from "./tickets";
export { checkLines, gateFailed, inTicketDir, ticketStage, type Submission as StoredSubmission, type SubmissionCheck, type SettledSubmission, type ReviewResult } from "./submissions";
export { jobArgsDigest, promptPartNumber, type ExternalJob, type JobState } from "./external-jobs";
export type { JobToFile, LineToFile } from "./filing";
export { ORGANIZER_NEW_TICKETS_MAX, titleKey } from "./plan-spec";
export type { OrganizerResult, OrganizerTicketInput, SpecRevisionRow } from "./plan-spec";
export { CHECK_BACK_MAX_MINUTES, CHECK_BACK_MIN_MINUTES, CHECK_BACK_NOTE_MAX, PLAN_NUDGE_NOTE_MAX, repeatsPlanAnswer } from "./check-backs";
export type { CheckBack, CheckBackCause, QuietDirect } from "./check-backs";
export { botPlanScopeId, HOLD_SCOPES, heldBy, heldSql } from "./holds";
export type { HeldSubject } from "./holds";
export type { EndpointKeyStore, StoreOptions } from "./shared";
export type { AttachmentInput } from "./messages";
export type { FileCommit, LiveFile } from "./files";
export type { DecideRouteInput } from "./routing";
export type { TurnRun } from "./turn-runs";
export { TURN_RUNS_PER_TURN } from "./turn-runs";
export type { LiveProc } from "./live-procs";
export type { WorkEvent } from "./work-events";
export { QUOTE_MAX } from "./quotes";
export type { QuoteVia, UserQuote } from "./quotes";
export { inboxLabel, inboxSeqOf } from "./inbox";
export type { InboxItem, InboxKind, InboxSource } from "./inbox";
export { IMPORT_WRITER, REQUIREMENT_PURGE_ABORT, REQUIREMENT_QUOTE_MAX, REQUIREMENT_SUPERSEDE_ABORT } from "./requirements";
export type { BearingRequirement, Requirement, RequirementScope, RequirementSourceKind, RequirementStatus } from "./requirements";
export { LEGACY_IMPORTED_KEY } from "./plan-requirements";
export { CAPTURE_WRITER, SCRIBE_QUOTE_MIN, SCRIBE_WRITER } from "./scribe-patch";
export type { ScribeOutcome, ScribePatch } from "./scribe-patch";

type Bound<F> = F extends (ctx: StoreContext, ...args: infer A) => infer R ? (...args: A) => R : never;

export class Store {
  readonly db: Database;
  /** The database file, or null for an in-memory store: what a Bot's records queries open read-only (ADR 0065). */
  readonly filename: string | null;
  readonly receipts: Receipts;
  /** How the previous run ended, read once at boot before this run's own flag is set to `crash` (see `schema-gate.ts`). */
  readonly previousShutdown: "clean" | "crash";
  /**
   * This open of the database, for `live_procs`: a row with any other boot id was written by
   * another run (ADR 0040 I10). Usually that run is gone and what the row names is an orphan, but a
   * daemon opened on a copy of a live database sees the live daemon's rows too, so each row also
   * says which daemon process wrote it.
   */
  readonly bootId = ulid();
  /**
   * The `bootId` of the run that opened this database before this one, read at open and replaced
   * by this run's: a shutdown's record of the turns it cut off is told only by the boot after it
   * (ADR 0041). Null on a database no run of this build has opened.
   */
  readonly previousBootId: string | null;
  private readonly ctx: StoreContext;
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private journalReady = false;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.filename ?? ":memory:", { create: true, strict: true });
    this.filename = options.filename && options.filename !== ":memory:" ? options.filename : null;
    this.db.run("PRAGMA foreign_keys = ON");
    if (options.filename && options.filename !== ":memory:") {
      this.db.run("PRAGMA journal_mode = WAL");
    }
    this.db.run("PRAGMA synchronous = FULL");
    // The version gate has to run before `SCHEMA_SQL`, not after: that statement creates indexes
    // and seeds rows, not just tables and columns, and a database whose floor this build cannot
    // meet may have dropped something one of those statements assumes is still there — running it
    // first can write to a database ADR 0040's version gate says to refuse outright, or fail with a
    // raw SQLite error instead of the refusal a user is supposed to see (schema-gate.ts). A brand new database
    // has no `settings` table yet, so there is nothing yet to gate on.
    const hasSettingsTable = this.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
    ).get() !== null;
    if (hasSettingsTable) {
      try {
        assertSchemaGate(this.db);
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
    this.db.exec(SCHEMA_SQL);
    this.previousShutdown = readAndResetShutdownFlag(this.db);
    migrateSchema(this.db);
    if (options.filename && options.filename !== ":memory:") {
      try {
        chmodSync(options.filename, 0o600);
      } catch {
        // ignore if the host filesystem rejects chmod
      }
    }
    this.ctx = {
      db: this.db,
      keys: new KeyCache(options.endpointKey ?? memoryKeyStore(), this.db, (name) => this.keysChanged(name)),
      tx: new Transactions(this.db, () => { if (this.journalReady) this.emit(committedEvents(this.ctx)); }),
      inboxRoot: options.filename && options.filename !== ":memory:" ? dirname(options.filename) : defaultAppDataDir({ platform: process.platform, env: process.env, home: homedir() }),
      keyPlan: null,
      activeStages: new Set(),
      legacy: { copiedKey: false },
      commit: (write) => this.commit(write),
    };
    this.previousBootId = turns.swapLastRun(this.ctx, this.bootId);
    this.receipts = new Receipts(this.db, this.ctx.tx, this.ctx.keys, () => files.recoverFiles(this.ctx));
    files.recoverFiles(this.ctx);
    settings.ensureLegacyProviderRow(this.ctx);
    sessions.ensureFileDropSession(this.ctx);
    // Ledgers from before estimates followed the configured rates still hold what was priced at insert.
    this.commit(() => spend.repriceSpend(this.ctx, providers.catalogEntries(this.ctx)));
    // The rules plans had before the requirements ledger go into it, once (ADR 0040 P3).
    this.commit(() => planRequirements.importLegacyRules(this.ctx));
    installChangeJournal(this.ctx);
    this.journalReady = true;
  }

  readonly transaction = <T>(work: () => T): T => this.ctx.tx.run(work);
  readonly afterCommit = (effect: () => void): void => this.ctx.tx.afterCommit(effect);
  readonly recoverFiles = (): void => files.recoverFiles(this.ctx);
  readonly prepareFile = (...args: Parameters<Bound<typeof files.prepareFile>>) => files.prepareFile(this.ctx, ...args);
  readonly openLiveFile = (...args: Parameters<Bound<typeof files.openLiveFile>>) => files.openLiveFile(this.ctx, ...args);
  readonly writeLiveFile = files.writeLiveFile;
  readonly finishLiveFile = (...args: Parameters<Bound<typeof files.finishLiveFile>>) => files.finishLiveFile(this.ctx, ...args);
  readonly abortLiveFile = (...args: Parameters<Bound<typeof files.abortLiveFile>>) => files.abortLiveFile(this.ctx, ...args);
  readonly commitPreparedFile = this.bind(files.commitPreparedFile);
  readonly discardFile = this.bind(files.discardFile);
  readonly prepareAttachments = (...args: Parameters<Bound<typeof messages.prepareAttachments>>) => messages.prepareAttachments(this.ctx, ...args);
  readonly reserveAttachmentName = (...args: Parameters<Bound<typeof messages.reserveAttachmentName>>) => messages.reserveAttachmentName(this.ctx, ...args);

  planKeys<T>(plan: Array<{ name: string; value: string }>, work: () => T): T {
    this.ctx.keyPlan = plan;
    try { return work(); } finally { this.ctx.keyPlan = null; }
  }

  readonly listCredentialOperations = this.bind(credentials.listCredentialOperations);
  readonly resolveCredentialOperation = this.bind(credentials.resolveCredentialOperation);
  readonly applyMcpInspection = this.bind(mcp.applyMcpInspection);

  readonly settingsCached = this.bind(settings.settingsCached);
  readonly patchSettingsSync = this.bind(settings.patchSettingsSync);
  /** `GET /v1/capabilities`: what this build's engine understands, so a phone page (or a messenger
   * built from a newer source tree) can show only what the daemon it is actually talking to supports. */
  readonly capabilities = (): CapabilitiesResponse => capabilitiesOf(this.db);
  /**
   * At boot: takes the database up to this build's engine level unless an installed app that
   * shares it would misread that (`installed`: what is known of it, null when none shares it; see
   * `raiseEngineLevel`).
   */
  readonly raiseEngineLevel = (installed: SharedInstall | null) => raiseEngineLevel(this.db, installed);
  /**
   * The engine level as far up as `installed` lets it go (`raiseEngineLevel`), then the plans
   * parked before holds existed taken over as holds and whatever a hold covers held again
   * (`reconcileHolds`): at boot, and when a developer accepts an older installed app while the
   * daemon runs (`POST /v1/capabilities/raise`). Returns what daemon.log should say about it.
   */
  readonly catchUpEngineLevel = (installed: SharedInstall | null): string[] => {
    const raise = this.raiseEngineLevel(installed);
    const lines = [raise.refused, raise.accepted].filter((line): line is string => line !== null);
    const held = this.reconcileHolds();
    if (held.imported.length > 0) lines.push(`took over ${held.imported.length} parked plan(s) as holds: ${held.imported.join(", ")}`);
    if (held.reparked.length > 0) lines.push(`parked again under their holds: ${held.reparked.join(", ")}`);
    return lines;
  };
  /** The developer's opt-in past an older installed app (ADR 0041; see `acceptOlderApp`). */
  readonly acceptOlderApp = (by: EngineGateOptIn["by"], level?: number): EngineGateOptIn => acceptOlderApp(this.db, by, undefined, level);
  /** Takes it back; the engine level stays where it is. */
  readonly withdrawOlderAppOptIn = (): void => withdrawOlderAppOptIn(this.db);
  readonly engineGateOptIn = (): EngineGateOptIn | null => readEngineGateOptIn(this.db);
  /** Called once, on the way out of a deliberate stop — never on a crash (see `schema-gate.ts`). */
  readonly recordCleanShutdown = (): void => markCleanShutdown(this.db);
  readonly createProviderSync = this.bind(providers.createProviderSync);
  readonly patchProviderSync = this.bind(providers.patchProviderSync);
  readonly deleteProviderSync = this.bind(providers.deleteProviderSync);
  readonly createMcpServerSync = this.bind(mcp.createMcpServerSync);
  readonly patchMcpServerSync = this.bind(mcp.patchMcpServerSync);
  readonly deleteMcpServerSync = this.bind(mcp.deleteMcpServerSync);
  readonly providersCached = this.bind(providers.providersCached);
  readonly lightestThinkingLevelFor = this.bind(providers.lightestThinkingLevelFor);

  close(): void {
    this.db.close();
  }

  onCommit(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(events: ClientEvent[]): void {
    for (const event of events) for (const listener of this.listeners) listener(event);
  }

  private keysChanged(name: string): void {
    if (!this.journalReady) return;
    this.ctx.tx.run(() => {
      const provider = providers.providersCached(this.ctx).find((row) => providerKeychainName(row.id) === name);
      const server = mcp.listMcpServers(this.ctx).find((row) => mcpAuthKeychainName(row.id) === name);
      if (provider) {
        this.db.run("INSERT INTO event_changes VALUES ('providers', ?, 'UPDATE', NULL)", [provider.id]);
        this.db.run("UPDATE request_meta SET settings_rev = settings_rev + 1 WHERE singleton = 1");
      }
      if (server) this.db.run("INSERT INTO event_changes VALUES ('mcp_servers', ?, 'UPDATE', NULL)", [server.id]);
    });
  }

  private commit<T>(write: () => T): T {
    return this.ctx.tx.run(write);
  }

  private bind<F extends (ctx: StoreContext, ...args: never[]) => unknown>(fn: F, asynchronous = false): Bound<F> {
    return ((...args: unknown[]) => {
      const call = () => (fn as unknown as (...all: unknown[]) => unknown)(this.ctx, ...args);
      // Async domain methods delimit each SQLite write with ctx.commit themselves.
      return asynchronous || this.db.inTransaction ? call() : this.commit(call);
    }) as Bound<F>;
  }

  async hydrateSnapshot(): Promise<void> {
    await this.settings();
    await this.listMcpServersHydrated();
  }

  readSnapshot(): Omit<RuntimeSnapshot, "event_instance_id" | "watermark_seq"> {
    return {
      credentialOperations: credentials.listCredentialOperations(this.ctx),
      settings: settings.settingsCached(this.ctx), bots: this.listBots(), sessions: this.listSessions(),
      approvals: this.listApprovals(), mcpServers: this.listMcpServers(),
      providers: providers.providersCached(this.ctx),
      skills: skills.listSkills(this.ctx).map((skill) => skills.withLearning(this.ctx, skill)),
      memories: memories.listMemories(this.ctx).map((memory) => memories.withLearning(this.ctx, memory)),
      routines: this.listRoutines(), allowRules: this.listAllowRules(),
      // Only once holds are on: a client reads the field's presence as "stops can be made here".
      ...(readEngineLevel(this.db) >= ENGINE_LEVELS.holds ? { holds: holds.listHolds(this.ctx, { inForce: true }) } : {}),
      // A line of yours in a direct reaches the working Bot at its next step, so the composer stays
      // open (ADR 0040 P4a). A client reads the field's presence as that.
      turnInbox: true as const,
      // Your lines in a conversation are taken in the order they came, so Send stays open while the
      // last one is read; and a line of yours can be changed after it went out (ADR 0063).
      linesInOrder: true as const,
      messageEdits: true as const,
      notificationSummary: notifications.getNotificationSummary(this.ctx),
      notificationPolicy: notifications.getNotificationPolicy(this.ctx),
    };
  }

  // Settings & endpoints -------------------------------------------------------------------
  readonly settings = this.bind(settings.settings, true);
  readonly patchSettings = this.bind(settings.patchSettings, true);
  readonly endpointKey = this.bind(settings.endpointKey, true);
  readonly workspacePath = this.bind(workspacePath);
  readonly defaultProviderId = this.bind(defaultProviderId);
  readonly listProviders = this.bind(providers.listProviders, true);
  readonly getProvider = this.bind(providers.getProvider, true);
  readonly createProvider = this.bind(providers.createProvider, true);
  readonly patchProvider = this.bind(providers.patchProvider, true);
  readonly deleteProvider = this.bind(providers.deleteProvider, true);
  readonly catalogEntries = this.bind(providers.catalogEntries);

  // Roster ---------------------------------------------------------------------------------
  readonly listBots = this.bind(bots.listBots);
  readonly getBot = this.bind(bots.getBot);
  readonly createBot = this.bind(bots.createBot);
  readonly patchBot = this.bind(bots.patchBot);
  readonly archiveBot = this.bind(bots.archiveBot);
  readonly restoreBot = this.bind(bots.restoreBot);
  readonly deleteBot = this.bind(bots.deleteBot);
  readonly listProfileRevisions = this.bind(bots.listProfileRevisions);
  readonly attachLatestRevisionMessage = this.bind(bots.attachLatestRevisionMessage);
  readonly findBotByName = this.bind(bots.findBotByName);
  readonly requireBotByName = this.bind(bots.requireBotByName);

  // Per-Bot memory, procedures and calendar -------------------------------------------------
  readonly listMemories = this.bind(memories.listMemories);
  readonly listEnabledMemories = this.bind(memories.listEnabledMemories);
  readonly getMemory = this.bind(memories.getMemory);
  readonly findMemoryBySubject = this.bind(memories.findMemoryBySubject);
  readonly sessionMemoriesSince = this.bind(memories.sessionMemoriesSince);
  readonly rememberMemory = this.bind(memories.rememberMemory);
  readonly patchMemory = this.bind(memories.patchMemory);
  readonly deleteMemory = this.bind(memories.deleteMemory);
  readonly listSkills = this.bind(skills.listSkills);
  readonly listEnabledSkills = this.bind(skills.listEnabledSkills);
  readonly getSkill = this.bind(skills.getSkill);
  readonly findSkillByName = this.bind(skills.findSkillByName);
  readonly createSkill = this.bind(skills.createSkill);
  readonly patchSkill = this.bind(skills.patchSkill);
  readonly deleteSkill = this.bind(skills.deleteSkill);
  readonly listRoutines = this.bind(routines.listRoutines);
  readonly createRoutine = this.bind(routines.createRoutine);
  readonly patchRoutine = this.bind(routines.patchRoutine);
  readonly deleteRoutine = this.bind(routines.deleteRoutine);
  readonly getRoutine = this.bind(routines.getRoutine);
  readonly claimRoutineDue = this.bind(routines.claimRoutineDue);
  readonly routineDue = this.bind(routines.routineDue);

  // Work dirs ------------------------------------------------------------------------------
  readonly getTask = this.bind(tasks.getTask);
  readonly openTask = this.bind(tasks.openTask);
  readonly closeTask = this.bind(tasks.closeTask);
  readonly taskOfTurn = this.bind(tasks.taskOfTurn);
  readonly turnWorkDir = this.bind(tasks.turnWorkDir);
  readonly tasksClosedBefore = this.bind(tasks.tasksClosedBefore);
  readonly taskArtifacts = this.bind(tasks.taskArtifacts);
  readonly taskTrace = this.bind(tasks.taskTrace);
  readonly sessionTasks = this.bind(tasks.sessionTasks);
  readonly sessionCurrentTask = this.bind(tasks.sessionCurrentTask);
  readonly sessionRecentTasks = this.bind(tasks.sessionRecentTasks);
  readonly elsewherePlans = this.bind(tasks.elsewherePlans);
  readonly taskHasEarlierTurns = this.bind(tasks.taskHasEarlierTurns);
  readonly taskLiveTurnCount = this.bind(tasks.taskLiveTurnCount);
  readonly taskArtifactsSince = this.bind(tasks.taskArtifactsSince);
  readonly taskMessagesSince = this.bind(tasks.taskMessagesSince);
  readonly taskUserLines = this.bind(tasks.taskUserLines);
  readonly setTaskSpec = this.bind(tasks.setTaskSpec);
  readonly routineTask = this.bind(tasks.routineTask);
  readonly distinctTaskKinds = this.bind(tasks.distinctTaskKinds);
  readonly turnPlanDir = this.bind(tasks.turnPlanDir);
  readonly taskSummary = this.bind(tasks.taskSummary);
  readonly taskLastActivityAt = this.bind(tasks.taskLastActivityAt);
  readonly resolveTurnTask = this.bind(tasks.resolveTurnTask);
  readonly lastUserLineAt = this.bind(tasks.lastUserLineAt);

  // Tickets and plan specs ---------------------------------------------------------------
  readonly createTicket = this.bind(tickets.createTicket);
  readonly getTicket = this.bind(tickets.getTicket);
  readonly listTickets = this.bind(tickets.listTickets);
  readonly listTicketParts = this.bind(tickets.listTicketParts);
  readonly patchTicket = this.bind(tickets.patchTicket);
  readonly ticketOfTurn = this.bind(tickets.ticketOfTurn);
  readonly observeTicketWork = this.bind(tickets.observeTicketWork);
  readonly recordTurnRun = this.bind(turnRuns.recordTurnRun);
  readonly turnRuns = this.bind(turnRuns.turnRuns);
  readonly turnCommands = this.bind(turnRuns.turnCommands);
  readonly taskRunsSince = this.bind(turnRuns.taskRunsSince);
  readonly ticketArtifacts = this.bind(tickets.ticketArtifacts);
  readonly listTicketDirs = this.bind(tickets.listTicketDirs);
  readonly listSpecRevisions = this.bind(planSpec.listSpecRevisions);
  readonly currentRevision = this.bind(planSpec.currentRevision);
  readonly lastSpecRevisionAt = this.bind(planSpec.lastSpecRevisionAt);
  readonly userWrittenSpec = this.bind(planSpec.userWrittenSpec);
  readonly recordSpecRevision = this.bind(planSpec.recordSpecRevision);
  readonly setPlanSpecByUser = this.bind(planSpec.setPlanSpecByUser);
  readonly renamePlanByUser = this.bind(planSpec.renamePlanByUser);
  readonly patchTicketByUser = this.bind(planSpec.patchTicketByUser);
  readonly applyOrganizerResult = this.bind(planSpec.applyOrganizerResult);
  readonly taskDetail = this.bind(planSpec.taskDetail);
  readonly ticketHandedOverSince = this.bind(planSpec.ticketHandedOverSince);

  // Organizer runs (ADR 0040 P0 observability) ----------------------------------------------
  readonly recordOrganizerRun = this.bind(organizerRuns.recordOrganizerRun);
  readonly organizerRunsForTask = this.bind(organizerRuns.organizerRunsForTask);

  // Acceptance checks (可执行验收) ----------------------------------------------------------
  readonly getCheck = this.bind(acceptanceChecks.getCheck);
  readonly getCheckRun = this.bind(acceptanceChecks.getCheckRun);
  readonly listChecks = this.bind(acceptanceChecks.listChecks);
  readonly normalizeCheckInput = this.bind(acceptanceChecks.normalizeCheckInput);
  readonly createCheckByUser = this.bind(acceptanceChecks.createCheckByUser);
  readonly patchCheckByUser = this.bind(acceptanceChecks.patchCheckByUser);
  readonly removeCheckByUser = this.bind(acceptanceChecks.removeCheckByUser);
  readonly checkStale = this.bind(acceptanceChecks.checkStale);
  readonly checksHoldingPlanOpen = this.bind(acceptanceChecks.checksHoldingPlanOpen);
  readonly beginCheckRun = this.bind(acceptanceChecks.beginCheckRun);
  readonly finishCheckRun = this.bind(acceptanceChecks.finishCheckRun);
  readonly markCheckRunJudgedBy = this.bind(acceptanceChecks.markCheckRunJudgedBy);
  readonly recoverInterruptedCheckRuns = this.bind(acceptanceChecks.recoverInterruptedCheckRuns);
  readonly rebindCheckItems = this.bind(acceptanceChecks.rebindCheckItems);
  readonly commandSeenInPlan = this.bind(acceptanceChecks.commandSeenInPlan);
  readonly pathSeenInPlan = this.bind(acceptanceChecks.pathSeenInPlan);
  readonly syncDerivedChecks = this.bind(derivedChecks.syncDerivedChecks);
  readonly confirmDerivedCheck = this.bind(derivedChecks.confirmDerivedCheck);

  // Check-backs ----------------------------------------------------------------------------
  readonly scheduleCheckBack = this.bind(checkBacks.scheduleCheckBack);
  readonly bookReportBack = this.bind(checkBacks.bookReportBack);
  readonly quietDirect = this.bind(checkBacks.quietDirect);
  readonly getCheckBack = this.bind(checkBacks.getCheckBack);
  readonly pendingCheckBack = this.bind(checkBacks.pendingCheckBack);
  readonly listPendingCheckBacks = this.bind(checkBacks.listPendingCheckBacks);
  readonly bookPlanNudge = this.bind(checkBacks.bookPlanNudge);
  readonly voidRetiredCallBack = this.bind(checkBacks.voidRetiredCallBack);
  readonly lastPlanNudge = this.bind(checkBacks.lastPlanNudge);
  readonly planNudgesSince = this.bind(checkBacks.planNudgesSince);
  readonly pendingPlanCheckBacks = this.bind(checkBacks.pendingPlanCheckBacks);
  readonly dueCheckBacks = this.bind(checkBacks.dueCheckBacks);
  readonly claimCheckBack = this.bind(checkBacks.claimCheckBack);
  readonly markCheckBackFired = this.bind(checkBacks.markCheckBackFired);
  readonly returnUnreadCheckBack = this.bind(checkBacks.returnUnreadCheckBack);
  readonly recordCheckBackLine = this.bind(checkBacks.recordCheckBackLine);
  readonly repeatsPlanAnswer = this.bind(checkBacks.repeatsPlanAnswer);
  readonly voidCheckBacks = this.bind(checkBacks.voidCheckBacks);

  // Holds (叫停) ----------------------------------------------------------------------------
  readonly createHold = this.bind(holds.createHold);
  readonly liftHold = this.bind(holds.liftHold);
  readonly cancelHolds = this.bind(holds.cancelHolds);
  readonly getHold = this.bind(holds.getHold);
  readonly listHolds = this.bind(holds.listHolds);
  readonly holdsCovering = this.bind(holds.holdsCovering);
  readonly turnHeldBy = this.bind(holds.turnHeldBy);
  readonly suspendHeldCheckBacks = this.bind(holds.suspendHeldCheckBacks);
  readonly addHoldEffect = this.bind(holds.addEffect);
  readonly reconcileHolds = this.bind(holds.reconcileHolds);

  // A working Bot's inbox (ADR 0040 P4a) ------------------------------------------------------
  readonly queueInboxItem = this.bind(inbox.queueInboxItem);
  readonly getInboxItem = this.bind(inbox.getInboxItem);
  readonly turnInbox = this.bind(inbox.turnInbox);
  readonly adoptWaitingInbox = this.bind(inbox.adoptWaitingInbox);
  readonly deliverInboxItems = this.bind(inbox.deliverInboxItems);
  readonly queuedForTurn = this.bind(inbox.queuedForTurn);
  readonly releaseTurnInbox = this.bind(inbox.releaseTurnInbox);
  readonly releaseEndedInbox = this.bind(inbox.releaseEndedInbox);
  readonly holdInboxItems = this.bind(inbox.holdInboxItems);
  readonly refreshHeldInbox = this.bind(inbox.refreshHeldInbox);
  readonly supersedeInboxItems = this.bind(inbox.supersedeInboxItems);
  readonly disposeInboxItems = this.bind(inbox.disposeInboxItems);

  // Work items (ADR 0040 P4b) -------------------------------------------------------------
  readonly findOrCreateWorkItem = this.bind(workItems.findOrCreateWorkItem);
  readonly workOn = this.bind(workOn.workOn);
  readonly bindToOwnTicket = this.bind(workOn.bindToOwnTicket);
  readonly workItemQueuePlace = this.bind(workItems.queuePlace);
  readonly queueWork = this.bind(workItems.queueWork);
  readonly dispatchableWork = this.bind(workItems.dispatchableWork);
  readonly prepareQueuedTrigger = this.bind(workItems.prepareQueuedTrigger);
  readonly markWorkRunning = this.bind(workItems.markWorkRunning);
  readonly markSegmentCutOff = this.bind(workItems.markSegmentCutOff);
  readonly settleEndedSegment = this.bind(workItems.settleEndedSegment);
  readonly isPlanRunnable = this.bind(workItems.isPlanRunnable);
  readonly hasWorkAuthority = this.bind(workItems.hasWorkAuthority);
  readonly fileMessage = this.bind(filing.fileMessage);
  readonly lineToFile = this.bind(filing.lineToFile);
  readonly lineReadAsNew = this.bind(filing.lineReadAsNew);
  readonly planCandidates = this.bind(filing.planCandidates);
  readonly lineCandidates = this.bind(filing.lineCandidates);
  readonly planCandidateEvidence = this.bind(filing.candidateOf);
  readonly filingsOfMessage = this.bind(filing.filingsOfMessage);
  readonly deskCandidateIds = this.bind(desk.deskCandidateIds);
  readonly jobConversations = this.bind(jobConversations.jobConversations);
  readonly spokenFor = this.bind(jobConversations.spokenFor);
  readonly assertDeskCandidate = this.bind(desk.assertDeskCandidate);
  readonly noteFilingBounce = this.bind(desk.noteFilingBounce);
  readonly filingBudget = this.bind(desk.filingBudget);
  readonly originalUserRequest = this.bind(desk.originalUserRequest);
  readonly markNeedsAttention = this.bind(desk.markNeedsAttention);
  readonly markWorkDirectoryUsed = this.bind(desk.markWorkDirectoryUsed);
  readonly finishWork = this.bind(endContract.finishWork);
  readonly segmentLastWord = this.bind(endContract.segmentLastWord);
  readonly goAheadRefused = this.bind(endContract.goAheadRefused);
  readonly endAfterSubmit = this.bind(endContract.endAfterSubmit);
  readonly prepareSubmission = this.bind(submissions.prepareSubmission);
  readonly settleSubmissionChecks = this.bind(submissions.settleSubmissionChecks);
  readonly reviewSubmission = this.bind(submissions.reviewSubmission);
  readonly reviewTarget = this.bind(submissions.reviewTarget);
  readonly getSubmission = this.bind(submissions.getSubmission);
  readonly listSubmissions = this.bind(submissions.listSubmissions);
  readonly submissionCheckIds = this.bind(submissions.boundCheckIds);
  readonly submissionCheckResults = this.bind(submissions.checkResults);
  readonly implicitSubmissionPaths = this.bind(submissions.implicitSubmissionPaths);
  readonly recordFrameRead = this.bind(submissions.recordFrameRead);
  readonly requiredReviewItems = this.bind(submissions.requiredItems);
  readonly answerReviewCard = this.bind(submissions.answerReviewCard);
  readonly noteComplaint = this.bind(submissions.noteComplaint);
  readonly answerReworkCard = this.bind(submissions.answerReworkCard);
  readonly reviewMisses = this.bind(submissions.reviewMisses);
  readonly answerCeilingCard = this.bind(submissions.answerCeilingCard);
  readonly jobsOn = this.bind(externalJobs.jobsOn);
  readonly recentJob = this.bind(externalJobs.recentJob);
  readonly partJob = this.bind(externalJobs.partJob);
  readonly registerJob = this.bind(externalJobs.registerJob);
  readonly jobForRequest = this.bind(externalJobs.jobForRequest);
  readonly addJobWaiter = this.bind(externalJobs.addJobWaiter);
  readonly claimDueJobs = this.bind(externalJobs.claimDueJobs);
  readonly recordJobPoll = this.bind(externalJobs.recordJobPoll);
  readonly pendingJobNamed = this.bind(externalJobs.pendingJobNamed);
  readonly getJob = this.bind(externalJobs.getJob);
  readonly routingOn = this.bind(modelDefaults.routingOn);
  readonly turnTicketModel = this.bind(modelDefaults.turnTicketModel);
  readonly modelLadder = this.bind(modelLadder.modelLadder);
  readonly setModelLadder = this.bind(modelLadder.setModelLadder);
  /** Where you pointed the daemon at your own `claude` (ADR 0061); null lets it look for one. */
  readonly claudeCodePath = this.bind(claudeCode.claudeCodePath);
  readonly setClaudeCodePath = this.bind(claudeCode.setClaudeCodePath);
  readonly botDefault = this.bind(modelDefaults.botDefault);
  readonly ensureBotDefault = this.bind(modelDefaults.ensureBotDefault);
  readonly noteModelOnce = this.bind(modelDefaults.noteModelOnce);
  readonly turnNeedsPictures = this.bind(modelDefaults.turnNeedsPictures);
  readonly workEscalation = this.bind(escalation.workEscalation);
  readonly stepUpForTrouble = this.bind(escalation.stepUpForTrouble);
  readonly workTroubleSteps = this.bind(escalation.workTroubleSteps);
  readonly learningOn = this.bind(quality.learningOn);
  readonly listQualityEvents = this.bind(quality.listQualityEvents);
  readonly qualityReport = this.bind(quality.qualityReport);
  readonly markTurnModel = this.bind(quality.markTurnModel);
  readonly turnMarkedModel = this.bind(quality.turnMarkedModel);
  readonly checkShellLesson = this.bind(lessons.checkShellLesson);
  readonly noteShellTimeout = this.bind(lessons.noteShellTimeout);
  readonly listLessons = this.bind(lessons.listLessons);
  readonly getLesson = this.bind(lessons.getLesson);
  readonly updateLesson = this.bind(lessons.updateLesson);
  readonly lessonCard = this.bind(lessons.lessonCard);
  readonly claimDueReflection = this.bind(reflection.claimDueReflection);
  readonly recordReflection = this.bind(reflection.recordReflection);
  readonly answerLessonCard = this.bind(reflection.answerLessonCard);
  readonly checklistFor = this.bind(reflection.checklistFor);
  readonly claimDueRetrospective = this.bind(retrospectives.claimDueRetrospective);
  readonly recordRetrospective = this.bind(retrospectives.recordRetrospective);
  readonly undoRetrospectiveChange = this.bind(retrospectives.undoRetrospectiveChange);
  readonly getRetrospective = this.bind(retrospectives.getRetrospective);
  readonly listRetrospectives = this.bind(retrospectives.listRetrospectives);
  // Built-in prompts you edited (ADR 0064); what a slot is lives in prompts/registry.ts.
  readonly listPromptOverrides = this.bind(prompts.listPromptOverrides);
  readonly promptOverride = this.bind(prompts.promptOverride);
  readonly promptHead = this.bind(prompts.promptHead);
  readonly listPromptRevisions = this.bind(prompts.listPromptRevisions);
  readonly promptRevision = this.bind(prompts.promptRevision);
  readonly promptRevisionByApproval = this.bind(prompts.promptRevisionByApproval);
  readonly writePrompt = this.bind(prompts.writePrompt);
  readonly markPromptConflict = this.bind(prompts.markPromptConflict);
  readonly clearPromptConflict = this.bind(prompts.clearPromptConflict);
  readonly notePromptParseFailure = this.bind(prompts.notePromptParseFailure);
  readonly promptParseFailures = this.bind(prompts.promptParseFailures);
  readonly promptRevisionSource = this.bind(prompts.promptRevisionSource);
  /** Your edits as a prompt page reads them (prompts/book.ts). */
  promptOverrides(): Array<{ prompt_id: string; locale: "zh" | "en"; text: string; revision_id: string }> {
    return prompts.listPromptOverrides(this.ctx).map((row) => ({ prompt_id: row.prompt_id, locale: row.locale, text: row.text, revision_id: row.revision_id }));
  }
  readonly listSharedSkills = this.bind(sharedSkills.listSharedSkills);
  readonly getSharedSkill = this.bind(sharedSkills.getSharedSkill);
  readonly sharedSkillsFor = this.bind(sharedSkills.sharedSkillsFor);
  readonly findSharedSkillByName = this.bind(sharedSkills.findSharedSkillByName);
  readonly shareSkill = this.bind(sharedSkills.shareSkill);
  readonly setSharedSkillEnabled = this.bind(sharedSkills.setSharedSkillEnabled);
  readonly unshareSkill = this.bind(sharedSkills.unshareSkill);
  readonly planItems = this.bind(planItemsModule.planItems);
  // Large jobs (大活, ADR 0060): the plan's size, its sample and what waits for it.
  readonly planScale = this.bind(largeJobs.planScale);
  readonly markPlanScale = this.bind(largeJobs.markPlanScale);
  readonly largeJobRefusal = this.bind(largeJobs.largeJobRefusal);
  readonly layoutMissing = this.bind(largeJobs.layoutMissing);
  readonly sampleOf = this.bind(largeJobs.sampleOf);
  readonly waitingOn = this.bind(largeJobs.waitingOn);
  readonly signalFacts = this.bind(largeJobs.signalFacts);
  readonly standardSides = this.bind(largeJobs.standardSides);
  readonly scaleInputs = this.bind(largeJobs.scaleInputs);
  readonly signalledPlans = this.bind(largeJobs.signalledPlans);
  /** 「新开一件事」: the line opens a job of its own and is filed there; the message as it now stands. */
  readonly newJobFromLine = (messageId: string, input: { title?: string | null; userActionId: string }) => this.transaction(() => {
    newJobModule.newJobFromLine(this.ctx, messageId, input);
    return messages.getMessage(this.ctx, messageId);
  });
  readonly answerModelDefaultCard = this.bind(modelDefaults.answerModelDefaultCard);
  readonly visionRefusal = this.bind(submissions.visionRefusal);
  readonly takeUpSubmission = this.bind(submissions.takeUpSubmission);
  readonly takeUpPendingApproval = this.bind(submissions.takeUpPendingApproval);
  readonly handOverHint = this.bind(submissions.handOverHint);
  readonly answerHint = this.bind(submissions.answerHint);
  readonly noteBoardStatus = this.bind(submissions.noteBoardStatus);
  readonly createWorkQuestion = this.bind(workQuestions.createWorkQuestion);
  readonly answerWorkQuestion = this.bind(workQuestions.answerWorkQuestion);
  readonly beginToolExecution = this.bind(toolExecutions.beginToolExecution);
  readonly finishToolExecution = this.bind(toolExecutions.finishToolExecution);
  readonly getToolExecution = this.bind(toolExecutions.getToolExecution);
  readonly pendingToolExecutions = this.bind(toolExecutions.pendingToolExecutions);
  readonly executionRecoveryFacts = this.bind(toolExecutions.executionRecoveryFacts);
  readonly ballHolder = this.bind(supervisor.ballHolder);
  readonly planLead = this.bind(supervisor.planLead);
  readonly supervisorTick = this.bind(supervisor.supervisorTick);
  readonly recordSupervisorRestart = this.bind(supervisor.recordSupervisorRestart);
  readonly settleRestartNotices = this.bind(supervisor.settleRestartNotices);
  readonly workLeftByEarlierRestart = () => supervisor.workLeftByEarlierRestart(this.ctx, this.bootId);
  readonly supervisorTakesUp = this.bind(supervisor.supervisorTakesUp);
  readonly refuseSupervisorPickup = this.bind(supervisor.refuseSupervisorPickup);
  readonly recordArtifactProgress = this.bind(supervisor.recordArtifactProgress);
  readonly recordPeerNote = this.bind(peerNotes.recordPeerNote);
  readonly progressMessagesSent = this.bind(peerNotes.progressMessagesSent);
  readonly uncitedTurnPaths = this.bind(peerNotes.uncitedTurnPaths);
  readonly delegateWork = this.bind(delegations.delegateWork);
  readonly getDelegation = this.bind(delegations.getDelegation);
  readonly listDelegations = this.bind(delegations.listDelegations);
  readonly getDelegationWait = this.bind(delegations.getDelegationWait);
  readonly replyDelegation = this.bind(delegations.replyDelegation);
  readonly cancelDelegation = this.bind(delegations.cancelDelegation);
  readonly cancelDelegationsForBot = this.bind(delegations.cancelDelegationsForBot);
  readonly cancelDelegationsForSession = this.bind(delegations.cancelDelegationsForSession);
  readonly delegationDescendants = this.bind(delegations.delegationDescendants);
  readonly delegationCascadeTargets = this.bind(delegations.delegationCascadeTargets);
  readonly createNewPlanCard = this.bind(newPlanCards.createNewPlanCard);
  readonly recordNewPlanEffectStarted = this.bind(newPlanCards.recordNewPlanEffectStarted);
  readonly actNewPlanCard = this.bind(newPlanCards.actNewPlanCard);
  readonly refileMessage = (messageId: string, input: filing.RefileMessageInput) => this.transaction(() => {
    filing.refileMessage(this.ctx, messageId, input);
    return messages.getMessage(this.ctx, messageId);
  });
  readonly updatePlanDormancy = this.bind(filing.updatePlanDormancy);
  // Changing a line of yours after it went out (ADR 0063).
  readonly editMessage = this.bind(messageEdits.editMessage);
  readonly messageVersions = this.bind(messageEdits.messageVersions);
  readonly markLineTaken = this.bind(messageEdits.markLineTaken);
  readonly clearLineTaken = this.bind(messageEdits.clearLineTaken);
  readonly resumePlan = this.bind(filing.resumePlan);
  readonly closeWorkItemIfIdle = this.bind(workItems.closeWorkItemIfIdle);

  // Work log -------------------------------------------------------------------------------
  readonly recordWorkEvent = this.bind(workEvents.recordWorkEvent);
  readonly listWorkEvents = this.bind(workEvents.listWorkEvents);

  // Your words and the requirements ledger (ADR 0040) ---------------------------------------
  readonly listQuotes = this.bind(quotes.listQuotes);
  readonly getQuote = this.bind(quotes.getQuote);
  readonly quoteOfMessage = this.bind(quotes.quoteOfMessage);
  readonly quoteScribed = this.bind(quotes.quoteScribed);
  readonly addRequirement = this.bind(requirements.addRequirement);
  readonly raiseRequirement = this.bind(requirements.raiseRequirement);
  readonly getRequirement = this.bind(requirements.getRequirement);
  readonly listRequirements = this.bind(requirements.listRequirements);
  readonly requirementMentions = this.bind(requirements.requirementMentions);
  readonly purgeRequirements = this.bind(requirements.purgeRequirements);
  readonly openRequirementsFor = this.bind(requirements.openRequirementsFor);
  readonly requirementsBearingOn = this.bind(requirements.requirementsBearingOn);
  readonly planDomains = this.bind(requirements.planDomains);
  readonly confirmRequirement = this.bind(requirements.confirmRequirement);
  readonly rejectRequirement = this.bind(requirements.rejectRequirement);
  readonly waiveRequirement = this.bind(requirements.waiveRequirement);
  readonly widenRequirement = this.bind(requirements.widenRequirement);
  readonly setRequirementHere = this.bind(requirements.setRequirementHere);
  readonly planRequirements = this.bind(planRequirements.planRequirements);
  readonly importLegacyRules = this.bind(planRequirements.importLegacyRules);
  readonly mayMakeStanding = this.bind(planRequirements.mayMakeStanding);
  readonly applyScribePatch = this.bind(scribePatch.applyScribePatch);
  readonly captureComplaint = this.bind(scribePatch.captureComplaint);
  readonly plansHandedOver = this.bind(scribePatch.plansHandedOver);

  // Sessions -------------------------------------------------------------------------------
  readonly ensureFileDropSession = this.bind(sessions.ensureFileDropSession);
  readonly listSessions = this.bind(sessions.listSessions);
  readonly getSession = this.bind(sessions.getSession);
  readonly markSessionRead = this.bind(sessions.markSessionRead);
  readonly createGroup = this.bind(sessions.createGroup);
  readonly renameSession = this.bind(sessions.renameSession);
  readonly archiveSession = this.bind(sessions.archiveSession);
  readonly restoreSession = this.bind(sessions.restoreSession);
  readonly deleteSession = this.bind(sessions.deleteSession);
  readonly clearSessionMessages = this.bind(sessions.clearSessionMessages);
  readonly addMember = this.bind(sessions.addMember);
  readonly removeMember = this.bind(sessions.removeMember);
  readonly listParticipants = this.bind(sessions.listParticipants);
  readonly presentParticipants = this.bind(sessions.presentParticipants);
  readonly isPresent = this.bind(sessions.isPresent);
  readonly presentBotIds = this.bind(sessions.presentBotIds);
  readonly findDirectSession = this.bind(sessions.findDirectSession);
  readonly createDirect = this.bind(sessions.createDirect);
  readonly createBotDirect = this.bind(sessions.createBotDirect);
  readonly unreadCount = this.bind(sessions.unreadCount);

  // Annotations ----------------------------------------------------------------------------
  readonly listAnnotations = this.bind(annotations.listAnnotations);
  readonly getAnnotation = (id: string) => annotations.getAnnotation(this.ctx, id);
  readonly annotationCrop = this.bind(annotations.annotationCrop);
  readonly annotationsOfMessage = this.bind(annotations.annotationsOfMessage);
  readonly openAnnotationCount = this.bind(annotations.openAnnotationCount);
  readonly createAnnotation = this.bind(annotations.createAnnotation);
  readonly patchAnnotation = this.bind(annotations.patchAnnotation);
  readonly deleteAnnotation = this.bind(annotations.deleteAnnotation);
  readonly resolveAnnotationByBot = this.bind(annotations.resolveAnnotationByBot);
  readonly sendAnnotations = (...args: Parameters<Bound<typeof annotations.sendAnnotations>>) => annotations.sendAnnotations(this.ctx, ...args);

  // Terminals you opened. The process dies with the daemon; the row is what the next one starts. --
  readonly listKeptTerminals = this.bind(terminals.listKeptTerminals);
  readonly rememberTerminal = this.bind(terminals.rememberTerminal);
  readonly forgetTerminal = this.bind(terminals.forgetTerminal);

  // Commands still running, by boot; see live-procs.ts for why ------------------------------
  readonly registerLiveProc = this.bind(liveProcs.registerLiveProc);
  readonly noteLiveProcStart = this.bind(liveProcs.noteLiveProcStart);
  readonly forgetLiveProc = this.bind(liveProcs.forgetLiveProc);
  readonly liveProcsFromOtherBoots = this.bind(liveProcs.liveProcsFromOtherBoots);

  // Transcript -----------------------------------------------------------------------------
  readonly listMessages = this.bind(messages.listMessages);
  readonly postMessage = (...args: Parameters<Bound<typeof messages.postMessage>>) => messages.postMessage(this.ctx, ...args);
  readonly assertUserMayPost = this.bind(messages.assertUserMayPost);
  readonly insertMessage = this.bind(messages.insertMessage);
  readonly getMessage = this.bind(messages.getMessage);
  readonly setMessageControl = this.bind(messages.setMessageControl);
  readonly recordAskAnswer = this.bind(messages.recordAskAnswer);
  readonly listMainMessages = this.bind(messages.listMainMessages);
  readonly listThreadMessages = this.bind(messages.listThreadMessages);
  readonly putReaction = this.bind(messages.putReaction);
  readonly deleteReaction = this.bind(messages.deleteReaction);
  readonly getAttachment = this.bind(messages.getAttachment);
  readonly resolveAttachmentLocation = this.bind(messages.resolveAttachmentLocation);
  readonly getAttachmentFilePath = this.bind(messages.getAttachmentFilePath);
  readonly citedPathExists = this.bind(messages.citedPathExists);

  // Turns, approvals, interrupts -----------------------------------------------------------
  readonly createTurn = this.bind(turns.createTurn);
  readonly lineTicketFor = this.bind(turns.lineTicketFor);
  readonly turnLanding = this.bind(turns.turnLanding);
  readonly getTurn = this.bind(turns.getTurn);
  readonly listLiveTurns = this.bind(turns.listLiveTurns);
  readonly setTurnStatus = this.bind(turns.setTurnStatus);
  readonly touchTurn = this.bind(turns.touchTurn);
  readonly setTurnPartial = this.bind(turns.setTurnPartial);
  readonly redirectTurn = this.bind(turns.redirectTurn);
  readonly stopTurn = this.bind(turns.stopTurn);
  readonly latestStoppableTurn = this.bind(turns.latestStoppableTurn);
  readonly interruptRunningTurns = this.bind(turns.interruptRunningTurns);
  readonly interruptTurnRecord = this.bind(turns.interruptTurnRecord);
  readonly voidPendingTurnActions = this.bind(turns.voidPendingTurnActions);
  readonly claimInterruptContinue = this.bind(turns.claimInterruptContinue);
  readonly pendingInterrupt = this.bind(turns.pendingInterrupt);
  readonly markInterruptPending = this.bind(turns.markInterruptPending);
  readonly clearInterruptPending = this.bind(turns.clearInterruptPending);
  /** Boot recovery; what the last run left live is remembered as cut off by its end. */
  readonly recoverInterruptedTurns = (): void => turns.recoverInterruptedTurns(this.ctx, this.previousBootId);
  /** Remembers every live turn as cut off by this run's end, now under way. */
  readonly noteTurnsCutByShutdown = (): void => turns.noteTurnsCutByShutdown(this.ctx, this.bootId);
  readonly forgetTurnsCutByShutdown = this.bind(turns.forgetTurnsCutByShutdown);
  /** At boot: what the end of the run before this one cut off (a record left by any other run is stale). */
  readonly takeTurnsCutByRestart = () => turns.takeTurnsCutByRestart(this.ctx, this.previousBootId);
  readonly insertApproval = this.bind(approvals.insertApproval);
  readonly getApproval = this.bind(approvals.getApproval);
  readonly listApprovals = this.bind(approvals.listApprovals);
  readonly resolveApproval = this.bind(approvals.resolveApproval);
  readonly listAllowRules = this.bind(approvals.listAllowRules);
  readonly createAllowRule = this.bind(approvals.createAllowRule);
  readonly deleteAllowRule = this.bind(approvals.deleteAllowRule);
  readonly matchesAllowRule = this.bind(approvals.matchesAllowRule);

  // Spend & judgements ---------------------------------------------------------------------
  readonly insertSpend = this.bind(spend.insertSpend);
  readonly listSpend = this.bind(spend.listSpend);
  readonly spendSummary = this.bind(spend.spendSummary);
  readonly spendPage = this.bind(spend.spendPage);
  readonly insertJudgement = this.bind(judgements.insertJudgement);
  readonly listJudgements = this.bind(judgements.listJudgements);

  // Model choice per turn and what each Bot learns from it ---------------------------------
  readonly decideTurnRoute = this.bind(routing.decideTurnRoute);
  readonly recordTurnRoute = this.bind(routing.recordTurnRoute);
  readonly finishTurnRoute = this.bind(routing.finishTurnRoute);
  readonly stepTurnRoute = this.bind(routing.stepTurnRoute);
  readonly getTurnRoute = this.bind(routing.getTurnRoute);
  readonly listSessionRoutes = this.bind(routing.listSessionRoutes);
  readonly listTaskRoutes = this.bind(routing.listTaskRoutes);
  readonly listRouteFeedback = this.bind(routing.listRouteFeedback);
  readonly collectRouteFeedback = this.bind(routing.collectRouteFeedback);
  readonly forgetBotRoutes = this.bind(routing.forgetBotRoutes);
  readonly openChain = this.bind(routing.openChain);
  readonly unreviewedChainOf = this.bind(routing.unreviewedChainOf);
  readonly staleOpenChains = this.bind(routing.staleOpenChains);
  readonly recentOpenChains = this.bind(routing.recentOpenChains);
  readonly chainForReview = this.bind(routing.chainForReview);
  readonly recordRouteReview = this.bind(routing.recordRouteReview);
  readonly recentRouteReviews = this.bind(routing.recentRouteReviews);
  readonly reviewEffect = this.bind(routing.reviewEffect);
  readonly cleanCompletions = this.bind(routing.cleanCompletions);
  readonly listSessionReviews = this.bind(routing.listSessionReviews);
  readonly listTaskReviews = this.bind(routing.listTaskReviews);
  readonly recordRouteLearning = this.bind(routing.recordRouteLearning);
  readonly listSessionLearnings = this.bind(routing.listSessionLearnings);
  readonly listTaskLearnings = this.bind(routing.listTaskLearnings);
  readonly learningOutcome = this.bind(routing.learningOutcome);
  readonly memoryWithLearning = this.bind(memories.withLearning);
  readonly skillWithLearning = this.bind(skills.withLearning);
  readonly feedbackOwner = this.bind(routing.feedbackOwner);
  readonly previousDecisionFor = this.bind(routing.previousDecisionFor);
  readonly routeCandidates = this.bind(routing.routeCandidates);

  // MCP ------------------------------------------------------------------------------------
  readonly listMcpServers = this.bind(mcp.listMcpServers);
  readonly listMcpServersHydrated = this.bind(mcp.listMcpServersHydrated, true);
  readonly mcpAuth = this.bind(mcp.mcpAuth, true);
  readonly createMcpServer = this.bind(mcp.createMcpServer, true);
  readonly patchMcpServer = this.bind(mcp.patchMcpServer, true);
  readonly deleteMcpServer = this.bind(mcp.deleteMcpServer, true);

  // Search ---------------------------------------------------------------------------------
  readonly search = this.bind(search.search);

  // Notifications -------------------------------------------------------------------------
  readonly createNotification = this.bind(notifications.createNotification);
  readonly getNotification = this.bind(notifications.getNotification);
  readonly getNotificationRow = this.bind(notifications.getNotificationRow);
  readonly getNotificationBySemanticKey = this.bind(notifications.getNotificationBySemanticKey);
  readonly updateNotificationActionState = this.bind(notifications.updateNotificationActionState);
  readonly markNotificationRead = this.bind(notifications.markNotificationRead);
  readonly markNotificationsReadBatch = this.bind(notifications.markNotificationsReadBatch);
  readonly markNotificationsReadThroughMessage = this.bind(notifications.markNotificationsReadThroughMessage);
  readonly acknowledgeNotification = this.bind(notifications.acknowledgeNotification);
  readonly listNotifications = this.bind(notifications.listNotifications);
  readonly getNotificationSummary = this.bind(notifications.getNotificationSummary);
  readonly isSessionReachable = this.bind(notifications.isSessionReachable);
  readonly pruneNotificationsRetention = this.bind(notifications.pruneNotificationsRetention);
  readonly pruneNotificationDeliveriesRetention = this.bind(notifications.pruneNotificationDeliveriesRetention);
  readonly getNotificationPolicy = this.bind(notifications.getNotificationPolicy);
  readonly updateNotificationPolicy = this.bind(notifications.updateNotificationPolicy);
  readonly getSessionNotificationPreference = this.bind(notifications.getSessionNotificationPreference);
  readonly setSessionNotificationPreference = this.bind(notifications.setSessionNotificationPreference);
  readonly getNotificationDevice = this.bind(notifications.getNotificationDevice);
  readonly getNotificationDeviceRow = this.bind(notifications.getNotificationDeviceRow);
  readonly updateNotificationDevice = this.bind(notifications.updateNotificationDevice);
  readonly markRetentionNoticeRead = this.bind(notifications.markRetentionNoticeRead);
  readonly getCleanupRevision = this.bind(notifications.getCleanupRevision);
  readonly bumpCleanupRevision = this.bind(notifications.bumpCleanupRevision);
  readonly getNotificationPushConfig = this.bind(notifications.getNotificationPushConfig);
  readonly updateNotificationPushConfig = this.bind(notifications.updateNotificationPushConfig);
}
