import { Database } from 'bun:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fromBase64url } from '@real-bot/remote';
import { identifier, key, LIMITS, requireValue } from './wire.ts';

type Enrollment = { id: string; public_key: string };
function bootstrapHash(token: string): Uint8Array {
  const bytes = fromBase64url(token, 32);
  // This rejects obvious weak inputs; only a CSPRNG can establish real entropy.
  requireValue(new Set(bytes).size >= 16);
  return createHash('sha256').update(bytes).digest();
}

export class EnrollmentStore {
  private db: Database;
  constructor(path: string, bootstrap?: string) {
    requireValue(path !== ':memory:');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    requireValue(!lstatSync(dirname(path)).isSymbolicLink());
    try { requireValue(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.db = new Database(path, { create: true, strict: true });
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
        PRAGMA max_page_count=256; PRAGMA locking_mode=EXCLUSIVE;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS bootstrap (singleton INTEGER PRIMARY KEY CHECK(singleton=1), digest BLOB, consumed INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS host (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE);
        COMMIT;`);
      if (!this.db.query('SELECT singleton FROM bootstrap').get()) {
        requireValue(bootstrap);
        this.db.query('INSERT INTO bootstrap VALUES (1, ?, 0)').run(bootstrapHash(bootstrap));
      }
    } catch (error) { this.db.close(); throw error; }
  }
  host(): Enrollment | null {
    return this.db.query<Enrollment, []>('SELECT id, public_key FROM host').get();
  }
  lookup(role: 'host' | 'device', id: string): string | undefined {
    return this.db.query<Enrollment, [string]>(`SELECT id, public_key FROM ${role === 'host' ? 'host' : 'devices'} WHERE id=?`).get(id)?.public_key;
  }
  bootstrap(token: string, hostId: string, publicKey: string): void {
    identifier(hostId); key(publicKey);
    const digest = bootstrapHash(token);
    this.db.transaction(() => {
      const state = this.db.query<{ digest: Uint8Array | null; consumed: number }, []>('SELECT digest, consumed FROM bootstrap WHERE singleton=1').get();
      requireValue(state && !state.consumed && state.digest && timingSafeEqual(digest, state.digest));
      this.db.query('INSERT INTO host VALUES (1, ?, ?)').run(hostId, publicKey);
      this.db.query('UPDATE bootstrap SET digest=NULL, consumed=1 WHERE singleton=1').run();
    }).immediate();
  }
  register(deviceId: string, publicKey: string): void {
    identifier(deviceId); key(publicKey);
    this.db.transaction(() => {
      const existing = this.lookup('device', deviceId);
      if (existing) { requireValue(existing === publicKey); return; }
      requireValue(this.host() && this.count() < LIMITS.devices && publicKey !== this.host()!.public_key);
      this.db.query('INSERT INTO devices VALUES (?, ?)').run(deviceId, publicKey);
    }).immediate();
  }
  revoke(deviceId: string): void {
    identifier(deviceId);
    this.db.query('DELETE FROM devices WHERE id=?').run(deviceId);
  }
  count(): number { return this.db.query<{ count: number }, []>('SELECT count(*) AS count FROM devices').get()!.count; }
  close(): void { this.db.close(); }
}
