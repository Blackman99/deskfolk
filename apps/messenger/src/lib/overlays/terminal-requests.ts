import type { IDisposable, IParser } from "@xterm/xterm";

type Parser = Pick<IParser, "registerCsiHandler" | "registerDcsHandler" | "registerOscHandler">;

/**
 * The requests xterm answers by typing: device attributes, status and cursor reports, mode and
 * setting queries, colour queries.
 *
 * A pane answers none of them once the daemon does: the daemon's own screen sees every byte and
 * answers each request once, where two panes on one shell would each answer it and the second
 * answer would land in the program as typing. Against a daemon that does not, a pane still
 * swallows them while it replays history, since a request there was answered long ago and
 * answering it again typed `1;2c` at the next prompt on every reattach. A handler that returns
 * false hands the sequence on to xterm's own.
 */
export function silenceRequests(parser: Parser, silent: () => boolean): IDisposable {
  const swallow = (): boolean => silent();
  const handlers: IDisposable[] = [
    parser.registerCsiHandler({ final: "c" }, swallow), // DA1
    parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow), // DA2
    parser.registerCsiHandler({ prefix: "=", final: "c" }, swallow), // DA3
    parser.registerCsiHandler({ final: "n" }, swallow), // DSR: status, cursor position
    parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow), // DEC DSR
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow), // DECRQM
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow),
    parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow), // XTVERSION
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow), // DECRQSS
    // A colour is only a request when it asks with `?`; one that sets a colour still applies.
    ...[4, 10, 11, 12].map((ident) => parser.registerOscHandler(ident, (data) => silent() && data.includes("?"))),
  ];
  return { dispose: () => handlers.forEach((handler) => handler.dispose()) };
}
