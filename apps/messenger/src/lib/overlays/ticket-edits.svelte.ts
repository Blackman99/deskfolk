/**
 * Edits to a plan's tickets, from wherever they are made: a status from the menu or a drop on the
 * board, a reviewer, a model, what a ticket waits for, the sample. The plan's revision is one number
 * for every ticket, so every edit goes out through the one queue here, one request at a time; two
 * places editing the same plan share one of these.
 *
 * What it does not own is the keyboard: the board says where a card's focus is and puts it back
 * once the card has mounted again in its new column.
 */
import {
  isTicketAgentModel,
  type AgentsStatusResponse,
  type BotRunner,
  type ClaudeCodeStatus,
  type Provider,
  type TaskDetail,
  type Ticket,
  type TicketModel,
  type TicketStatus,
  type TicketWithArtifacts,
} from "@real-bot/protocol";
import type { Copy } from "../copy.ts";
import type { MessengerApi } from "../messenger-api.ts";
import { findPicked, type PickerData } from "../model-picker.ts";
import { agentPickerSources, claudePickerSource, endpointPickerSources } from "../model-picker-sources.ts";
import { claudeReady } from "../settings/claude-agent.ts";
import { enqueueMove, nextQueuedMove } from "./ticket-board.ts";

export type TicketEditsHost = {
  api: () => MessengerApi | null;
  detail: () => TaskDetail;
  t: () => Copy;
  /** The endpoints, for a ticket's model menu (level 7). */
  providers: () => readonly Provider[];
  onPatched: (ticket: Ticket) => void;
  onConflict: () => void;
  /** Whether the keyboard is on this ticket's card. */
  cardHasFocus: (ticketId: string) => boolean;
  /** Put the keyboard back on the card once it has mounted again, unless something else took it. */
  keepFocus: (ticketId: string) => Promise<void>;
};

function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** A ticket's model as the picker holds it: which endpoint's or which agent's, and its name. */
function modelKey(model: TicketModel): string {
  return JSON.stringify(isTicketAgentModel(model)
    ? { runner: model.runner, model: model.model, ...(model.custom_id ? { custom_id: model.custom_id } : {}) }
    : { provider_id: model.provider_id, model: model.model });
}

/** What a picked value asks the daemon for: an endpoint's model, or an agent's at its default effort and account. */
function modelOf(value: string): TicketModel {
  const parsed = JSON.parse(value) as { provider_id?: string; runner?: BotRunner; model: string; custom_id?: string };
  return parsed.runner
    ? { runner: parsed.runner, model: parsed.model, effort: null, config_dir: null, ...(parsed.custom_id ? { custom_id: parsed.custom_id } : {}) }
    : { provider_id: parsed.provider_id!, model: parsed.model };
}

/** A stage a hand-over is still waiting in (ADR 0046). Moving it drops that hand-over, so it asks first. */
function awaitingReview(ticket: TicketWithArtifacts): boolean {
  return ticket.stage === "submitted" || ticket.stage === "in_review";
}

/** The map without this move — unless the card was moved again meanwhile: that later move stays. */
function settled(map: ReadonlyMap<string, TicketStatus>, move: { id: string; status: TicketStatus }): Map<string, TicketStatus> {
  const next = new Map(map);
  if (next.get(move.id) === move.status) next.delete(move.id);
  return next;
}

export class TicketEdits {
  /** The card whose patch is on its way, so its own controls wait. Reviewer, model and depends edits set it too. */
  patchingId = $state<string | null>(null);
  /**
   * Requests on their way, of any kind. The plan's revision is one number for every card, so a
   * queued move goes out only when none is: sent beside another, one of the two would be refused.
   */
  #requestsOut = 0;
  errorId = $state<string | null>(null);
  /** Where a card should go, until its own request comes back. A reload of the plan does not clear it. */
  pending = $state<Map<string, TicketStatus>>(new Map());
  /** Where a card is drawn while its move has not come back. Separate from `pending`, cleared per card. */
  optimistic = $state<Map<string, TicketStatus>>(new Map());
  /** A hand-over still waiting (submitted, in review) asked before the move goes out. */
  confirming = $state<{ id: string; status: TicketStatus } | null>(null);
  /** Set when a 409 drops the queue, until the next move that lands or the plan changes. */
  conflictNote = $state(false);

  /** Your local agents, asked once a ticket's model is offered: their models can be a ticket's too (ADR 0079). */
  agents = $state<AgentsStatusResponse | null>(null);
  claude = $state<ClaudeCodeStatus | null>(null);
  #askedAgents = false;

  /**
   * The models a ticket can be given (ADR 0049, level 7): every model an endpoint lists, Claude
   * Code's when it is signed in, and those of your other local agents (ADR 0079), which then run
   * the ticket's turns.
   */
  modelData = $derived.by<PickerData>(() => {
    const t = this.#host.t();
    return {
      specials: [{ value: "", label: t.plan.modelOwn }],
      sources: [
        ...endpointPickerSources(this.#host.providers(), t, (provider_id, model) => modelKey({ provider_id, model })),
        ...(claudeReady(this.claude) ? [claudePickerSource(t, (model) => modelKey({ runner: "claude_code", model, effort: null, config_dir: null }))] : []),
        ...agentPickerSources(this.agents, t, (runner, model, customId) => modelKey({ runner, model, effort: null, config_dir: null, ...(customId ? { custom_id: customId } : {}) }), { typed: true }),
      ],
    };
  });

  /** The picked ticket has a menu to show below it: a reviewer (level 5), a model (level 7) or what it waits for (level 4). */
  hasSettings = $derived.by(() => {
    const detail = this.#host.detail();
    return Boolean(detail.submissions_on) || (Boolean(detail.routing_on) && this.modelData.sources.length > 0) || (Boolean(detail.supervision_on) && detail.tickets.length > 1);
  });

  readonly #host: TicketEditsHost;

  constructor(host: TicketEditsHost) {
    this.#host = host;
  }

  /** Ask once for the local agents and Claude Code, when the plan offers a ticket's model. */
  loadModels(): void {
    const api = this.#host.api();
    if (!api || !this.#host.detail().routing_on || this.#askedAgents) return;
    this.#askedAgents = true;
    void api.agents?.().then((list) => (this.agents = list), () => undefined);
    void api.claudeCode?.().then((status) => (this.claude = status), () => undefined);
  }

  /** The same, with the ticket's own model on top when nothing lists it any more, so it reads as its name. */
  modelDataFor(ticket: TicketWithArtifacts): PickerData {
    const value = this.modelValue(ticket);
    if (!value || findPicked(this.modelData, value) || !ticket.model_override) return this.modelData;
    return { ...this.modelData, specials: [...this.modelData.specials, { value, label: ticket.model_override.model, hint: this.#host.t().plan.modelUnlisted }] };
  }

  modelValue(ticket: TicketWithArtifacts): string {
    return ticket.model_override ? modelKey(ticket.model_override) : "";
  }

  async changeReviewer(ticket: TicketWithArtifacts, reviewer: string): Promise<void> {
    const api = this.#host.api();
    if (!api || reviewer === (ticket.reviewer_bot_id ?? "")) return;
    this.patchingId = ticket.id;
    this.#requestsOut += 1;
    this.errorId = null;
    try {
      const result = await api.patchTicket(ticket.id, { reviewer_bot_id: reviewer || null, if_revision: this.#host.detail().revision });
      this.#host.onPatched(result);
    } catch (err) {
      if (errorStatus(err) === 409) {
        this.#host.onConflict();
      } else {
        this.errorId = ticket.id;
      }
    } finally {
      this.#requestsOut -= 1;
      this.patchingId = null;
    }
    // A status move queued while this was on its way waits for it.
    void this.pump();
  }

  async toggleDepends(ticket: TicketWithArtifacts, otherId: string): Promise<void> {
    const api = this.#host.api();
    if (!api) return;
    const current = ticket.depends_on ?? [];
    const next = current.includes(otherId) ? current.filter((id) => id !== otherId) : [...current, otherId];
    this.patchingId = ticket.id;
    this.#requestsOut += 1;
    this.errorId = null;
    try {
      const result = await api.patchTicket(ticket.id, { depends_on: next, if_revision: this.#host.detail().revision });
      this.#host.onPatched(result);
    } catch (err) {
      if (errorStatus(err) === 409) {
        this.#host.onConflict();
      } else {
        this.errorId = ticket.id;
      }
    } finally {
      this.#requestsOut -= 1;
      this.patchingId = null;
    }
    // A status move queued while this was on its way waits for it.
    void this.pump();
  }

  async changeModel(ticket: TicketWithArtifacts, value: string): Promise<void> {
    const api = this.#host.api();
    if (!api || value === this.modelValue(ticket)) return;
    this.patchingId = ticket.id;
    this.#requestsOut += 1;
    this.errorId = null;
    try {
      const result = await api.patchTicket(ticket.id, { model_override: value ? modelOf(value) : null, if_revision: this.#host.detail().revision });
      this.#host.onPatched(result);
    } catch (err) {
      if (errorStatus(err) === 409) {
        this.#host.onConflict();
      } else {
        this.errorId = ticket.id;
      }
    } finally {
      this.#requestsOut -= 1;
      this.patchingId = null;
    }
    // A status move queued while this was on its way waits for it.
    void this.pump();
  }

  async makeSample(ticket: TicketWithArtifacts): Promise<void> {
    const api = this.#host.api();
    if (!api) return;
    this.patchingId = ticket.id;
    this.#requestsOut += 1;
    this.errorId = null;
    try {
      const result = await api.patchTicket(ticket.id, { sample: true, if_revision: this.#host.detail().revision });
      this.#host.onPatched(result);
    } catch (err) {
      if (errorStatus(err) === 409) {
        this.#host.onConflict();
      } else {
        this.errorId = ticket.id;
      }
    } finally {
      this.#requestsOut -= 1;
      this.patchingId = null;
    }
    // A status move queued while this was on its way waits for it.
    void this.pump();
  }

  /**
   * Send the next queued move, one at a time: the plan's revision is one number for every card,
   * so a second request sent before the first comes back is refused.
   */
  async pump(): Promise<void> {
    const api = this.#host.api();
    const detail = this.#host.detail();
    if (this.#requestsOut > 0) return;
    const next = nextQueuedMove(this.pending, detail.tickets, null);
    if (!next || !api) return;
    const ticket = detail.tickets.find((row) => row.id === next.id);
    if (!ticket) {
      this.pending = new Map([...this.pending].filter(([id]) => id !== next.id));
      this.optimistic = new Map([...this.optimistic].filter(([id]) => id !== next.id));
      return;
    }
    this.patchingId = next.id;
    this.#requestsOut += 1;
    this.errorId = null;
    try {
      const result = await api.patchTicket(next.id, { status: next.status, if_revision: detail.revision });
      this.pending = settled(this.pending, next);
      this.optimistic = settled(this.optimistic, next);
      this.conflictNote = false;
      this.#host.onPatched(result);
    } catch (err) {
      this.pending = settled(this.pending, next);
      if (errorStatus(err) === 409) {
        // The conflict line says it for every card; 「保存失败」 would say it twice.
        this.pending = new Map();
        this.optimistic = new Map();
        this.confirming = null;
        this.conflictNote = true;
        this.#host.onConflict();
      } else {
        const focused = this.#host.cardHasFocus(next.id);
        this.optimistic = settled(this.optimistic, next);
        // Set after the card is back in its own column, so the note is not left on the node that unmounted.
        this.errorId = next.id;
        if (focused) void this.#host.keepFocus(next.id);
      }
    } finally {
      this.#requestsOut -= 1;
      // Another edit may have taken patchingId meanwhile; it frees it itself.
      if (this.patchingId === next.id) this.patchingId = null;
    }
    void this.pump();
  }

  /** A status from the menu or a drop. A card still in review asks before it is queued. */
  requestStatus(ticket: TicketWithArtifacts, status: TicketStatus): void {
    if (!this.#host.api() || status === this.columnOfTicket(ticket)) return;
    this.conflictNote = false;
    if (awaitingReview(ticket)) {
      this.confirming = { id: ticket.id, status };
      return;
    }
    this.queueMove(ticket.id, status);
  }

  columnOfTicket(ticket: TicketWithArtifacts): TicketStatus {
    return this.optimistic.get(ticket.id) ?? ticket.status;
  }

  queueMove(ticketId: string, status: TicketStatus): void {
    const focused = this.#host.cardHasFocus(ticketId);
    this.confirming = this.confirming?.id === ticketId ? null : this.confirming;
    this.pending = enqueueMove(this.pending, ticketId, status);
    this.optimistic = enqueueMove(this.optimistic, ticketId, status);
    this.errorId = this.errorId === ticketId ? null : this.errorId;
    if (focused) void this.#host.keepFocus(ticketId);
    void this.pump();
  }

  keepCard(ticketId: string): void {
    if (this.confirming?.id === ticketId) this.confirming = null;
  }

  async changeStatus(ticket: TicketWithArtifacts, status: string): Promise<void> {
    this.requestStatus(ticket, status as TicketStatus);
  }
}
