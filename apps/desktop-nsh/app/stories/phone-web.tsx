/**
 * The phone's pairing screen (ADR 0107, Phase 1c), as a page served from relay `STORY_RELAY` would
 * show it: a compact code is read against that origin. It is loopback, where nothing listens, so a
 * submitted code is refused at once and the screen's refusal can be seen. The rest of the hosted
 * flow (pairing through a relay, the remote client) is `scripts/phone-web-e2e.ts`.
 */
import { PairingScreen } from "../src/ui/remote/PairingScreen";

export const STORY_RELAY = "https://127.0.0.1:9";

export default function PhoneWeb() {
  return <PairingScreen origin={STORY_RELAY} />;
}
