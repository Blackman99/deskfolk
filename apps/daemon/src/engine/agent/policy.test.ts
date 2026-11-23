import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRecordDirs, withoutHomeGlobs, withoutOpenDirs } from "./credentials";
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
  // A Bot, as before; a glob reaching settings or sign-in, the folders themselves, a climb, a cd, a path built on it.
  expect(decideAction(shell(everyAccount), { ...base, configDirs: [join(home, ".claude-b")] }).kind).toBe("deny");
  for (const command of [
    "cat ~/.claude*/settings.json",
    "cat ~/.claude*/.credentials.json",
    "ls ~/.claude*",
    "ls ~/.claude*/",
    "cat ~/.claude*/projects/../settings.json",
    "cd ~/.claude*/projects && cat ../settings.json",
    "cat ~/.claude*/projects/$NAME",
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
