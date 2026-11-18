import type { Locale } from "@real-bot/protocol";

/**
 * The server-side commands the remote card walks someone through before they can fill in its
 * connect form. They are the same lines as step 1 of the remote access guide, word for word
 * (`relay-guide.test.ts` holds both languages of the guide to that), so the card never teaches a
 * setup the guide has since changed. Placeholders match the guide: `relay.example.com`,
 * `you@example.com`, `my-relay`.
 */
export const RELAY_GUIDE_COMMANDS = {
  /** Checkout, the two data directories and the one-time token, all readable by the relay's UID 1000. */
  prepare: [
    "git clone https://github.com/Blackman99/deskfolk.git && cd deskfolk",
    "install -d -m 0700 /srv/deskfolk-relay",
    "install -d -m 0700 -o 1000 -g 1000 /srv/deskfolk-relay/state /srv/deskfolk-relay/caddy",
    "(umask 077 && openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\\n' > /srv/deskfolk-relay/bootstrap)",
    "chown 1000:1000 /srv/deskfolk-relay/bootstrap",
  ].join("\n"),
  env: [
    "cat > /srv/deskfolk-relay/remote.env <<'EOF'",
    "RELAY_ID=my-relay",
    "RELAY_DOMAIN=relay.example.com",
    "ACME_EMAIL=you@example.com",
    "RELAY_STATE_DIR=/srv/deskfolk-relay/state",
    "CADDY_DATA_DIR=/srv/deskfolk-relay/caddy",
    "RELAY_BOOTSTRAP_FILE=/srv/deskfolk-relay/bootstrap",
    "RELAY_ENABLED=1",
    "RELAY_PAIRING_ENABLED=1",
    "REMOTE_BIND_IP=0.0.0.0",
    "EOF",
  ].join("\n"),
  up: [
    "docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml up -d --build",
    "sh deploy/remote/check-health.sh /srv/deskfolk-relay/remote.env",
  ].join("\n"),
  pairingOff: [
    "sed -i 's/^RELAY_PAIRING_ENABLED=1$/RELAY_PAIRING_ENABLED=0/' /srv/deskfolk-relay/remote.env",
    "docker compose --env-file /srv/deskfolk-relay/remote.env -f deploy/remote/compose.yaml up -d",
  ].join("\n"),
} as const;

export type RelayGuideStep = keyof typeof RELAY_GUIDE_COMMANDS;

/**
 * The full guide in the app's language: the website's page, which is built from that same doc
 * (`apps/landing` renders `docs/remote-access*.md` at `/<lang>/remote`).
 */
export function relayGuideUrl(locale: Locale): string {
  return `https://blackman99.github.io/deskfolk/${locale === "en" ? "en" : "zh"}/remote`;
}
