import { readFileSync } from 'node:fs';
import { startRelay } from './server.ts';

try {
  const port = Number(process.env.RELAY_PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid');
  const bootstrapFile = process.env.RELAY_BOOTSTRAP_FILE;
  const relay = startRelay({
    hostname: process.env.RELAY_BIND ?? '127.0.0.1', port,
    database: process.env.RELAY_DATABASE ?? './data/enrollment.sqlite',
    bootstrap: bootstrapFile ? readFileSync(bootstrapFile, 'utf8').trim() : undefined,
    relayId: process.env.RELAY_ID ?? '', origin: process.env.RELAY_ORIGIN ?? '',
    trustedProxyIp: process.env.RELAY_TRUSTED_PROXY_IP,
    enabled: process.env.RELAY_ENABLED === '1',
    pairingEnabled: process.env.RELAY_PAIRING_ENABLED === '1',
    log: entry => console.log(JSON.stringify(entry)),
  });
  const stop = () => { void relay.stop().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch {
  console.error('{"event":"startup_failed","code":1}');
  process.exit(1);
}
