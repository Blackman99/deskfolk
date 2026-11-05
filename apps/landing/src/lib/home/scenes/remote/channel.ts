import { CHANNEL_NAME, parseMessage, type RemoteMessage } from '../../remote-channel';

export type RemoteLink = {
  /** This window's id, so it can tell its own messages from the other window's. */
  id: string;
  send: (message: DistributiveOmit<RemoteMessage, 'v' | 'from'>) => void;
  close: () => void;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Open the demo's BroadcastChannel; null where the browser has none. Messages that are not ours are dropped. */
export function openRemoteLink(onMessage: (message: RemoteMessage) => void): RemoteLink | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const id = Math.random().toString(36).slice(2, 10);
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (e: MessageEvent) => {
    const message = parseMessage(e.data);
    if (message && message.from !== id) onMessage(message);
  };
  return {
    id,
    send: (message) => channel.postMessage({ v: 1, from: id, ...message }),
    close: () => channel.close()
  };
}
