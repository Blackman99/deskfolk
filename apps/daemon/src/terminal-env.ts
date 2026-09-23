/**
 * The environment a terminal session's shell gets, built up rather than inherited whole.
 *
 * The daemon's own process env can hold secrets — API keys, `REAL_BOT_*` config — that a shell
 * the person opened themselves has no business seeing. So the default is a narrow whitelist of
 * what a login shell actually needs, not everything launchd handed the daemon, plus what
 * Terminal.app would set on top: a real `TERM`, a locale, and — for zsh — Real Bot's own shell
 * integration, so the session's cwd is something the daemon can read back off its output.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Everything else in the daemon's own env stays behind; a shell only gets these, when present. */
const ENV_WHITELIST = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "LC_CTYPE",
] as const;

const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DEFAULT_LANG = "en_US.UTF-8";

export type TerminalEnvOptions = {
  shell: string;
  zshIntegrationDir?: string | null;
  /** `defaults read -g AppleLocale`, e.g. `zh_CN`, `zh-Hans_CN`, `en_CN@currency=JPY`. */
  systemLocale?: string | null;
  /** launchd hands the daemon no USER/LOGNAME at all; this is what falls back to. */
  username?: string;
  /** Injectable so a test never depends on which locales this machine has installed. */
  localeAvailable?: (name: string) => boolean;
};

/** Whether macOS ships `<name>.UTF-8`'s tables — the same thing Terminal.app effectively checks. */
export function defaultLocaleAvailable(name: string): boolean {
  return existsSync(`/usr/share/locale/${name}.UTF-8`);
}

/**
 * `defaults read -g AppleLocale` values look like `zh_CN`, `zh-Hans_CN`, or `en_CN@currency=JPY`.
 * `setlocale(3)` wants `<language>_<region>`, so the currency/variant suffix and any script
 * subtag between language and region are dropped before the `.UTF-8` a login shell expects.
 */
function deriveLang(systemLocale: string | null | undefined, available: (name: string) => boolean): string {
  if (!systemLocale) return DEFAULT_LANG;
  const withoutVariant = systemLocale.split("@")[0] ?? systemLocale;
  const hyphen = withoutVariant.indexOf("-");
  let name = withoutVariant;
  if (hyphen !== -1) {
    const language = withoutVariant.slice(0, hyphen);
    const rest = withoutVariant.slice(hyphen + 1);
    const underscore = rest.indexOf("_");
    const region = underscore !== -1 ? rest.slice(underscore + 1) : "";
    name = region ? `${language}_${region}` : language;
  }
  return available(name) ? `${name}.UTF-8` : DEFAULT_LANG;
}

/**
 * A pure function: the caller supplies everything machine- or process-specific (locale,
 * username), so this needs nothing injected to be tested.
 */
export function terminalEnv(source: Record<string, string | undefined>, options: TerminalEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.PATH = source.PATH !== undefined ? source.PATH : DEFAULT_PATH;
  if (env.USER === undefined && options.username) env.USER = options.username;
  if (env.LOGNAME === undefined && options.username) env.LOGNAME = options.username;

  env.SHELL = options.shell;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "RealBot";

  // A daemon started from launchd has neither LANG nor LC_ALL at all; left alone, a shell falls
  // back to POSIX and mangles anything non-ASCII. Derive what Terminal.app would show instead of
  // forcing the same locale on every machine.
  if (source.LANG === undefined && source.LC_ALL === undefined) {
    env.LANG = deriveLang(options.systemLocale, options.localeAvailable ?? defaultLocaleAvailable);
  }

  if (basename(options.shell) === "zsh" && options.zshIntegrationDir) {
    env.ZDOTDIR = options.zshIntegrationDir;
    if (source.ZDOTDIR !== undefined) env.REAL_BOT_ZSH_ZDOTDIR = source.ZDOTDIR;
  }

  return env;
}

let cachedSystemLocale: string | null | undefined;

/** `defaults read -g AppleLocale`, cached: it does not change over the life of the process. */
export function macSystemLocale(): string | null {
  if (cachedSystemLocale === undefined) {
    try {
      const result = Bun.spawnSync(["defaults", "read", "-g", "AppleLocale"]);
      const text = result.success ? result.stdout.toString("utf8").trim() : "";
      cachedSystemLocale = text || null;
    } catch {
      cachedSystemLocale = null;
    }
  }
  return cachedSystemLocale;
}

/**
 * Ghostty and VS Code's technique: `.zshenv` is the only zsh startup file guaranteed to run, so
 * it is the only one Real Bot needs to own. It puts the user's own `ZDOTDIR` back (or unsets it)
 * before sourcing their real `.zshenv`, so every later startup file — `.zshrc` included — runs
 * exactly as it would in Terminal.app. The `precmd` hook it installs is what makes {@link
 * ensureZshIntegration}'s directory report the session's cwd back to the daemon (see
 * `terminal-cwd.ts`), the same way `/etc/zshrc_Apple_Terminal` does for Terminal.app.
 */
const ZSHENV_CONTENT = `# Real Bot shell integration, written by the daemon; edits here are overwritten.
# Put ZDOTDIR back before anything else, so every later startup file is the user's own.
if [[ -n "\${REAL_BOT_ZSH_ZDOTDIR+X}" ]]; then
  builtin export ZDOTDIR="$REAL_BOT_ZSH_ZDOTDIR"
  builtin unset REAL_BOT_ZSH_ZDOTDIR
else
  builtin unset ZDOTDIR
fi
{
  builtin typeset _real_bot_file="\${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$_real_bot_file" ]] || builtin source -- "$_real_bot_file"
} always {
  builtin unset _real_bot_file
  if [[ -o interactive ]]; then
    # Report the working directory at each prompt (OSC 7), the way /etc/zshrc_Apple_Terminal does.
    _real_bot_report_cwd() {
      local url_path='' i ch hexch LC_CTYPE=C LC_COLLATE=C LC_ALL= LANG=
      for ((i = 1; i <= \${#PWD}; ++i)); do
        ch="$PWD[i]"
        if [[ "$ch" =~ [/._~A-Za-z0-9-] ]]; then
          url_path+="$ch"
        else
          printf -v hexch "%02X" "'$ch"
          url_path+="%$hexch"
        fi
      done
      printf '\\e]7;%s\\a' "file://$HOST$url_path"
    }
    builtin autoload -Uz add-zsh-hook
    add-zsh-hook precmd _real_bot_report_cwd
  fi
}
`;

/**
 * Writes (or rewrites, if stale) `<dataDir>/shell-integration/zsh/.zshenv` and returns its
 * directory. Returns `null` and swallows the error if the file cannot be written — a terminal
 * must still open even if, say, the data dir is somehow read-only.
 */
export function ensureZshIntegration(dataDir: string): string | null {
  try {
    const dir = join(dataDir, "shell-integration", "zsh");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".zshenv");
    let current: string | null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current !== ZSHENV_CONTENT) writeFileSync(file, ZSHENV_CONTENT);
    return dir;
  } catch {
    return null;
  }
}
