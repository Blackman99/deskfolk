/**
 * The daemon's one door to SQLite and the keychain. Every domain lives in its own module under
 * `store/`; this facade owns the connection, runs schema catch-up, and exposes each module's
 * functions as methods with the database context already bound, so callers keep writing
 * `store.getBot(id)` while the code behind it stays small enough to read in one sitting.
 */
import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../schema";
import * as approvals from "./approvals";
import * as bots from "./bots";
import * as judgements from "./judgements";
import * as mcp from "./mcp";
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
export type { DecideRouteInput } from "./routing";

type Bound<F> = F extends (ctx: StoreContext, ...args: infer A) => infer R ? (...args: A) => R : never;

export class Store {
  readonly db: Database;
  private readonly ctx: StoreContext;

  constructor(options: StoreOptions = {}) {
    this.db = new Database(options.filename ?? ":memory:", { create: true, strict: true });
    this.db.run("PRAGMA foreign_keys = ON");
    if (options.filename && options.filename !== ":memory:") {
      this.db.run("PRAGMA journal_mode = WAL");
    }
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
      keys: new KeyCache(options.endpointKey ?? memoryKeyStore()),
      legacy: { copiedKey: false },
    };
    settings.ensureLegacyProviderRow(this.ctx);
  }

  close(): void {
    this.db.close();
  }

  private bind<F extends (ctx: StoreContext, ...args: never[]) => unknown>(fn: F): Bound<F> {
    return ((...args: unknown[]) => (fn as unknown as (...all: unknown[]) => unknown)(this.ctx, ...args)) as Bound<F>;
  }

  // Settings & endpoints -------------------------------------------------------------------
  readonly settings = this.bind(settings.settings);
  readonly patchSettings = this.bind(settings.patchSettings);
  readonly endpointKey = this.bind(settings.endpointKey);
  readonly workspacePath = this.bind(workspacePath);
  readonly defaultProviderId = this.bind(defaultProviderId);
  readonly listProviders = this.bind(providers.listProviders);
  readonly getProvider = this.bind(providers.getProvider);
  readonly createProvider = this.bind(providers.createProvider);
  readonly patchProvider = this.bind(providers.patchProvider);
  readonly deleteProvider = this.bind(providers.deleteProvider);
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

  // Per-Bot procedures and calendar --------------------------------------------------------
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
  readonly unreadCount = this.bind(sessions.unreadCount);

  // Transcript -----------------------------------------------------------------------------
  readonly listMessages = this.bind(messages.listMessages);
  readonly postMessage = this.bind(messages.postMessage);
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
  readonly routeLearnedState = this.bind(routing.routeLearnedState);
  readonly collectRouteFeedback = this.bind(routing.collectRouteFeedback);
  readonly forgetBotRoutes = this.bind(routing.forgetBotRoutes);

  // MCP ------------------------------------------------------------------------------------
  readonly listMcpServers = this.bind(mcp.listMcpServers);
  readonly listMcpServersHydrated = this.bind(mcp.listMcpServersHydrated);
  readonly mcpAuth = this.bind(mcp.mcpAuth);
  readonly createMcpServer = this.bind(mcp.createMcpServer);
  readonly patchMcpServer = this.bind(mcp.patchMcpServer);
  readonly deleteMcpServer = this.bind(mcp.deleteMcpServer);

  // Search ---------------------------------------------------------------------------------
  readonly search = this.bind(search.search);
}
