/**
 * The environment the benchmark runs its runtimes in. Bot `shell` calls inherit this process's
 * environment, and Bun hands a spawned child the environment the process started with, whatever
 * `process.env` says later (checked on Bun 1.4: `delete process.env.X` does not hide X from
 * `Bun.spawn`). So the runner re-executes itself with a scrubbed environment and passes the key on
 * stdin; a Bot running `env` then has nothing of yours to print.
 */

/** Names that look like credentials, and the app's own config switches. */
const SECRET_NAME = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)/i;
const APP_CONFIG = /^REAL_BOT_/;

export function scrubbedEnv(env: Record<string, string | undefined>, keyEnv: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name === keyEnv) continue;
    if (SECRET_NAME.test(name) || APP_CONFIG.test(name)) continue;
    // Job shells set it; it colours `bun test` output and breaks exact comparisons.
    if (name === "FORCE_COLOR") continue;
    out[name] = value;
  }
  return out;
}
