import { PeerChannel, type ScreenChannel } from "./rfb-channel.ts";

export type ScreenMode = "direct" | "relay";

/** What the Mac did for a session that asked for a smooth picture: its display lowered, or why not. */
export type SmoothResult =
  | { applied: true; width: number; height: number; from_width: number; from_height: number }
  | { applied: false; reason: string };

/** The Mac's half of the remote screen, as {@link RemoteApi} offers it. */
export interface ScreenApi {
  screenStart(options?: { smooth?: boolean }): Promise<{ session_id: string; ice_servers: RTCIceServer[]; direct: boolean; smooth?: SmoothResult }>;
  screenOffer(sessionId: string, sdp: string): Promise<{ sdp: string }>;
  screenTunnel(sessionId: string): Promise<{ tunnel_id: number }>;
  openScreenTunnel(tunnelId: number): ScreenChannel;
}

export type ScreenConnection = {
  sessionId: string;
  channel: ScreenChannel;
  mode: ScreenMode;
  /** Present when the connection asked for smooth: the Mac's answer, or null from a Mac too old to give one. */
  smooth?: SmoothResult | null;
};

export type ConnectOptions = {
  /** Absent where the browser has no WebRTC: the relay is then the only way. */
  peerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /** Candidates gathered by then go in the offer; there is no trickle afterwards. */
  gatherMs?: number;
  /** A direct channel not open by then is given up for the relay. */
  openMs?: number;
  /** Asks the Mac to lower its resolution for as long as this connection lasts. */
  smooth?: boolean;
};

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function gathered(connection: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(resolve, ms);
    connection.addEventListener("icegatheringstatechange", () => {
      if (connection.iceGatheringState === "complete") { clearTimeout(timer); resolve(); }
    });
  });
}

/**
 * Straight to the Mac when the two can reach each other (same Wi-Fi, IPv6, or through the STUN
 * servers the Mac's settings name); otherwise through the relay. The offer travels over the
 * end-to-end encrypted link, so the DTLS fingerprint in it is this paired phone's.
 */
async function direct(api: ScreenApi, sessionId: string, iceServers: RTCIceServer[], options: Required<Omit<ConnectOptions, "smooth">>): Promise<ScreenChannel> {
  const connection = options.peerConnection({ iceServers });
  try {
    const channel = connection.createDataChannel("rfb", { ordered: true });
    const opened = new Promise<void>((resolve, reject) => {
      channel.onopen = () => resolve();
      channel.onclose = () => reject(new Error("direct channel closed"));
      // ICE gave up: no use waiting out the rest of the timeout.
      connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed") reject(new Error("direct connection failed"));
      });
    });
    // Settled later or never; a failure before then is not an unhandled one.
    opened.catch(() => {});
    await connection.setLocalDescription(await connection.createOffer());
    await gathered(connection, options.gatherMs);
    const offer = connection.localDescription!.sdp;
    // Nothing to offer the Mac (no network, or a browser that keeps WebRTC off the network).
    if (!/^a=candidate:/m.test(offer)) throw new Error("no local candidates");
    const { sdp } = await api.screenOffer(sessionId, offer);
    await connection.setRemoteDescription({ type: "answer", sdp });
    await within(opened, options.openMs, "direct channel did not open");
    return new PeerChannel(channel, connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}

export async function connectScreen(api: ScreenApi, options: ConnectOptions = {}): Promise<ScreenConnection> {
  const start = await api.screenStart(options.smooth ? { smooth: true } : undefined);
  const smooth = options.smooth ? { smooth: start.smooth ?? null } : {};
  const factory = options.peerConnection ?? (typeof RTCPeerConnection === "function" ? (config: RTCConfiguration) => new RTCPeerConnection(config) : undefined);
  if (start.direct && factory) {
    try {
      const channel = await direct(api, start.session_id, start.ice_servers, { peerConnection: factory, gatherMs: options.gatherMs ?? 3000, openMs: options.openMs ?? 8000 });
      return { sessionId: start.session_id, channel, mode: "direct", ...smooth };
    } catch {
      // Not reachable this way from where the phone is; the relay always is.
    }
  }
  const { tunnel_id } = await api.screenTunnel(start.session_id);
  return { sessionId: start.session_id, channel: api.openScreenTunnel(tunnel_id), mode: "relay", ...smooth };
}
