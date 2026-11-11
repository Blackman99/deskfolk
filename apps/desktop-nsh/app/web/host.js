// The page's host on the web (nsh.json `web.host`): what the app asks of the page it runs in.
//
// Served from the same origin as the runtime's endpoint (scripts/web-dev.ts locally), it answers
// `runtime.endpoint` with the address and token that endpoint gives. The phone's build
// (`Hosted.tsx`) asks it nothing: pairing, the encrypted channel and the device store run in the
// app's own realm, which has the browser's globals (ADR 0107, Phase 1c). Keep this file
// self-contained: `nsh package --target web` copies it as it is and bundles none of its imports.

const functions = new Map([["runtime.endpoint", endpoint]]);

let known = null;

function endpoint() {
  known ??= fetch("./__deskfolk/endpoint", { cache: "no-store" }).then((res) => {
    if (!res.ok) throw new Error(`no runtime endpoint (${res.status})`);
    return res.json();
  });
  return known;
}

export async function createHost() {
  return {
    // Async, so a name it does not know rejects later instead of throwing in the caller's turn:
    // NSH can make a host call while it holds the app (laying out a screen), and an answer that
    // came back at once re-entered it and panicked ("RefCell already borrowed").
    async call(name, args) {
      const f = functions.get(name);
      if (!f) throw new Error(`no host function ${name}`);
      return f(args);
    },
  };
}
