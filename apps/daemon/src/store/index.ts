/**
 * The daemon's one door to SQLite and the keychain. Every domain lives in its own module under
 * `store/`; this facade owns the connection, runs schema catch-up, and exposes each module's
 * functions as methods with the database context already bound, so callers keep writing
 * `store.getBot(id)` while the code behind it stays small enough to read in one sitting.
 */
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { APP_SUPPORT_DIRNAME, providerKeychainName, mcpAuthKeychainName, type ClientEvent, type RuntimeSnapshot } from "@real-bot/protocol";
import { installChangeJournal, committedEvents } from "./events";
import { Transactions } from "./transactions";
import { Receipts } from "./receipts";
import * as credentials from "./credentials";
import * as files from "./files";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../schema";
import * as annotations from "./annotations";
import * as approvals from "./approvals";
import * as bots from "./bots";
import * as judgements from "./judgements";
import * as mcp from "./mcp";
import * as memories from "./memories";
import * as messages from "./messages";
import { migrateSchema } from "./migrate";
import * as notifications from "./notifications";
import * as providers from "./providers";
import * as routines from "./routines";
import * as routing from "./routing";
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
import * as tasks from "./tasks";
import * as terminals from "./terminals";
import * as turns from "./turns";

export { HttpError } from "../errors";
export { isReservedTaskPath, RESERVED_SUBDIRS, TASK_QUIET_MS, WORK_ROOT } from "./tasks";
export type { EndpointKeyStore, StoreOptions } from "./shared";
export type { AttachmentInput } from "./messages";
export type { FileCommit, LiveFile } from "./files";
export type { DecideRouteInput } from "./routing";

type Bound<F> = F extends (ctx: StoreContext, ...args: infer A) => infer R ? (...args: A) => R : never;

export class Store {
  readonly db: Database;
  readonly receipts: Receipts;
  private readonly ctx: StoreContext;
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private journalReady = false;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.filename ?? ":memory:", { create: true, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    if (options.filename && options.filename !== ":memory:") {
      this.db.run("PRAGMA journal_mode = WAL");
    }
    this.db.run("PRAGMA synchronous = FULL");
    this.db.exec(SCHEMA_SQL);
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
      inboxRoot: options.filename && options.filename !== ":memory:" ? dirname(options.filename) : join(homedir(), "Library", "Application Support", APP_SUPPORT_DIRNAME),
      keyPlan: null,
      activeStages: new Set(),
      legacy: { copiedKey: false },
      commit: (write) => this.commit(write),
    };
    this.receipts = new Receipts(this.db, this.ctx.tx, this.ctx.keys, () => files.recoverFiles(this.ctx));
    files.recoverFiles(this.ctx);
    settings.ensureLegacyProviderRow(this.ctx);
    sessions.ensureFileDropSession(this.ctx);
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
  readonly createProviderSync = this.bind(providers.createProviderSync);
  readonly patchProviderSync = this.bind(providers.patchProviderSync);
  readonly deleteProviderSync = this.bind(providers.deleteProviderSync);
  readonly createMcpServerSync = this.bind(mcp.createMcpServerSync);
  readonly patchMcpServerSync = this.bind(mcp.patchMcpServerSync);
  readonly deleteMcpServerSync = this.bind(mcp.deleteMcpServerSync);
  readonly providersCached = this.bind(providers.providersCached);

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
  readonly joinableTask = this.bind(tasks.joinableTask);
  readonly resolveTurnTask = this.bind(tasks.resolveTurnTask);

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

  // Transcript -----------------------------------------------------------------------------
  readonly listMessages = this.bind(messages.listMessages);
  readonly postMessage = (...args: Parameters<Bound<typeof messages.postMessage>>) => messages.postMessage(this.ctx, ...args);
  readonly assertUserMayPost = this.bind(messages.assertUserMayPost);
  readonly insertMessage = this.bind(messages.insertMessage);
  readonly getMessage = this.bind(messages.getMessage);
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
  readonly getTurn = this.bind(turns.getTurn);
  readonly listLiveTurns = this.bind(turns.listLiveTurns);
  readonly setTurnStatus = this.bind(turns.setTurnStatus);
  readonly touchTurn = this.bind(turns.touchTurn);
  readonly setTurnPartial = this.bind(turns.setTurnPartial);
  readonly redirectTurn = this.bind(turns.redirectTurn);
  readonly stopTurn = this.bind(turns.stopTurn);
  readonly interruptRunningTurns = this.bind(turns.interruptRunningTurns);
  readonly interruptTurnRecord = this.bind(turns.interruptTurnRecord);
  readonly voidPendingTurnActions = this.bind(turns.voidPendingTurnActions);
  readonly claimInterruptContinue = this.bind(turns.claimInterruptContinue);
  readonly pendingInterrupt = this.bind(turns.pendingInterrupt);
  readonly markInterruptPending = this.bind(turns.markInterruptPending);
  readonly clearInterruptPending = this.bind(turns.clearInterruptPending);
  readonly recoverInterruptedTurns = this.bind(turns.recoverInterruptedTurns);
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
  readonly insertJudgement = this.bind(judgements.insertJudgement);
  readonly listJudgements = this.bind(judgements.listJudgements);

  // Model choice per turn and what each Bot learns from it ---------------------------------
  readonly decideTurnRoute = this.bind(routing.decideTurnRoute);
  readonly recordTurnRoute = this.bind(routing.recordTurnRoute);
  readonly finishTurnRoute = this.bind(routing.finishTurnRoute);
  readonly getTurnRoute = this.bind(routing.getTurnRoute);
  readonly listSessionRoutes = this.bind(routing.listSessionRoutes);
  readonly listTaskRoutes = this.bind(routing.listTaskRoutes);
  readonly listRouteFeedback = this.bind(routing.listRouteFeedback);
  readonly collectRouteFeedback = this.bind(routing.collectRouteFeedback);
  readonly forgetBotRoutes = this.bind(routing.forgetBotRoutes);
  readonly openChain = this.bind(routing.openChain);
  readonly staleOpenChains = this.bind(routing.staleOpenChains);
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
