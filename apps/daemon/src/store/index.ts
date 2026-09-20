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
import * as approvals from "./approvals";
import * as bots from "./bots";
import * as judgements from "./judgements";
import * as mcp from "./mcp";
import * as memories from "./memories";
import * as messages from "./messages";
import { migrateSchema } from "./migrate";
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
import * as turns from "./turns";

export { HttpError } from "../errors";
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
      spend: this.listSpend({}), approvals: this.listApprovals(), mcpServers: this.listMcpServers(),
      providers: providers.providersCached(this.ctx), skills: this.listSkills(), memories: this.listMemories(),
      routines: this.listRoutines(), allowRules: this.listAllowRules(),
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

  // Sessions -------------------------------------------------------------------------------
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

  // Transcript -----------------------------------------------------------------------------
  readonly listMessages = this.bind(messages.listMessages);
  readonly postMessage = (...args: Parameters<Bound<typeof messages.postMessage>>) => messages.postMessage(this.ctx, ...args);
  readonly insertMessage = this.bind(messages.insertMessage);
  readonly getMessage = this.bind(messages.getMessage);
  readonly listMainMessages = this.bind(messages.listMainMessages);
  readonly listThreadMessages = this.bind(messages.listThreadMessages);
  readonly putReaction = this.bind(messages.putReaction);
  readonly deleteReaction = this.bind(messages.deleteReaction);
  readonly getAttachment = this.bind(messages.getAttachment);
  readonly resolveAttachmentLocation = this.bind(messages.resolveAttachmentLocation);
  readonly getAttachmentFilePath = this.bind(messages.getAttachmentFilePath);

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
  readonly listRouteFeedback = this.bind(routing.listRouteFeedback);
  readonly collectRouteFeedback = this.bind(routing.collectRouteFeedback);
  readonly forgetBotRoutes = this.bind(routing.forgetBotRoutes);
  readonly openChain = this.bind(routing.openChain);
  readonly staleOpenChains = this.bind(routing.staleOpenChains);
  readonly chainForReview = this.bind(routing.chainForReview);
  readonly recordRouteReview = this.bind(routing.recordRouteReview);
  readonly recentRouteReviews = this.bind(routing.recentRouteReviews);
  readonly listSessionReviews = this.bind(routing.listSessionReviews);
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
}
