import type { GroupLeadState } from "@real-bot/protocol";
import { ApiError } from "../api.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { Connection } from "../runtime.svelte.ts";
import type { Snapshot } from "../snapshot.ts";
import { attributable, messageFilings, type AttributedMessage, type AttributionPlan } from "./attribution.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client and the
 * connection a read rides on, the snapshot delegations are read into, the failure mapping a group
 * lead's write shares with every sheet, and `loadAttributionPlans` as the runtime answers to it.
 */
export interface ThreadStateHost {
  readonly api: MessengerApi | null;
  readonly connection: Connection;
  snapshot: Snapshot;
  sheetFailure(error: unknown, api: MessengerApi): ApiError | null;
  loadAttributionPlans(sessionId: string, messageId?: string): Promise<void>;
}

/**
 * What a conversation's thread panes read beside the transcript, each keyed by conversation and
 * guarded against reads that went stale: its delegations, a group's lead, and the jobs a line can
 * be filed under. The events that change them are applied in `MessengerRuntime.ingest`, which
 * forwards every field and method here under the same names; this reaches back in through
 * {@link ThreadStateHost}.
 */
export class ThreadState {
  constructor(private readonly host: ThreadStateHost) {}

  delegationLoading = $state<Record<string, boolean>>({});
  delegationLoadError = $state<Record<string, boolean>>({});
  delegationUnsupported = $state<Record<string, boolean>>({});
  readonly delegationReadSeq = new Map<string, number>();
  delegationEventSeq = 0;
  readonly delegationEventRevisions = new Map<string, number>();
  /** Full snapshots omit thread collections: visible panes re-read once per installation. */
  delegationSnapshotEpoch = $state(0);

  /** These are persisted views, never inferred from a Bot's text. */
  async loadDelegations(sessionId: string): Promise<void> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return;
    const seq = (this.delegationReadSeq.get(sessionId) ?? 0) + 1;
    this.delegationReadSeq.set(sessionId, seq);
    const epoch = this.delegationSnapshotEpoch;
    const eventSeq = this.delegationEventSeq;
    const changed = (id: string) => (this.delegationEventRevisions.get(id) ?? 0) > eventSeq;
    const current = () => this.host.api === api && this.delegationReadSeq.get(sessionId) === seq && this.delegationSnapshotEpoch === epoch;
    this.delegationLoading = { ...this.delegationLoading, [sessionId]: true };
    this.delegationLoadError = { ...this.delegationLoadError, [sessionId]: false };
    try {
      const { items } = await api.delegations(sessionId);
      if (!current()) return;
      // Events received during this unsequenced GET win; untouched siblings still hydrate.
      // A subsequent read can refresh linked IDs and history-cleared projections.
      this.host.snapshot = { ...this.host.snapshot, delegations: [
        ...this.host.snapshot.delegations.filter((row) => row.thread_session_id !== sessionId || changed(row.id)),
        ...items.filter((row) => row.thread_session_id === sessionId && !changed(row.id)),
      ] };
      this.delegationUnsupported = { ...this.delegationUnsupported, [sessionId]: false };
    } catch (error) {
      if (!current()) return;
      if (this.host.snapshot.delegations.some((row) => row.thread_session_id === sessionId && changed(row.id))) return;
      const unsupported = error instanceof ApiError && error.status === 404;
      this.delegationUnsupported = { ...this.delegationUnsupported, [sessionId]: unsupported };
      this.delegationLoadError = { ...this.delegationLoadError, [sessionId]: !unsupported };
    } finally {
      if (current()) this.delegationLoading = { ...this.delegationLoading, [sessionId]: false };
    }
  }

  groupLeads = $state<Record<string, GroupLeadState>>({});
  groupLeadLoading = $state<Record<string, boolean>>({});
  groupLeadLoadError = $state<Record<string, boolean>>({});
  groupLeadUnsupported = $state<Record<string, boolean>>({});
  readonly groupLeadSeq = new Map<string, number>();
  private readonly groupLeadWrites = new Map<string, number>();
  private readonly groupLeadPending = new Set<string>();
  readonly groupLeadRevision = new Map<string, number>();

  /** Reading evidence never confirms a leader. A PUT can supersede an older GET. */
  async loadGroupLead(sessionId: string): Promise<void> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected" || this.groupLeadPending.has(sessionId)) return;
    const seq = (this.groupLeadSeq.get(sessionId) ?? 0) + 1;
    this.groupLeadSeq.set(sessionId, seq);
    this.groupLeadLoading = { ...this.groupLeadLoading, [sessionId]: true };
    this.groupLeadLoadError = { ...this.groupLeadLoadError, [sessionId]: false };
    try {
      const state = await api.groupLead(sessionId);
      if (this.host.api === api && this.groupLeadSeq.get(sessionId) === seq) {
        this.groupLeads = { ...this.groupLeads, [sessionId]: state };
        this.groupLeadUnsupported = { ...this.groupLeadUnsupported, [sessionId]: false };
      }
    } catch (error) {
      if (this.host.api === api && this.groupLeadSeq.get(sessionId) === seq) {
        const unsupported = error instanceof ApiError && error.status === 404;
        this.groupLeadUnsupported = { ...this.groupLeadUnsupported, [sessionId]: unsupported };
        this.groupLeadLoadError = { ...this.groupLeadLoadError, [sessionId]: !unsupported };
      }
    } finally {
      if (this.groupLeadSeq.get(sessionId) === seq) this.groupLeadLoading = { ...this.groupLeadLoading, [sessionId]: false };
    }
  }

  async confirmGroupLead(sessionId: string, botId: string | null): Promise<ApiError | null> {
    const api = this.host.api;
    if (!api || this.host.connection !== "connected") return new ApiError(0, "disconnected", "Group lead not saved");
    const revision = this.groupLeadRevision.get(sessionId) ?? 0;
    const seq = (this.groupLeadWrites.get(sessionId) ?? 0) + 1;
    this.groupLeadWrites.set(sessionId, seq);
    this.groupLeadPending.add(sessionId);
    this.groupLeadSeq.set(sessionId, (this.groupLeadSeq.get(sessionId) ?? 0) + 1);
    this.groupLeadLoading = { ...this.groupLeadLoading, [sessionId]: false };
    try {
      const state = await api.confirmGroupLead(sessionId, botId);
      if (this.host.api !== api || this.groupLeadWrites.get(sessionId) !== seq) return new ApiError(0, "disconnected", "Group lead result unconfirmed");
      if ((this.groupLeadRevision.get(sessionId) ?? 0) === revision) this.groupLeads = { ...this.groupLeads, [sessionId]: state };
      return null;
    } catch (error) {
      return this.host.sheetFailure(error, api) ?? new ApiError(0, "disconnected", "Group lead result unconfirmed");
    } finally {
      if (this.groupLeadWrites.get(sessionId) === seq) this.groupLeadPending.delete(sessionId);
    }
  }

  attributionPlans = $state<Record<string, AttributionPlan[]>>({});
  attributionLoading = $state<Record<string, boolean>>({});
  attributionLoadError = $state<Record<string, boolean>>({});
  private readonly attributionLoadSeq = new Map<string, number>();

  /** Manual choices include untouched and dormant plans, not just routing candidates. */
  async loadAttributionPlans(sessionId: string, messageId?: string): Promise<void> {
    const api = this.host.api;
    const message = messageId ?? this.host.snapshot.messages.find((row) => row.session_id === sessionId && (row.kind === "user" || row.kind === "bot" || row.control?.kind === "work_question"))?.id;
    if (!api || this.host.connection !== "connected" || !message) return;
    const seq = (this.attributionLoadSeq.get(sessionId) ?? 0) + 1;
    this.attributionLoadSeq.set(sessionId, seq);
    this.attributionLoading = { ...this.attributionLoading, [sessionId]: true };
    this.attributionLoadError = { ...this.attributionLoadError, [sessionId]: false };
    try {
      const { items: plans } = await api.attributionPlans(message);
      if (this.host.api !== api || this.attributionLoadSeq.get(sessionId) !== seq) return;
      this.attributionPlans = { ...this.attributionPlans, [sessionId]: plans };
    } catch {
      if (this.host.api === api && this.attributionLoadSeq.get(sessionId) === seq) this.attributionLoadError = { ...this.attributionLoadError, [sessionId]: true };
    } finally {
      if (this.attributionLoadSeq.get(sessionId) === seq) this.attributionLoading = { ...this.attributionLoading, [sessionId]: false };
    }
  }

  /** Jobs a reload of a conversation's list was already asked for: one the list still lacks is not asked about again. */
  private readonly attributionAsked = new Map<string, Set<string>>();

  /**
   * A tag names its job from its conversation's list, loaded when the conversation opened: the
   * first line of a conversation that had none (2026-10-03, the first line in a new group), or a
   * line on a job opened since, read 「一件事」 until a reload. A line on a job the list lacks loads
   * the list again, from that line, once per job.
   */
  loadAttributionFor(message: AttributedMessage & { id: string; session_id: string }): void {
    if (!attributable(message)) return;
    const plans = this.attributionPlans[message.session_id];
    const missing = messageFilings(message).map((row) => row.task_id).filter((id) => !plans?.some((plan) => plan.id === id));
    const asked = this.attributionAsked.get(message.session_id) ?? new Set<string>();
    const fresh = missing.filter((id) => !asked.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) asked.add(id);
    this.attributionAsked.set(message.session_id, asked);
    void this.host.loadAttributionPlans(message.session_id, message.id);
  }

  renameAttributionPlan(id: string, title: string): void {
    let changed = false;
    const next: Record<string, AttributionPlan[]> = {};
    for (const [session, plans] of Object.entries(this.attributionPlans)) {
      next[session] = plans.map((plan) => {
        if (plan.id !== id || plan.title === title) return plan;
        changed = true;
        return { ...plan, title };
      });
    }
    if (changed) this.attributionPlans = next;
  }
}
