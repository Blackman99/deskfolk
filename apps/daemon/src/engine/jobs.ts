/**
 * The daemon's poller for external jobs (ADR 0047, engine level 6): on each scheduler tick it asks the
 * media server about every job due, once for everyone waiting on it, outside any turn — no model
 * call, no Bot's turn spent learning that a render is still running. What it hears goes to the store,
 * which wakes the waiters once the job is done, failed or given up on.
 */
import type { McpHost } from "../mcp-host";
import type { Store } from "../store";
import { jobStatusOf } from "./job-adapter";

export type JobPollerDeps = {
  store: Store;
  mcp?: McpHost;
  track: <T>(promise: Promise<T>) => Promise<T>;
  dispatchQueued: () => void;
  log?: (line: string) => void;
};

export type JobPoller = { poll: (at?: Date) => void };

export function createJobPoller(deps: JobPollerDeps): JobPoller {
  const { store, mcp, track, dispatchQueued } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));

  function poll(at: Date = new Date()): void {
    if (!mcp || !store.jobsOn()) return;
    let due;
    try {
      due = store.claimDueJobs(at.toISOString());
    } catch {
      return;
    }
    for (const job of due) {
      void track((async () => {
        const answer = await mcp.call(job.check_tool, { [job.id_param]: job.request_id });
        // An unreachable server (or one gone, or a tool renamed) is asked again after the backoff and
        // given up on by age like any job that never finishes: still pending, with what it last said.
        if (!answer.ok) log(`[jobs] ${job.request_id}: the check did not answer: ${answer.error?.message ?? "unknown error"}`);
        const after = store.recordJobPoll(job.id, answer.ok ? jobStatusOf(answer.data) : { state: "pending", statusText: null, result: null });
        if (after && after.state !== "pending") dispatchQueued();
      })().catch((error) => log(`[jobs] ${job.request_id}: ${error instanceof Error ? error.message : String(error)}`)));
    }
  }

  return { poll };
}
