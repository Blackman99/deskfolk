// The page's host on the web (nsh.json `web.host`): what the app asks of the page it runs in.
//
// Served from the same origin as the runtime's endpoint (scripts/web-dev.ts locally), it answers
// `runtime.endpoint` with the address and token that endpoint gives. The phone's host (Phase 1c)
// answers the same names over the relay's encrypted channel instead.

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
    call(name, args) {
      const f = functions.get(name);
      if (!f) throw new Error(`no host function ${name}`);
      return f(args);
    },
  };
}
