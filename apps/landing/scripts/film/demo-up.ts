/**
 * What a live take left behind, brought up again: the take's demo daemon on its data (no model
 * behind it, nothing new happens) and the real messenger served beside it. The README's shots are
 * taken on it (phone.ts).
 *
 * `demo` is the folder a take used (`data/` and `home/`). The workspace's paths are stored
 * absolute, so the folder must still be where the take had it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Lang } from './story.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANDING = path.resolve(HERE, '../..');
const REPO = path.resolve(LANDING, '../..');
const DAEMON = path.join(REPO, 'apps/daemon');

const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
process.on('exit', () => children.forEach((c) => c.kill('SIGTERM')));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): void {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
}

async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`${what} did not come up`);
    await sleep(250);
  }
}

export type DemoPorts = { daemonPort: number; messengerPort: number; messenger: string };

export async function bringUp(demo: string, { daemonPort, messengerPort, messenger }: DemoPorts): Promise<string> {
  const dataDir = path.join(demo, 'data');
  const demoHome = path.join(demo, 'home');
  if (!existsSync(path.join(dataDir, 'state.sqlite'))) throw new Error(`no take's data in ${dataDir}`);
  // Nothing may happen while it is looked at. Its model and MCP server were the take's demo-tape,
  // whose ports the next take records on, and a check-back still booked would wake a Bot (one
  // did, after a take's last step): both point nowhere, and the bookings are voided.
  const db = new DatabaseSync(path.join(dataDir, 'state.sqlite'));
  db.exec(`UPDATE providers SET base_url = 'http://127.0.0.1:9/v1';
    UPDATE mcp_servers SET enabled = 0;
    UPDATE check_backs SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE fired_at IS NULL AND voided_at IS NULL;`);
  db.close();
  // The take's own descriptor names its port and token; the daemon writes a new one when it is up.
  rmSync(path.join(dataDir, 'local-api.json'), { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: demoHome,
    PATH: `${path.join(demoHome, 'bin')}:${process.env.PATH}`,
    REAL_BOT_DATA_DIR: dataDir,
    REAL_BOT_REAL_HOME: homedir(),
    REAL_BOT_DEMO_BIND: `127.0.0.1:${daemonPort}`,
    REAL_BOT_DEMO_CONTROL: `127.0.0.1:${daemonPort + 1}`
  };
  delete env.ZDOTDIR;
  run('bun', [path.join(DAEMON, 'scripts/demo-studio.ts')], env, REPO);
  await waitFor('the demo daemon', () => existsSync(path.join(dataDir, 'local-api.json')), 30_000);
  run(process.execPath, [path.join(HERE, 'serve-quiet.mjs'), String(messengerPort)], { ...process.env, REAL_BOT_DATA_DIR: dataDir }, messenger);
  const url = `http://localhost:${messengerPort}/`;
  await waitFor('the messenger', () => fetch(url).then((r) => r.ok).catch(() => false), 90_000);
  return url;
}

/** The language and theme the take was filmed in, which the shots keep. */
export function look(demo: string): { lang: Lang; theme: 'light' | 'dark' } {
  const db = new DatabaseSync(path.join(demo, 'data', 'state.sqlite'), { readOnly: true });
  const value = (key: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined)?.value;
  const lang: Lang = value('locale') === 'en' ? 'en' : 'zh';
  const theme = value('theme') === 'dark' ? 'dark' : 'light';
  db.close();
  return { lang, theme };
}
