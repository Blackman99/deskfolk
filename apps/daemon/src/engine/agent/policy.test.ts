import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRecordDirs, namesAgentSettingsFile, withoutHomeGlobs, withoutOpenDirs, withoutQuotedHomes } from "./credentials";
import { decideAction, type ActionContext, type AppAction } from "./policy";

// A fake home on this machine's disk, so links can be followed: an agent's own folder in it, with
// one folder of it open (its memory) and a link in there leading out to its sign-in.
const home = realpathSync(mkdtempSync(join(tmpdir(), "agent-open-home-")));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agent-open-ws-")));
const memory = join(home, ".codex", "memories");
const brain = join(home, ".gemini", "antigravity-cli", "brain", "session-1");
mkdirSync(memory, { recursive: true });
mkdirSync(brain, { recursive: true });
writeFileSync(join(home, ".codex", "auth.json"), "{}");
writeFileSync(join(memory, "notes.md"), "x");
symlinkSync(join(home, ".codex", "auth.json"), join(memory, "sneaky.md"));
const posixTest = test.skipIf(process.platform === "win32");

const base: ActionContext = { mode: "work", workspace, home, permission: "auto", openDirs: [memory, brain] };
const write = (path: string): AppAction => ({ appName: "write_file", vendorTool: "write_file", paths: [path], cwd: workspace });
const read = (path: string): AppAction => ({ appName: "read_file", vendorTool: "view_file", paths: [path], cwd: workspace });
const shell = (command: string): AppAction => ({ appName: "shell", vendorTool: "shell", paths: [], command, cwd: workspace });

posixTest("a file in an open folder of the agent's own is a folder outside: reads run, writes go by the mode", () => {
  expect(decideAction(read(join(memory, "notes.md")), base).kind).toBe("allow");
  expect(decideAction(write(join(brain, "implementation_plan.md")), base)).toMatchObject({ kind: "allow", effect: true });
  expect(decideAction(write(join(brain, "plan.md")), { ...base, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(write(join(brain, "plan.md")), { ...base, permission: "read_only" }).kind).toBe("deny");
  // No open folders: the same file is the agent's own, as before.
  expect(decideAction(read(join(memory, "notes.md")), { ...base, openDirs: [] })).toEqual({ kind: "deny", reason: expect.stringContaining("credentials") });
});

posixTest("the rest of the agent's folder stays shut: beside it, out of it by climbing or by a link, another session's", () => {
  for (const path of [join(home, ".codex", "auth.json"), join(memory, "..", "auth.json"), join(memory, "sneaky.md"),
    join(home, ".gemini", "antigravity-cli", "brain", "session-2", "plan.md"), `${memory}-old/a.md`, join(home, ".gemini", "oauth_creds.json")]) {
    expect([path, decideAction(read(path), { ...base, permission: "allow_all" }).kind]).toEqual([path, "deny"]);
  }
});

posixTest("a command may name an open folder only where it cannot leave it", () => {
  for (const command of [`cat ${memory}/notes.md`, "cat ~/.codex/memories/notes.md", "ls $HOME/.codex/memories", `rg TODO ${brain}`]) {
    expect([command, decideAction(shell(command), base).kind]).toEqual([command, "allow"]);
  }
  for (const command of [
    "cat ~/.codex/auth.json",
    "cat ~/.codex/memories/notes.md ~/.codex/auth.json",
    "cat ~/.codex/memories/../auth.json",
    "cd ~/.codex/memories && cat ../auth.json",
    "cat ~/.codex/memories/sneaky.md",
    "cat $(echo ~/.codex/memories)/notes.md",
    "cat ~/.codex/memories/$NAME",
    "cat ~/.gemini/antigravity-cli/brain/session-2/plan.md",
    // Handed on to be built on: a variable's value, a loop's list, a substitution's output.
    "D=~/.codex/memories; cat $D/sneaky.md",
    "export D=\"$HOME/.codex/memories\" && cd /tmp && cat \"$D\"/sneaky.md",
    "for d in ~/.codex/memories; do cat $d/sneaky.md; done",
    "cat $(echo x; echo ~/.codex/memories)/sneaky.md",
    "cat `echo ~/.codex/memories`/sneaky.md",
    // Built on where it is named, quoted or not.
    "cat \"$HOME/.codex/memories\"/$NAME",
    "cat \"$HOME/.codex/memories/my notes $NAME\"",
    "cat ~/.codex/memories/\"$(cat /tmp/p)\"",
    "cat ~/.codex/memories/$'sneaky.md'",
    // A cd into it, however late in the list.
    "cd /tmp && cd ~/.codex/memories && cat sneaky.md",
    "echo ~/.codex/memories | xargs -I{} cat {}/../auth.json",
  ]) {
    expect([command, decideAction(shell(command), base).kind]).toEqual([command, "deny"]);
  }
});

posixTest("a cd or a $(…) elsewhere in the list does not shut out a command that names an open folder only as a file to write", () => {
  // As agy ran it on 2026-11-23: build in a worktree, then keep a script in its own folder for the session.
  const script = [
    "cd /tmp && git cherry-pick b2db52f && pnpm exec tsc --noEmit && rm -rf .next",
    "(export $(grep -v '^#' .env.test | xargs) && pnpm run build)",
    "COMMIT=$(git rev-parse --short=7 HEAD)",
    "COPYFILE_DISABLE=1 tar --exclude='node_modules' -czf \"/tmp/webapp-test-${COMMIT}.tar.gz\" .next package.json",
    "echo \"COMMIT=$COMMIT\"",
    `python3 -c '
import pathlib, textwrap
lines = pathlib.Path(".github/workflows/deploy-test.yml").read_text().splitlines()
start = next(i for i, l in enumerate(lines) if "bash -s\\" <<'\\''REMOTE'\\''" in l) + 1
end = next(i for i in range(start, len(lines)) if lines[i] == "          REMOTE")
script = textwrap.dedent("\\n".join(lines[start:end])) + "\\n"
out = pathlib.Path("${brain}/scratch/deploy-remote.sh")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(script)
'`,
  ].join(" && ");
  // And the steps after it: a variable beside the folder's path, not in it.
  const next = [
    `ssh deploy@test-host "COMMIT=$COMMIT bash -s" < ${brain}/scratch/deploy-remote.sh`,
    `cp "/tmp/webapp-test-\${COMMIT}.tar.gz" "${brain}/scratch/"`,
    `bash ${brain}/scratch/deploy-remote.sh "$COMMIT"`,
  ];
  for (const command of [script, ...next, `cd /tmp && V=$(date) && cp notes.md ${brain}/scratch/`, `cat > ${brain}/scratch/run.sh <<'EOF'\necho "$HOME $PATH"\nEOF`]) {
    expect([command, decideAction(shell(command), base)]).toEqual([command, expect.objectContaining({ kind: "allow" })]);
  }
});

// Claude Code's records beside its settings and sign-in, and a link among the records leading out to the sign-in.
const claudeRecords = join(home, ".claude", "projects");
mkdirSync(join(claudeRecords, "-Users-someone-proj"), { recursive: true });
writeFileSync(join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl"), "{}\n");
writeFileSync(join(home, ".claude", "settings.json"), "{}");
writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
symlinkSync(join(home, ".claude", ".credentials.json"), join(claudeRecords, "-Users-someone-proj", "sneaky.jsonl"));
const records = agentRecordDirs(home, () => []);
const session: ActionContext = { ...base, readableDirs: records };
// As agy ran it on 2026-11-23, asked why Claude's context showed 200k: the newest five transcripts' last usage.
const transcripts = String.raw`python3 -c '
import glob, json, os
files = sorted(glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")), key=os.path.getmtime, reverse=True)[:5]
for f in files:
    print("=== FILE:", os.path.basename(f))
    with open(f, "rb") as fp:
        fp.seek(max(0, os.path.getsize(f) - 200000))
        lines = fp.read().decode("utf-8", "ignore").splitlines()
    for line in reversed(lines):
        if "\"cost-state\"" in line:
            d = json.loads(line)
            print("  cost-state:", json.dumps({k: {kk: vv for kk, vv in v.items() if kk in ("contextWindow", "maxOutputTokens")} for k, v in d.get("modelUsage", {}).items()}))
            break
    for line in reversed(lines):
        if "\"assistant\"" in line and "\"usage\"" in line:
            d = json.loads(line)
            if d.get("type") == "assistant" and not d.get("isSidechain"):
                m = d.get("message", {})
                print("  last assistant:", m.get("model"), m.get("usage"))
                break
'`;

test("your agents' conversation records are where each keeps them, in its own home and in each account you listed", () => {
  expect(agentRecordDirs("/h", (runner) => (runner === "claude_code" ? ["/h/.claude-b"] : ["/h/grok-work"]), "darwin")).toEqual([
    "/h/.claude/projects", "/h/.claude-b/projects", "/h/.grok/sessions", "/h/grok-work/sessions",
  ]);
  expect(agentRecordDirs("C:\\Users\\h", () => [], "win32")).toEqual(["C:\\Users\\h\\.claude\\projects", "C:\\Users\\h\\.grok\\sessions"]);
});

posixTest("a project session's agent reads your agents' conversation records, by file or by command, as any folder outside", () => {
  expect(decideAction(shell(transcripts), session)).toMatchObject({ kind: "allow" });
  expect(decideAction(shell(transcripts), { ...session, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(read(join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl")), session).kind).toBe("allow");
  expect(decideAction({ appName: "list_dir", vendorTool: "find_by_name", paths: [claudeRecords], cwd: workspace }, session).kind).toBe("allow");
  for (const command of ["ls -t ~/.claude/projects/-Users-someone-proj | head -5", `tail -c 200000 ${claudeRecords}/-Users-someone-proj/47ce0671.jsonl`, "rg -l contextWindow ~/.claude/projects"]) {
    expect([command, decideAction(shell(command), session).kind]).toEqual([command, "allow"]);
  }
  // Elsewhere, and for a Bot, they are an agent's own folder still.
  expect(decideAction(shell(transcripts), base)).toEqual({ kind: "deny", reason: expect.stringContaining("credentials") });
  expect(decideAction(read(join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl")), base).kind).toBe("deny");
});

posixTest("the records are read, never written, and nothing beside them opens", () => {
  expect(decideAction(write(join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl")), { ...session, permission: "allow_all" })).toEqual({ kind: "deny", reason: expect.stringContaining("credentials") });
  for (const path of [join(home, ".claude", "settings.json"), join(home, ".claude", ".credentials.json"), join(home, ".claude.json"), join(home, ".claude"),
    join(claudeRecords, "..", "settings.json"), join(claudeRecords, "-Users-someone-proj", "sneaky.jsonl"), `${claudeRecords}-old/a.jsonl`]) {
    expect([path, decideAction(read(path), { ...session, permission: "allow_all" }).kind]).toEqual([path, "deny"]);
  }
  for (const command of [
    "cat ~/.claude/settings.json",
    "ls ~/.claude",
    "cat ~/.claude/projects/-Users-someone-proj/47ce0671.jsonl ~/.claude.json",
    "cat ~/.claude/projects/../.credentials.json",
    "cd ~/.claude/projects && cat ../settings.json",
    "cat ~/.claude/projects/-Users-someone-proj/sneaky.jsonl",
    "D=~/.claude/projects; cat $D/../settings.json",
  ]) {
    expect([command, decideAction(shell(command), session).kind]).toEqual([command, "deny"]);
  }
});

// A second Claude account you listed, an old folder named like one you did not, and the sign-in file the glob below could match.
mkdirSync(join(home, ".claude-b", "projects", "-p"), { recursive: true });
writeFileSync(join(home, ".claude-b", "projects", "-p", "a.jsonl"), "{}\n");
writeFileSync(join(home, ".claude-b", ".credentials.json"), "{}");
mkdirSync(join(home, ".claude-old", "projects"), { recursive: true });
writeFileSync(join(home, ".claude.json"), "{}");
const accounts: ActionContext = {
  ...base, configDirs: [join(home, ".claude-b")],
  readableDirs: agentRecordDirs(home, (runner) => (runner === "claude_code" ? [join(home, ".claude-b")] : [])),
};

posixTest("a glob over every account's folder at once reads each one it matches; one reaching anything else stays shut", () => {
  // As agy ran it next on 2026-11-23, told 「继续」: the transcripts of every Claude account.
  const everyAccount = transcripts.replace("~/.claude/projects/*/*.jsonl", "~/.claude*/projects/*/*.jsonl");
  expect(decideAction(shell(everyAccount), accounts)).toMatchObject({ kind: "allow" });
  for (const command of ["ls -t ~/.claude*/projects | head", "cat $HOME/.claude*/projects/-p/a.jsonl", `wc -l ${home}/.claude?b/projects/-p/*.jsonl`]) {
    expect([command, decideAction(shell(command), accounts).kind]).toEqual([command, "allow"]);
  }
  // A path built on it goes by the mode too, and stays shut for a Bot.
  expect(decideAction(shell("cat ~/.claude*/projects/$NAME"), accounts).kind).toBe("allow");
  expect(decideAction(shell("cat ~/.claude*/projects/$NAME"), { ...base, configDirs: [join(home, ".claude-b")] }).kind).toBe("deny");
  // A Bot, as before; a glob reaching settings or sign-in, the folders themselves, a climb, a cd and a climb.
  expect(decideAction(shell(everyAccount), { ...base, configDirs: [join(home, ".claude-b")] }).kind).toBe("deny");
  for (const command of [
    "cat ~/.claude*/settings.json",
    "cat ~/.claude*/.credentials.json",
    "ls ~/.claude*",
    "ls ~/.claude*/",
    "cat ~/.claude*/projects/../settings.json",
    "cd ~/.claude*/projects && cat ../settings.json",
    "cat ~/.claude*/projects/$NAME ~/.claude*/projects/$OTHER/../x",
    "cat ~/.claude*/projects/-p/a.jsonl ~/.claude.json",
  ]) {
    expect([command, decideAction(shell(command), accounts).kind]).toEqual([command, "deny"]);
  }
});

test("withoutHomeGlobs takes out a glob under home only where every folder it matches is fine", () => {
  const folders = () => [".claude", ".claude-b", ".codex", "work"];
  const fine = (abs: string) => !abs.startsWith("/h/.codex");
  expect(withoutHomeGlobs("cat ~/.claude*/projects/a.jsonl", "/h", "darwin", folders, fine)).toBe("cat OPEN_DIR");
  expect(withoutHomeGlobs("cat ~/.c*/x", "/h", "darwin", folders, fine)).toBe("cat ~/.c*/x");
  // A glob not starting with a dot matches no dot folder; one matching nothing names nothing.
  expect(withoutHomeGlobs("cat ~/*/x", "/h", "darwin", () => [".codex", "work"], fine)).toBe("cat OPEN_DIR");
  expect(withoutHomeGlobs("cat ~/.nothing*/x", "/h", "darwin", folders, fine)).toBe("cat OPEN_DIR");
  expect(withoutHomeGlobs("cat ~/.claude*/projects/../../.codex/auth.json", "/h", "darwin", folders, fine)).toBeNull();
  expect(withoutHomeGlobs("cat ~/.claude/projects/a.jsonl", "/h", "darwin", folders, fine)).toBe("cat ~/.claude/projects/a.jsonl");
  expect(withoutHomeGlobs("type C:\\Users\\h\\.claude*\\projects\\a", "C:\\Users\\h", "win32", folders, fine)).toBe("type C:\\Users\\h\\.claude*\\projects\\a");
});

test("withoutOpenDirs takes out only what stays in", () => {
  const stays = (abs: string) => !abs.endsWith("link");
  expect(withoutOpenDirs("cat /h/.codex/memories/a.md", ["/h/.codex/memories"], "/h", "darwin", stays)).toBe("cat OPEN_DIR");
  expect(withoutOpenDirs("cat ~/.codex/memories/a.md ~/.codex/auth.json", ["/h/.codex/memories"], "/h", "darwin", stays)).toBe("cat OPEN_DIR ~/.codex/auth.json");
  expect(withoutOpenDirs("cat ~/.codex/memories/link", ["/h/.codex/memories"], "/h", "darwin", stays)).toBeNull();
  expect(withoutOpenDirs("cat ~/.codex/memories/../auth.json", ["/h/.codex/memories"], "/h", "darwin", stays)).toBeNull();
  expect(withoutOpenDirs("anything", [], "/h", "darwin", stays)).toBe("anything");
  // Windows: a cd or a $(…) elsewhere leaves it open; a cd into it or a variable holding it does not.
  const win = (command: string) => withoutOpenDirs(command, ["C:\\Users\\h\\.codex\\memories"], "C:\\Users\\h", "win32", stays);
  expect(win("cd C:\\repo; $v = $(git rev-parse HEAD); Copy-Item notes.md C:\\Users\\h\\.codex\\memories\\notes.md")).toBe("cd C:\\repo; $v = $(git rev-parse HEAD); Copy-Item notes.md OPEN_DIR");
  expect(win("cd C:\\Users\\h\\.codex\\memories && type sneaky.md")).toBeNull();
  expect(win("set D=C:\\Users\\h\\.codex\\memories&& type %D%\\sneaky.md")).toBeNull();
  expect(win("type \"C:\\Users\\h\\.codex\\memories\\$name\"")).toBeNull();
});

// As agy ran it on 2026-11-23 at 23:13 (UTC), asked why the composer's usage showed a number and no ring: each
// session's record found by joining its account folder (from Deskfolk's own database, ~/.claude when
// none) with projects/*/<session>.jsonl, the folder handed to Python as a string it expands itself.
const joined = String.raw`python3 -c '
import glob, json, os, sqlite3
con = sqlite3.connect(os.path.expanduser("~/Library/Application Support/real-bot/state.sqlite"))
for sid in ("01M83K5FMASN9S188KRE5ECDZR", "01M83W1CHVXCHB1YCZ3R3992EE", "01M84BJ8THPDE0JHG144ZN8TF2"):
    row = con.execute("SELECT id, project_config_dir, project_agent_session, project_context FROM sessions WHERE id = ?", (sid,)).fetchone()
    runs = con.execute("SELECT id, status, created_at, updated_at FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 3", (sid,)).fetchall()
    print("=== SESSION:", row)
    print("  runs:", runs)
    agent_sid = row[2]
    config_dir = row[1] or os.path.expanduser("~/.claude")
    matches = glob.glob(os.path.join(os.path.expanduser(config_dir), "projects", "*", f"{agent_sid}.jsonl"))
    print("  files:", matches)
    for f in matches:
        size = os.path.getsize(f)
        print("  size:", size)
        types = {}
        cost_states = []
        last_assistants = []
        with open(f, "r", encoding="utf-8", errors="ignore") as fp:
            for idx, line in enumerate(fp):
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                t = d.get("type")
                types[t] = types.get(t, 0) + 1
                if t == "cost-state":
                    cost_states.append((idx, d))
                elif t == "assistant" and not d.get("isSidechain"):
                    m = d.get("message") or {}
                    if m.get("usage"):
                        last_assistants.append((idx, m.get("model"), m.get("usage"), d.get("context_usage")))
        print("  types:", types)
        print("  cost_states count:", len(cost_states), "last:", cost_states[-1] if cost_states else None)
        print("  last assistant:", last_assistants[-1] if last_assistants else None)
'`;

posixTest("a program handed an agent's folder as a string of its own builds its paths on it; the command goes by the mode", () => {
  expect(decideAction(shell(joined), session)).toMatchObject({ kind: "allow" });
  expect(decideAction(shell(joined), { ...session, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(shell(joined), { ...session, permission: "read_only" })).toEqual({ kind: "deny", reason: expect.not.stringContaining("credentials") });
  // Elsewhere, and for a Bot, it names an agent's own folder still.
  expect(decideAction(shell(joined), base)).toEqual({ kind: "deny", reason: expect.stringContaining("credentials") });
  for (const command of [
    `python3 -c "import os; print(os.listdir(os.path.join(os.path.expanduser('~/.claude'), 'projects')))"`,
    String.raw`python3 -c "import os; print(os.path.expanduser(\"~/.claude/\"))"`,
    `python3 - <<'EOF'\nimport os\nbase = os.path.expanduser("~/.claude")\nprint(os.listdir(os.path.join(base, "projects")))\nEOF`,
    `cd /tmp && python3 <<-PY\n\tfrom pathlib import Path\n\tprint(sorted((Path("~/.claude").expanduser() / "projects").glob("*/*.jsonl"))[-1])\n\tPY`,
    `node -e 'console.log(require("os").homedir(), "~/.codex")'`,
  ]) {
    expect([command, decideAction(shell(command), session).kind]).toEqual([command, "allow"]);
  }
  // An account folder you listed, as the default one.
  expect(decideAction(shell(joined.replace(`"~/.claude"`, `"~/.claude-b"`)), accounts).kind).toBe("allow");
});

posixTest("a path built on the records goes by the mode in a project session: a loop, a variable, a cd into them", () => {
  for (const command of [
    "for f in ~/.claude/projects/*/*.jsonl; do wc -l \"$f\"; done",
    "F=$(ls -t ~/.claude/projects/-Users-someone-proj/*.jsonl | head -1); tail -c 2000 \"$F\"",
    "SID=47ce0671; tail -5 ~/.claude/projects/-Users-someone-proj/$SID.jsonl",
    "cd ~/.claude/projects && ls -t | head",
    `python3 -c '\nimport glob, os\nfor f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):\n    print(f)\n'`,
  ]) {
    expect([command, decideAction(shell(command), session).kind]).toEqual([command, "allow"]);
    expect([command, decideAction(shell(command), base).kind]).toEqual([command, "deny"]);
  }
});

posixTest("the folder itself as the shell reads it, a climb, a sign-in or settings file named beside it: shut still", () => {
  const py = (body: string) => `python3 -c '\n${body}\n'`;
  for (const command of [
    // The shell reads the folder: as a path, through a variable, handed to another shell.
    "ls ~/.claude", "ls \"$HOME/.claude\"", "grep -r token ~/.claude", "cp -R ~/.claude /tmp/x", "find ~/.claude -name '*.json'",
    "cd ~/.claude && cat .cred*", "D=~/.claude; cat $D/x", "bash -c 'ls ~/.claude'", "bash -c \"ls ~/.claude\"",
    // Quotes the shell reads as quotes, not as a string's own: the ~ is bare where it lands.
    "bash -c \"ls \"~/.claude\"\"", "zsh -c 'ls \"\"~/.claude\"\"'", "eval ls \"~/.claude\"", "ls \\\"~/.claude\\\"",
    // A string naming more than the folder, or a glob over it.
    py(`import os\nprint(open(os.path.expanduser("~/.claude/settings.json")).read())`),
    py(`import glob, os\nprint(glob.glob(os.path.expanduser("~/.claude*")))`),
    // Built on, and naming a sign-in or settings file too.
    py(`import os\nprint(open(os.path.join(os.path.expanduser("~/.claude"), ".credentials.json")).read())`),
    py(`import os\nprint(open(os.path.expanduser("~/.claude") + "/settings.local.json").read())`),
    py(`import os\nprint(open(os.path.expanduser("~/.codex") + "/auth.json").read())`),
    py(`import os\nprint(open(os.path.join(os.path.expanduser("~/.gemini"), "oauth_creds.json")).read())`),
    "cat \"$(dirname ~/.claude/projects)/settings.json\"",
    "D=~/.claude/projects; cat ${D%/*}/.credentials.json",
    // A climb, however it is written.
    py(`import os\nprint(os.listdir(os.path.join(os.path.expanduser("~/.claude/projects"), "..")))`),
    py(`import os\nprint(os.listdir(os.path.join(os.path.expanduser("~/.claude"), "..", ".codex")))`),
    "cd ~/.claude/projects; cd ..; cat x",
    "(cd ~/.claude/projects && cd ..&& cat x)",
    "cat ~/.claude/projects/-Users-someone-proj/sneaky.jsonl",
  ]) {
    expect([command, decideAction(shell(command), { ...session, permission: "allow_all" }).kind]).toEqual([command, "deny"]);
  }
});

test("withoutQuotedHomes takes out only an agent's folder in quotes no shell reads", () => {
  let told = 0;
  const unplaced = () => { told += 1; };
  const take = (command: string, configDirs: string[] = []) => withoutQuotedHomes(command, "/h", "darwin", configDirs, unplaced);
  expect(take(`python3 -c 'p = "~/.claude"'`)).toBe(`python3 -c 'p = "OPEN_DIR"'`);
  expect(take(`python3 -c "p = '~/.gemini/'"`)).toBe(`python3 -c "p = 'OPEN_DIR'"`);
  expect(take(`python3 -c "p = \\"~/.codex\\""`)).toBe(`python3 -c "p = \\"OPEN_DIR\\""`);
  expect(take(`python3 <<'EOF'\np = "~/.claude"\nEOF`)).toBe(`python3 <<'EOF'\np = "OPEN_DIR"\nEOF`);
  expect(take(`python3 -c 'p = "~/.claude-b"'`, ["/h/.claude-b"])).toBe(`python3 -c 'p = "OPEN_DIR"'`);
  expect(told).toBe(5);
  // The shell's own quotes, an empty string before it, more after it, a heredoc that has ended, Windows.
  for (const command of [`ls "~/.claude"`, `bash -c "ls "~/.claude""`, `zsh -c 'ls ""~/.claude""'`, `python3 -c 'p = "~/.claude/x"'`,
    `python3 -c 'p = "~/.claude-b"'`, `python3 -c 'p = "~/.claude*"'`, `cat <<EOF\nx\nEOF\nls "~/.claude"`, `echo $((1 << 2))\nls "~/.claude"`]) {
    expect([command, take(command)]).toEqual([command, command]);
  }
  expect(withoutQuotedHomes(`python3 -c 'p = "~/.claude"'`, "C:\\Users\\h", "win32", [], unplaced)).toBe(`python3 -c 'p = "~/.claude"'`);
  expect(take(`python3 -c 'p = os.path.join("~/.claude", "..")'`)).toBeNull();
  expect(told).toBe(5);
});

test("namesAgentSettingsFile knows your agents' sign-in and settings files by name, and nothing a usage script reads", () => {
  for (const name of [".credentials.json", "settings.json", "settings.local.json", "auth.json", "config.toml", "work.config.toml", "oauth_creds.json",
    "google_accounts.json", ".env", "user-settings.json", "mcp-oauth-tokens.json", ".claude.json", ".cred*"]) {
    expect([name, namesAgentSettingsFile(`cat "/x/${name}"`)]).toEqual([name, true]);
  }
  expect(namesAgentSettingsFile(joined)).toBe(false);
  expect(namesAgentSettingsFile(transcripts)).toBe(false);
  for (const text of ["process.env.HOME", "tsconfig.json", "input_tokens", "x.jsonl", ".envrc", "credit.txt"]) {
    expect([text, namesAgentSettingsFile(`cat ${text}`)]).toEqual([text, false]);
  }
  // The names only the file-by-file rule reads are not among them: what an agent that asks first is refused is as it was.
  for (const name of ["mcp_config.json", "hooks.json", "mcp-auth.json", "opencode.json", "managed-settings.json"]) {
    expect([name, namesAgentSettingsFile(`cat "/x/${name}"`)]).toEqual([name, false]);
  }
});

// An agent that cannot be made to ask first (Antigravity): its own folder with what it ships with, its
// settings and its sign-in file; links in there, one to that sign-in and one out to Codex's; other agents' skills and records.
const gemini = join(home, ".gemini");
const guide = join(gemini, "antigravity-cli", "builtin", "skills", "antigravity_guide");
mkdirSync(join(guide, "references"), { recursive: true });
mkdirSync(join(gemini, "antigravity-cli", "skills"), { recursive: true });
mkdirSync(join(gemini, "config"), { recursive: true });
mkdirSync(join(home, ".claude", "skills", "x"), { recursive: true });
mkdirSync(join(home, ".codex", "sessions", "2026"), { recursive: true });
writeFileSync(join(guide, "SKILL.md"), "x");
writeFileSync(join(gemini, "oauth_creds.json"), "{}");
writeFileSync(join(gemini, "antigravity-cli", "settings.json"), "{}");
writeFileSync(join(home, ".claude", "skills", "x", "SKILL.md"), "x");
writeFileSync(join(home, ".codex", "sessions", "2026", "rollout.jsonl"), "{}\n");
symlinkSync(join(gemini, "oauth_creds.json"), join(gemini, "antigravity-cli", "skills", "linked.md"));
symlinkSync(join(home, ".codex", "auth.json"), join(gemini, "antigravity-cli", "skills", "out.md"));
const unasked: ActionContext = { ...accounts, openDirs: [brain], ownAgentDirs: [gemini] };
const list = (path: string): AppAction => ({ appName: "list_dir", vendorTool: "find_by_name", paths: [path], cwd: workspace });

posixTest("an agent that cannot ask first uses its own folder as in its terminal: what it ships with, its settings, what signs it in, the folder itself", () => {
  // As agy ran them: the read stopped late on 2026-11-23, what it did in its terminal sessions before, and where it looked next for the plan's tier.
  for (const path of [join(guide, "SKILL.md"), join(guide, "references", "cli.md"), join(gemini, "antigravity-cli", "settings.json"), join(gemini, "settings.json"),
    join(gemini, "config", "mcp_config.json"), join(gemini, "GEMINI.md"), join(gemini, "antigravity-cli", "brain", "session-2", "plan.md"), join(gemini, "antigravity-cli", "log", "cli-1.log"),
    join(gemini, "oauth_creds.json"), join(gemini, "google_accounts.json"), join(gemini, ".env"), join(gemini, "antigravity-cli", "skills", "linked.md")]) {
    expect([path, decideAction(read(path), unasked).kind]).toEqual([path, "allow"]);
    // A Bot, and an agent that asks first, as before.
    expect([path, decideAction(read(path), base).kind]).toEqual([path, "deny"]);
    expect([path, decideAction(read(path), session).kind]).toEqual([path, "deny"]);
  }
  expect(decideAction(list(join(gemini, "antigravity-cli")), unasked).kind).toBe("allow");
  for (const command of [
    "ls -la ~/.gemini/ ~/.gemini/antigravity-cli/ 2>/dev/null; cat ~/.gemini/antigravity-cli/settings.json ~/.gemini/settings.json 2>/dev/null | head -n 60 || true",
    "rg -i \"orchestrator\" apps/ docs/ packages/ ~/.gemini/antigravity-cli/builtin/ 2>/dev/null | head -n 40 || true",
    `rm -f "$HOME/Library/Application Support/x/data.db" && ls -la ${guide}/references/`,
    "cd ~/.gemini/antigravity-cli && ls && cat settings.json",
    "cat \"$HOME/.gemini/config/mcp_config.json\"",
    "for f in ~/.gemini/antigravity-cli/builtin/skills/*/SKILL.md; do head -5 \"$f\"; done",
    `python3 -c 'import os; print(os.listdir(os.path.expanduser("~/.gemini/antigravity-cli")))'`,
    "cat ~/.gemini/oauth_creds.json", "cat ~/.gemini/google_accounts.json ~/.gemini/antigravity-cli/state.json", "cd ~/.gemini && cat oauth_creds.json settings.json",
    "cat ~/.gemini/antigravity-cli/brain/../../oauth_creds.json",
    `python3 -c 'import json, os; print(list(json.load(open(os.path.join(os.path.expanduser("~/.gemini"), "oauth_creds.json")))))'`,
  ]) {
    expect([command, decideAction(shell(command), unasked)]).toEqual([command, expect.objectContaining({ kind: "allow" })]);
    expect([command, decideAction(shell(command), base).kind]).toEqual([command, "deny"]);
  }
  // Its own folder is its own to change too, as the permission mode has it.
  expect(decideAction(write(join(gemini, "antigravity-cli", "settings.json")), unasked)).toMatchObject({ kind: "allow", effect: true });
  expect(decideAction(write(join(gemini, "oauth_creds.json")), { ...unasked, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(write(join(gemini, "antigravity-cli", "skills", "mine", "SKILL.md")), { ...unasked, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(write(join(gemini, "GEMINI.md")), { ...unasked, permission: "read_only" })).toEqual({ kind: "deny", reason: expect.not.stringContaining("credentials") });
  expect(decideAction(shell("ls ~/.gemini/antigravity-cli"), { ...unasked, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(shell("ls ~/.gemini/antigravity-cli"), { ...unasked, permission: "read_only" })).toEqual({ kind: "deny", reason: expect.not.stringContaining("credentials") });
});

posixTest("for it the other agents' folders are read as any folder outside, by file or by command", () => {
  for (const path of [join(home, ".claude", "skills", "x", "SKILL.md"), join(home, ".claude", "CLAUDE.md"), join(home, ".claude", "keybindings.json"), join(home, ".claude"),
    join(home, ".codex", "sessions", "2026", "rollout.jsonl"), join(home, ".codex", "AGENTS.md"), join(home, ".claude-b", "skills", "y.md"), join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl")]) {
    expect([path, decideAction(read(path), unasked).kind]).toEqual([path, "allow"]);
  }
  expect(decideAction(list(join(home, ".codex")), unasked).kind).toBe("allow");
  for (const command of [
    "ls ~/.claude", "ls \"$HOME/.claude\"", "find ~/.claude -name '*.md'", "cat ~/.codex/sessions/2026/rollout.jsonl", "cd ~/.claude/skills && ls", "wc -l ~/.claude-b/projects/-p/a.jsonl",
    "D=~/.codex/sessions; ls -t $D | head", "for f in ~/.codex/sessions/*/*.jsonl; do wc -l \"$f\"; done", "ls -t ~/.claude*/projects | head",
    transcripts, joined,
    // A sign-in or settings name written as a path of some other place is some other file's.
    "rg -n contextWindow ~/.claude/projects apps/daemon/config.json", "ls ~/.claude/skills && cat .env", "cat ~/.codex/AGENTS.md packages/x/settings.json",
  ]) {
    expect([command, decideAction(shell(command), unasked)]).toEqual([command, expect.objectContaining({ kind: "allow" })]);
  }
  // What is built in its own notes for the session reaches no further, whatever else the command names.
  for (const command of [`cd /tmp && V=$(date) && python3 -c 'import pathlib; pathlib.Path("${brain}/scratch/deploy.sh").write_text("scp .env host:")'`, `cat ${brain}/plan.md && cat .env auth.json`]) {
    expect([command, decideAction(shell(command), unasked)]).toEqual([command, expect.objectContaining({ kind: "allow" })]);
  }
});

posixTest("what signs another agent in or sets it up stays off limits to it", () => {
  for (const path of [
    // Sign-in: another agent's, an account's you listed, through a link out of its own folder, the keychains.
    join(home, ".claude", ".credentials.json"), join(home, ".claude-b", ".credentials.json"), join(home, ".codex", "auth.json"), join(home, ".grok", "auth.json"),
    join(home, ".codex", "mcp-oauth-tokens.json"), join(gemini, "antigravity-cli", "skills", "out.md"),
    join(home, ".local", "share", "opencode", "auth.json"), join(home, ".local", "share", "opencode", "mcp-auth.json"), join(home, "Library", "Keychains", "login.keychain-db"),
    // Another agent's settings.
    join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json"), join(home, ".claude", "managed-settings.json"), join(home, ".claude.json"),
    join(home, ".claude.json.backup"), join(home, ".claude", "backups", ".claude.json.backup.1763900000000"), join(home, ".claude", ".mcp.json"), join(home, ".claude-b", "settings.json"),
    join(home, ".codex", "config.toml"), join(home, ".codex", "work.config.toml"), join(home, ".codex", "hooks.json"), join(home, ".grok", "user-settings.json"),
    join(home, ".config", "opencode", "opencode.json"), join(claudeRecords, "..", "settings.json"),
  ]) {
    expect([path, decideAction(read(path), { ...unasked, permission: "allow_all" }).kind]).toEqual([path, "deny"]);
  }
  const py = (body: string) => `python3 -c '\n${body}\n'`;
  for (const command of [
    // Named outright, as written or after a climb, through a glob on the folder's name, by a shell handed the command.
    "cat ~/.codex/auth.json", "cat ~/.claude/settings.json", "cat ~/.claude/projects/-Users-someone-proj/47ce0671.jsonl ~/.claude.json", "cat ~/.gemini/oauth_creds.json ~/.grok/auth.json",
    "cat ~/.gemini/antigravity-cli/../../.claude/settings.json", `cat ${brain}/../../../../.codex/auth.json`,
    "cat ~/.claude*/settings.json", "cat ~/.claude*/.credentials.json", "bash -c 'cat ~/.claude/.credentials.json'", "cat ~/.claude-b/settings.json",
    "cat ~/.gemini/antigravity-cli/skills/out.md", "grep -c x \"$HOME/.codex/auth.json\", done",
    // Worked from inside the folder or built on it, with such a file's name beside.
    "cd ~/.codex && cat auth.json", "cd ~/.claude && cat settings.json", "D=~/.codex; cat $D/auth.json", "cat \"$HOME/.codex\"/auth.json", "cd ~/.gemini && ls; cd ~/.grok && cat auth.json",
    "find ~/.claude -name settings.json -exec cat {} \\; | head; cd ~/.claude && cat .cred*",
    py(`import os\nprint(open(os.path.expanduser("~/.codex") + "/auth.json").read())`),
    py(`import os\nprint(open(os.path.join(os.path.expanduser("~/.claude"), "settings.local.json")).read())`),
    "D=~/.claude/projects; cat ${D%/*}/.credentials.json",
  ]) {
    expect([command, decideAction(shell(command), { ...unasked, permission: "allow_all" })]).toEqual([command, { kind: "deny", reason: expect.stringContaining("credentials") }]);
  }
});

posixTest("it reads the other agents' folders, and writes none of them with its file tools", () => {
  for (const path of [join(home, ".claude", "skills", "x", "SKILL.md"), join(home, ".claude", "CLAUDE.md"), join(home, ".codex", "AGENTS.md"), join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl"),
    join(home, ".claude-b", "skills", "y.md"), join(home, ".codex", "auth.json"), join(gemini, "antigravity-cli", "skills", "out.md")]) {
    expect([path, decideAction(write(path), { ...unasked, permission: "allow_all" })]).toEqual([path, { kind: "deny", reason: expect.stringContaining("credentials") }]);
  }
});

// A Bot's turn on such an agent: the agent's own folder named, and nothing else of the agents' open
// to it, neither notes of a session's own nor your agents' records.
const botTurn: ActionContext = { mode: "work", workspace, home, permission: "auto", configDirs: [join(home, ".claude-b")], ownAgentDirs: [gemini] };
const taskLog = join(gemini, "antigravity-cli", "brain", "14e7d9e6-d7f3-4a0f-b68b-6dd9cbe1d8ce", ".system_generated", "tasks", "task-246.log");

posixTest("a Bot's turn on an agent that cannot ask first goes by the same rules, with its own folder named and nothing else", () => {
  // As agy ran them in a Bot's long job on 2026-11-24, twice stopping the turn: what a command it left running printed, read back from its own notes.
  for (const command of [
    `ls -la clips/ && cat ${taskLog}`,
    `ls -la "${workspace}/work/a story/" "${workspace}/work/h3-short/clips/" && cat ${taskLog}`,
    `tail -n 40 ${taskLog}`, "cd ~/.gemini/antigravity-cli/brain && ls -t | head", "cat ~/.gemini/oauth_creds.json", "ls ~/.claude/skills", transcripts,
  ]) {
    expect([command, decideAction(shell(command), botTurn)]).toEqual([command, expect.objectContaining({ kind: "allow" })]);
    // Any other agent's Bot, as before.
    expect([command, decideAction(shell(command), { ...botTurn, ownAgentDirs: undefined }).kind]).toEqual([command, "deny"]);
  }
  for (const path of [taskLog, join(guide, "SKILL.md"), join(gemini, "antigravity-cli", "settings.json"), join(home, ".claude", "skills", "x", "SKILL.md"), join(claudeRecords, "-Users-someone-proj", "47ce0671.jsonl")]) {
    expect([path, decideAction(read(path), botTurn).kind]).toEqual([path, "allow"]);
    expect([path, decideAction(read(path), { ...botTurn, ownAgentDirs: undefined }).kind]).toEqual([path, "deny"]);
  }
  // Its notes are in its own folder, where a change goes by the Bot's permission mode like any other.
  expect(decideAction(write(join(gemini, "antigravity-cli", "brain", "session-9", "task.md")), botTurn)).toMatchObject({ kind: "allow", effect: true });
  expect(decideAction(write(join(gemini, "antigravity-cli", "brain", "session-9", "task.md")), { ...botTurn, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(shell(`cat ${taskLog}`), { ...botTurn, permission: "ask_first" }).kind).toBe("ask");
  expect(decideAction(shell(`cat ${taskLog}`), { ...botTurn, mode: "readonly" })).toEqual({ kind: "deny", reason: expect.stringContaining("read-only turn") });
  expect(decideAction(read(taskLog), { ...botTurn, mode: "readonly" }).kind).toBe("allow");
  // What signs another agent in or sets it up, a file written into another's folder: off limits in every mode.
  for (const command of ["cat ~/.codex/auth.json", "cat ~/.claude/settings.json", "cat ~/.claude-b/.credentials.json", "cd ~/.codex && cat auth.json", `cat ${taskLog} ~/.grok/auth.json`,
    "cat ~/.gemini/antigravity-cli/skills/out.md"]) {
    expect([command, decideAction(shell(command), { ...botTurn, permission: "allow_all" })]).toEqual([command, { kind: "deny", reason: expect.stringContaining("credentials") }]);
  }
  for (const path of [join(home, ".codex", "auth.json"), join(home, ".claude", "settings.json"), join(home, ".claude-b", "settings.json"), join(gemini, "antigravity-cli", "skills", "out.md")]) {
    expect([path, decideAction(read(path), { ...botTurn, permission: "allow_all" }).kind]).toEqual([path, "deny"]);
  }
  expect(decideAction(write(join(home, ".claude", "skills", "x", "SKILL.md")), { ...botTurn, permission: "allow_all" })).toEqual({ kind: "deny", reason: expect.stringContaining("credentials") });
});

posixTest("of the keychain such an agent is refused only what signs an agent in or holds the app's keys, by the item's name", () => {
  // As agy ran them on 2026-11-26, each stopping a project session's turn: the test account it was given
  // to keep, read back for a script in its own notes; then, asked to fix that, the tool's own help.
  const kept = `ADMIN_EMAIL='admin@example.com' ADMIN_PASSWORD="$(security find-generic-password -w -s 'shop-admin-test' -a 'admin@example.com')" python3 ${brain}/scratch/e2e_verify_test.py`;
  const help = `security find-generic-password -h 2>&1 ; echo "---" ; ps aux | grep -E "real-bot|dev-runtime|deskfolk" | grep -v grep || true`;
  for (const [who, ctx] of [["a project session", unasked], ["a Bot's turn", botTurn]] as const) {
    for (const command of [kept, help, "security find-internet-password -s staging.example.com -a deploy -w", "security add-generic-password -U -s shop-admin-test -a admin@example.com -w x"]) {
      expect([who, command, decideAction(shell(command), ctx)]).toEqual([who, command, expect.objectContaining({ kind: "allow" })]);
      // Such an ask is a command like any other: the permission mode still has its say.
      expect([who, command, decideAction(shell(command), { ...ctx, permission: "ask_first" }).kind]).toEqual([who, command, "ask"]);
    }
    for (const command of [
      "security find-generic-password -s 'Claude Code-credentials' -w", "security find-generic-password -s \"Claude Code-credentials-1a2b3c4d\" -w",
      "security find-generic-password -s com.real-bot.daemon -a credentials -w", "S='Codex Auth'; security find-generic-password -s \"$S\" -w",
      // All it holds, theirs with the rest.
      "security dump-keychain -d", "security export -k login.keychain-db -t identities -o /tmp/x.p12",
    ]) {
      expect([who, command, decideAction(shell(command), { ...ctx, permission: "allow_all" })]).toEqual([who, command, { kind: "deny", reason: expect.stringContaining("keychain") }]);
    }
  }
  // An agent that is refused before it acts asks the keychain for nothing, as before.
  for (const ctx of [base, session, { ...botTurn, ownAgentDirs: undefined }]) {
    for (const command of [kept, help, "security find-generic-password -s 'Claude Code-credentials' -w"]) {
      expect([command, decideAction(shell(command), { ...ctx, permission: "allow_all" })]).toEqual([command, { kind: "deny", reason: expect.stringContaining("credentials") }]);
    }
  }
});

posixTest("a call checked after it ran is not stopped over advice on how to make it; what it may not cross still stops it", () => {
  const search = "grep -rn TODO /";
  const nowhere = "/zz-no-such-top-folder/work/notes.md";
  for (const ctx of [unasked, botTurn, { ...botTurn, ownAgentDirs: undefined }]) {
    // Asked about before it runs, an agent is told to search less and where the workspace is.
    expect(decideAction(shell(search), ctx)).toEqual({ kind: "deny", reason: expect.stringContaining("whole disk") });
    expect(decideAction(read(nowhere), ctx)).toEqual({ kind: "deny", reason: expect.stringContaining("does not exist") });
    // Once it has run that helps nobody: it goes by the permission mode, as any call.
    const ran: ActionContext = { ...ctx, ran: true };
    expect(decideAction(shell(search), ran)).toMatchObject({ kind: "allow", effect: true });
    expect(decideAction(read(nowhere), ran)).toMatchObject({ kind: "allow", effect: false });
    expect(decideAction(shell(search), { ...ran, permission: "ask_first" }).kind).toBe("ask");
    expect(decideAction(shell(search), { ...ran, permission: "read_only" })).toEqual({ kind: "deny", reason: expect.not.stringContaining("whole disk") });
    expect(decideAction(write(nowhere), { ...ran, permission: "ask_first" }).kind).toBe("ask");
    // A read-only turn of held work, and what signs an agent in.
    expect(decideAction(shell(search), { ...ran, mode: "readonly" })).toEqual({ kind: "deny", reason: expect.stringContaining("read-only turn") });
    expect(decideAction(shell("cat ~/.codex/auth.json"), { ...ran, permission: "allow_all" })).toEqual({ kind: "deny", reason: expect.stringContaining("credentials") });
    expect(decideAction(shell("security find-generic-password -s 'Claude Code-credentials' -w"), { ...ran, permission: "allow_all" }).kind).toBe("deny");
  }
});
