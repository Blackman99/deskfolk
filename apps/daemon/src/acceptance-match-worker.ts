/**
 * The `matches` half of an acceptance check runs a Bot-free regex against a file's whole content.
 * A pattern with catastrophic backtracking would otherwise hang the daemon itself, so it runs here,
 * in its own thread, where `acceptance-eval.ts` can simply terminate it after a timeout.
 */
export type MatchRequest = { pattern: string; body: string };
export type MatchResponse = { ok: true; matched: boolean } | { ok: false; error: string };

onmessage = (event: MessageEvent<MatchRequest>) => {
  try {
    const re = new RegExp(event.data.pattern, "mi");
    const response: MatchResponse = { ok: true, matched: re.test(event.data.body) };
    postMessage(response);
  } catch (error) {
    const response: MatchResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
    postMessage(response);
  }
};
