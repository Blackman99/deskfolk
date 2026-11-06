import type { RemoteScreenIceServer } from "@real-bot/protocol";

/** One server per line: the URL, then for a TURN server its username and credential (`RemoteScreenSettings.svelte`'s module script). */
export function parseIceLines(text: string): RemoteScreenIceServer[] | null {
  const servers: RemoteScreenIceServer[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [url, username, credential, ...rest] = line.split(/\s+/);
    if (!url || rest.length || !/^(stun|stuns|turn|turns):\S+$/.test(url)) return null;
    servers.push({ urls: [url], ...(username ? { username } : {}), ...(credential ? { credential } : {}) });
  }
  return servers;
}

export function iceLines(servers: RemoteScreenIceServer[]): string {
  return servers
    .flatMap((server) => server.urls.map((url) => [url, server.username, server.credential].filter(Boolean).join(" ")))
    .join("\n");
}
