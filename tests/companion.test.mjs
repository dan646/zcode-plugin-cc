// Tests for plugins/zcode/scripts/zcode-companion.mjs and its lib/ helpers
// (args parsing, prompt templates, git diff collection). No network, no real
// ZCode CLI: every check either exercises pure functions directly, or calls
// `runCli()` with injected `resolveZcodeCli`/`readWorkspaceState`/`runTurn`
// stand-ins instead of the real implementations.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/zcode/scripts/lib/args.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../plugins/zcode/scripts/lib/prompts.mjs";
import {
  buildReviewDiff,
  captureGitSnapshot,
  createFileJournal,
  declineCommands,
  diffGitSnapshots,
  renderChangesSummary,
  renderJournaledChangesSummary,
  resolveDisplayPath,
  FILE_WRITING_TOOLS,
} from "../plugins/zcode/scripts/lib/diff.mjs";
import {
  runCli,
  parseModelFlag,
  parseTimeoutFlag,
  parseModeFlag,
  formatToolCallLine,
  summarizeToolCallInput,
  formatHeartbeatLine,
  makeOnProgress,
  buildCodePrompt,
  buildReviewPrompt,
  ZCODE_MODES,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_TURN_FAILED,
} from "../plugins/zcode/scripts/zcode-companion.mjs";
import { formatDisplayPath, canonicalizePath } from "../plugins/zcode/scripts/lib/paths.mjs";

// `fileURLToPath`, not `new URL(...).pathname` — `.pathname` is
// percent-encoded, so a checkout path with a space or non-ASCII character
// would otherwise silently break every template-loading assertion below.
const ROOT_DIR = fileURLToPath(new URL("../plugins/zcode", import.meta.url));

// ---------------------------------------------------------------- fixtures

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-companion-test-"));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let repoCounter = 0;
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Create a fresh git repo with one committed file, return its absolute path. */
function makeGitRepo() {
  repoCounter += 1;
  const dir = path.join(tmpDir, `repo-${repoCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet"]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init", "--quiet"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "original\n");
  git(dir, ["add", "tracked.txt"]);
  git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add tracked.txt", "--quiet"]);
  return dir;
}

/** A collecting `log`/`logError` sink pair for runCli() calls. */
function makeSinks() {
  const out = [];
  const err = [];
  return {
    log: (text) => out.push(text),
    logError: (text) => err.push(text),
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const FAKE_CLI = { command: "node", args: ["/fake/zcode.cjs"] };
function fakeResolveZcodeCli() {
  return FAKE_CLI;
}

// -------------------------------------------------------------- args.mjs

describe("parseArgs", () => {
  test("parses --model and --cwd value options plus a --json boolean", () => {
    const { options, positionals } = parseArgs(
      ["fix", "the", "bug", "--model", "glm-5.3", "--cwd", "/tmp/x", "--json"],
      { valueOptions: ["model", "cwd"], booleanOptions: ["json"] },
    );
    assert.deepEqual(options, { model: "glm-5.3", cwd: "/tmp/x", json: true });
    assert.deepEqual(positionals, ["fix", "the", "bug"]);
  });

  test("supports --key=value inline form", () => {
    const { options } = parseArgs(["--model=glm-5.3-flash"], { valueOptions: ["model"] });
    assert.equal(options.model, "glm-5.3-flash");
  });

  test("--key=value only splits on the first '=' — the rest stays in the value", () => {
    const { options } = parseArgs(["--cwd=/a/b=c"], { valueOptions: ["cwd"] });
    assert.equal(options.cwd, "/a/b=c");
  });

  test("--flag=false is honored explicitly, not just bare --flag defaulting true", () => {
    const { options: explicitFalse } = parseArgs(["--json=false"], { booleanOptions: ["json"] });
    assert.equal(explicitFalse.json, false);
    const { options: bare } = parseArgs(["--json"], { booleanOptions: ["json"] });
    assert.equal(bare.json, true);
  });

  test("throws when a value option is missing its value", () => {
    assert.throws(() => parseArgs(["--model"], { valueOptions: ["model"] }), /Missing value for --model/);
  });

  test("treats an unknown --flag as a positional rather than dropping it", () => {
    const { positionals } = parseArgs(["--totally-unknown", "rest"], {});
    assert.deepEqual(positionals, ["--totally-unknown", "rest"]);
  });

  test("-- ends option parsing, everything after is positional", () => {
    const { options, positionals } = parseArgs(["--", "--model", "glm-5.3"], { valueOptions: ["model"] });
    assert.deepEqual(options, {});
    assert.deepEqual(positionals, ["--model", "glm-5.3"]);
  });
});

describe("splitRawArgumentString", () => {
  test("splits on whitespace, honors quotes", () => {
    assert.deepEqual(splitRawArgumentString(`--model glm-5.3 "add health check"`), [
      "--model",
      "glm-5.3",
      "add health check",
    ]);
  });

  test("empty/whitespace-only input yields no tokens", () => {
    assert.deepEqual(splitRawArgumentString("   "), []);
  });
});

// ------------------------------------------------------------- paths.mjs

describe("canonicalizePath", () => {
  // Force the fallback branch by making `fs.realpathSync` throw — on a real
  // filesystem `/` always exists and is realpath-able, so the fallback (no
  // existing ancestor could be resolved) is otherwise unreachable via plain
  // paths. `fs.realpathSync` is writable on Node's `fs` default-export object,
  // so a save/restore swap is sufficient (no external mocking dependency).
  function withThrowingRealpath(fn) {
    const orig = fs.realpathSync;
    fs.realpathSync = (_p) => {
      throw new Error("boom");
    };
    try {
      return fn();
    } finally {
      fs.realpathSync = orig;
    }
  }

  test("fallback branch rewrites /var,/tmp to /private/... on macOS and is a no-op elsewhere", () => {
    withThrowingRealpath(() => {
      if (process.platform === "darwin") {
        // Same /private/... form that the successful fs.realpathSync branch
        // returns — the fallback must NOT diverge the other way.
        assert.equal(canonicalizePath("/var/foo"), "/private/var/foo");
        assert.equal(canonicalizePath("/tmp/bar"), "/private/tmp/bar");
        // Bare stems with no trailing segment.
        assert.equal(canonicalizePath("/var"), "/private/var");
        assert.equal(canonicalizePath("/tmp"), "/private/tmp");
        // Non-/var, non-/tmp paths are returned verbatim on the fallback.
        assert.equal(canonicalizePath("/etc/hosts"), "/etc/hosts");
      } else {
        // On non-darwin the fallback must apply NO /private rewrite at all.
        assert.equal(canonicalizePath("/var/foo"), "/var/foo");
        assert.equal(canonicalizePath("/tmp/bar"), "/tmp/bar");
        assert.equal(canonicalizePath("/var"), "/var");
      }
    });
  });

  test("fallback result equals the successful-branch result for the same /var path (macOS)", () => {
    if (process.platform !== "darwin") return; // relies on /var -> /private/var
    const sample = "/var/folders/zz/does-not-exist-yet.txt";
    // Successful branch: walks up to the nearest existing ancestor under
    // /var -> /private/var and rebuilds the tail.
    const real = canonicalizePath(sample);
    assert.equal(real, "/private/var/folders/zz/does-not-exist-yet.txt");
    // Fallback branch (realpathSync throws) must yield the SAME canonical form,
    // not the raw /var/... form — that is the regression this guards.
    withThrowingRealpath(() => {
      assert.equal(canonicalizePath(sample), real);
    });
  });

  test("successful branch resolves existing /var entries to /private/... (macOS)", () => {
    if (process.platform !== "darwin") return;
    assert.equal(canonicalizePath("/var"), "/private/var");
    assert.equal(canonicalizePath("/tmp"), "/private/tmp");
  });
});

// ----------------------------------------------------------- prompts.mjs

describe("prompt templates", () => {
  test("code.md and review.md load and substitute their placeholders", () => {
    const codeTemplate = loadPromptTemplate(ROOT_DIR, "code");
    assert.match(codeTemplate, /\{\{TASK\}\}/);
    assert.match(codeTemplate, /\{\{CWD\}\}/);

    const rendered = interpolateTemplate(codeTemplate, { TASK: "add a health check", CWD: "/repo" });
    assert.match(rendered, /add a health check/);
    assert.match(rendered, /\/repo/);
    assert.doesNotMatch(rendered, /\{\{/);
  });

  test("interpolateTemplate replaces an unmatched placeholder with an empty string", () => {
    assert.equal(interpolateTemplate("x={{MISSING}}y", {}), "x=y");
  });

  test("buildCodePrompt/buildReviewPrompt fill in the real templates end to end", () => {
    const codePrompt = buildCodePrompt({ task: "implement feature X", cwd: "/work" });
    assert.match(codePrompt, /implement feature X/);
    assert.match(codePrompt, /\/work/);

    const reviewPrompt = buildReviewPrompt({
      cwd: "/work",
      diffInfo: {
        branch: "main",
        label: "working tree vs HEAD",
        stat: " 1 file changed",
        diff: "diff --git a/x b/x",
        untracked: [],
      },
    });
    assert.match(reviewPrompt, /working tree vs HEAD/);
    assert.match(reviewPrompt, /diff --git a\/x b\/x/);
  });
});

// -------------------------------------------------------------- diff.mjs

describe("buildReviewDiff", () => {
  test("throws a clear error for a non-git directory", () => {
    const dir = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => buildReviewDiff(dir, null), /not inside a git repository/);
  });

  test("throws a clear error when there is nothing to review", () => {
    const repo = makeGitRepo();
    assert.throws(() => buildReviewDiff(repo, null), /No changes to review/);
  });

  test("default target diffs the working tree against HEAD", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const result = buildReviewDiff(repo, null);
    assert.equal(result.label, "working tree vs HEAD");
    assert.match(result.diff, /-original/);
    assert.match(result.diff, /\+changed/);
  });

  test("an untracked-only change is not reported as empty", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "new-file.txt"), "brand new\n");
    const result = buildReviewDiff(repo, null);
    assert.deepEqual(result.untracked, ["new-file.txt"]);
  });

  test("default target diffs against HEAD, so a staged-only change is included too", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "staged change\n");
    git(repo, ["add", "tracked.txt"]);
    const result = buildReviewDiff(repo, null);
    assert.match(result.diff, /\+staged change/);
  });

  test("an explicit branch target diffs HEAD against that branch's merge-base", () => {
    const repo = makeGitRepo();
    git(repo, ["branch", "base-branch"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed on main\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "change", "--quiet"]);

    const result = buildReviewDiff(repo, "base-branch");
    assert.match(result.label, /base-branch\.\.HEAD/);
    assert.match(result.diff, /\+changed on main/);
  });

  test("branch diff uses the true merge-base, not the target ref's own (diverged) tip", () => {
    const repo = makeGitRepo();
    const mainBranch = git(repo, ["branch", "--show-current"]).trim();
    git(repo, ["branch", "diverged-branch"]);

    git(repo, ["checkout", "diverged-branch", "--quiet"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed on diverged branch\n");
    git(repo, [
      "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "-am", "diverge", "--quiet",
    ]);

    git(repo, ["checkout", mainBranch, "--quiet"]);
    fs.writeFileSync(path.join(repo, "other.txt"), "on main\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "main change", "--quiet"]);

    // Correct merge-base is the commit both branches share, before either
    // diverged — so this diff must show only main's own new file, and must
    // NOT show diverged-branch's own unrelated change to tracked.txt (which
    // a buggy "just diff against the ref's own tip" implementation would
    // pull in as a spurious revert).
    const result = buildReviewDiff(repo, "diverged-branch");
    assert.match(result.diff, /\+on main/);
    assert.doesNotMatch(result.diff, /changed on diverged branch/);
  });

  test("an explicit existing path scopes the diff to that path", () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "other.txt"), "other\n");
    git(repo, ["add", "other.txt"]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add other", "--quiet"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    fs.writeFileSync(path.join(repo, "other.txt"), "other changed\n");

    const result = buildReviewDiff(repo, "tracked.txt");
    assert.match(result.label, /scoped to tracked\.txt/);
    assert.match(result.diff, /tracked\.txt/);
    assert.doesNotMatch(result.diff, /other\.txt/);
  });

  test("a target that is neither a ref nor a path throws", () => {
    const repo = makeGitRepo();
    assert.throws(() => buildReviewDiff(repo, "no-such-branch-or-file"), /neither a known git ref/);
  });

  test("an existing path outside the repository is rejected, not silently reported as empty", () => {
    const repo = makeGitRepo();
    const outsideDir = path.join(tmpDir, "outside-the-repo");
    fs.mkdirSync(outsideDir, { recursive: true });
    assert.throws(() => buildReviewDiff(repo, path.join("..", path.basename(outsideDir))), /outside the repository/);
  });
});

// ------------------------------------------------------------- parseModelFlag

describe("parseModelFlag", () => {
  test("a bare model id defaults to the zai provider", () => {
    assert.deepEqual(parseModelFlag("glm-5.3-flash"), { providerId: "zai", modelId: "glm-5.3-flash" });
  });

  test("providerId/modelId is split on the slash", () => {
    assert.deepEqual(parseModelFlag("other-provider/some-model"), {
      providerId: "other-provider",
      modelId: "some-model",
    });
  });

  test("undefined/blank yields null (caller falls back to its own default)", () => {
    assert.equal(parseModelFlag(undefined), null);
    assert.equal(parseModelFlag("   "), null);
  });
});

// ------------------------------------------------------------ parseTimeoutFlag

describe("parseTimeoutFlag", () => {
  test("undefined yields null (caller falls back to its own per-command default)", () => {
    assert.equal(parseTimeoutFlag(undefined), null);
  });

  test("converts seconds to milliseconds", () => {
    assert.equal(parseTimeoutFlag("300"), 300_000);
    assert.equal(parseTimeoutFlag("1.5"), 1500);
  });

  for (const bad of ["0", "-5", "abc", "", "   ", "NaN", "Infinity"]) {
    test(`rejects invalid value: ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseTimeoutFlag(bad), /--timeout must be a positive number of seconds/);
    });
  }
});

// --------------------------------------------------------------- parseModeFlag

describe("parseModeFlag", () => {
  test("undefined yields null (caller leaves runTurn's mode unset)", () => {
    assert.equal(parseModeFlag(undefined), null);
  });

  for (const mode of ZCODE_MODES) {
    test(`accepts the known value ${JSON.stringify(mode)}`, () => {
      assert.equal(parseModeFlag(mode), mode);
    });
  }

  test("rejects an unknown value, listing the allowed ones", () => {
    assert.throws(() => parseModeFlag("god-mode"), (err) => {
      assert.match(err.message, /--mode must be one of: build, edit, plan, yolo/);
      assert.match(err.message, /"god-mode"/);
      return true;
    });
  });

  test("rejects a bare boolean --mode (no value given)", () => {
    assert.throws(() => parseModeFlag(true), /--mode requires a value/);
  });

  test("error message clarifies --mode is not this plugin's write permission", () => {
    assert.throws(() => parseModeFlag("bogus"), /not this plugin's write permission/);
  });
});

// ------------------------------------------------------------ formatToolCallLine

describe("formatToolCallLine", () => {
  test("null for anything that is not a model.streaming tool_call event", () => {
    assert.equal(formatToolCallLine(null), null);
    assert.equal(formatToolCallLine({ type: "state.updated", reason: "prompt_started" }), null);
    assert.equal(formatToolCallLine({ type: "model.streaming", kind: "text_delta", delta: "hi" }), null);
  });

  test("falls back to a visible placeholder when toolName is missing", () => {
    const line = formatToolCallLine({ type: "model.streaming", kind: "tool_call" });
    assert.equal(line, "[zcode] tool: (неизвестный инструмент)");
  });

  test("fallback line includes extracted input when toolName is missing", () => {
    const line = formatToolCallLine({
      type: "model.streaming",
      kind: "tool_call",
      input: { command: "ls -la" },
    });
    assert.match(line, /\(неизвестный инструмент\)/);
    assert.match(line, /ls -la/);
  });

  test("prefers a known argument field (file_path) as the summary", () => {
    const line = formatToolCallLine({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Read",
      input: { file_path: "/repo/README.md" },
    });
    assert.equal(line, "[zcode] tool: Read /repo/README.md");
  });

  test("prefers 'command' for a shell-style tool call", () => {
    const line = formatToolCallLine({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Bash",
      input: { command: "wc -l notes.txt", description: "count lines" },
    });
    assert.equal(line, "[zcode] tool: Bash wc -l notes.txt");
  });

  test("falls back to the whole input object for an unrecognized tool shape", () => {
    const line = formatToolCallLine({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "SomeFutureTool",
      input: { widgetId: 42 },
    });
    assert.equal(line, '[zcode] tool: SomeFutureTool {"widgetId":42}');
  });

  test("shows just the tool name when there is no input at all", () => {
    const line = formatToolCallLine({ type: "model.streaming", kind: "tool_call", toolName: "TodoRead", input: {} });
    assert.equal(line, "[zcode] tool: TodoRead");
  });

  test("truncates a very long argument instead of flooding stderr", () => {
    const longCommand = "echo " + "x".repeat(500);
    const line = formatToolCallLine({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Bash",
      input: { command: longCommand },
    });
    assert.ok(line.length < longCommand.length, "the line must be shorter than the raw argument");
    assert.match(line, /\[truncated \d+ chars\]/);
  });

  // The actual defect this guards: a tool call argument shaped like the
  // provider-config secret field (`"apiKey": ...`) must never reach stderr
  // verbatim — see lib/protocol.mjs's redactSecrets/API_KEY_PATTERN, reused
  // here rather than reimplemented.
  test("redacts a secret-shaped ('apiKey') argument the same way lib/protocol.mjs does", () => {
    const line = formatToolCallLine({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "SomeTool",
      input: { apiKey: "sk-super-secret-value", other: "fine" },
    });
    assert.doesNotMatch(line, /sk-super-secret-value/);
    assert.match(line, /"apiKey":"\[REDACTED\]"/);
  });

  test("relativizes path within cwd", () => {
    const cwd = "/Users/testuser/project";
    const line = formatToolCallLine(
      {
        type: "model.streaming",
        kind: "tool_call",
        toolName: "Write",
        input: { file_path: "/Users/testuser/project/src/index.mjs" },
      },
      cwd,
    );
    assert.equal(line, "[zcode] tool: Write src/index.mjs");
  });

  test("shortens path outside cwd under home directory to ~", () => {
    const cwd = "/Users/testuser/project";
    const homedir = "/Users/testuser";
    const formatted = formatDisplayPath("/Users/testuser/.zcode/config.json", cwd, homedir);
    assert.equal(formatted, "~/.zcode/config.json");
  });

  test("leaves path outside cwd and home directory as absolute", () => {
    const cwd = "/Users/testuser/project";
    const homedir = "/Users/testuser";
    const formatted = formatDisplayPath("/etc/hosts", cwd, homedir);
    assert.equal(formatted, "/etc/hosts");
  });

  test("supports alternative input field names (filePath, file, filename, skill, name)", () => {
    assert.equal(summarizeToolCallInput({ filePath: "/repo/a.js" }, "/repo"), "a.js");
    assert.equal(summarizeToolCallInput({ file: "/repo/b.js" }, "/repo"), "b.js");
    assert.equal(summarizeToolCallInput({ filename: "/repo/c.js" }, "/repo"), "c.js");
    assert.equal(summarizeToolCallInput({ skill: "code-review" }), "code-review");
    assert.equal(summarizeToolCallInput({ name: "my-skill" }), "my-skill");
  });

  test("parses stringified JSON input object", () => {
    const jsonInput = JSON.stringify({ file_path: "/repo/main.mjs" });
    assert.equal(summarizeToolCallInput(jsonInput, "/repo"), "main.mjs");
  });
});

// ------------------------------------------------------------------ runCli

describe("runCli — argument handling", () => {
  test("help / no subcommand prints usage and exits 0", async () => {
    const sinks = makeSinks();
    const code = await runCli([], sinks);
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stdout(), /Usage: zcode-companion/);
  });

  test("unknown subcommand exits non-zero and prints usage", async () => {
    const sinks = makeSinks();
    const code = await runCli(["frobnicate"], sinks);
    assert.equal(code, EXIT_ERROR);
    assert.match(sinks.stderr(), /Unknown subcommand: frobnicate/);
  });

  test("`code` with no task description exits non-zero without calling runTurn", async () => {
    const sinks = makeSinks();
    let called = false;
    const code = await runCli(["code"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        called = true;
        return {};
      },
    });
    assert.equal(code, EXIT_ERROR);
    assert.equal(called, false);
    assert.match(sinks.stderr(), /Usage: zcode-companion code/);
  });

  test("`code` with only flags and no task text still exits non-zero", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "--model", "glm-5.3"], { ...sinks, resolveZcodeCli: fakeResolveZcodeCli });
    assert.equal(code, EXIT_ERROR);
  });

  test("`review` in a non-git directory exits non-zero with a clear message", async () => {
    const dir = path.join(tmpDir, "review-not-a-repo");
    fs.mkdirSync(dir, { recursive: true });
    const sinks = makeSinks();
    const code = await runCli(["review", "--cwd", dir], { ...sinks, resolveZcodeCli: fakeResolveZcodeCli });
    assert.equal(code, EXIT_ERROR);
    assert.match(sinks.stderr(), /not inside a git repository/);
  });

  test("`review` with nothing changed exits non-zero with a clear message", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["review", "--cwd", repo], { ...sinks, resolveZcodeCli: fakeResolveZcodeCli });
    assert.equal(code, EXIT_ERROR);
    assert.match(sinks.stderr(), /No changes to review/);
  });
});

describe("runCli — setup", () => {
  test("setup --json reports ready:true and the current model when configured", async () => {
    const sinks = makeSinks();
    const code = await runCli(["setup", "--json"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      readWorkspaceState: async () => ({
        modelCatalog: { providers: [{ providerId: "zai" }] },
        settings: { model: { current: { providerId: "zai", modelId: "glm-5.3" } } },
      }),
    });
    assert.equal(code, EXIT_OK);
    const payload = JSON.parse(sinks.stdout());
    assert.equal(payload.ready, true);
    assert.equal(payload.providerId, "zai");
    assert.equal(payload.modelId, "glm-5.3");
    assert.equal(payload.instructions, null);
  });

  // Regression test for a real discrepancy found while smoke-testing this
  // companion against an actual logged-in ZCode CLI: `modelCatalog.available`
  // entries nest their id under `.ref`, not a flat `modelId` — see the
  // comment above `probeReadiness` in zcode-companion.mjs.
  test("setup --json extracts availableModels from the real (nested-under-.ref) catalog shape", async () => {
    const sinks = makeSinks();
    const code = await runCli(["setup", "--json"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      readWorkspaceState: async () => ({
        modelCatalog: {
          providers: [{ providerId: "zai" }],
          available: [
            { label: "GLM-5.3", ref: { providerId: "zai", modelId: "glm-5.3" } },
            { label: "GLM-5.3-Flash", ref: { providerId: "zai", modelId: "glm-5.3-flash" } },
          ],
        },
        settings: { model: { current: { providerId: "zai", modelId: "glm-5.3" } } },
      }),
    });
    assert.equal(code, EXIT_OK);
    const payload = JSON.parse(sinks.stdout());
    assert.deepEqual(payload.availableModels, ["glm-5.3", "glm-5.3-flash"]);
  });

  test("setup --json reports ready:false with a zcode login instruction when unconfigured", async () => {
    const sinks = makeSinks();
    const code = await runCli(["setup", "--json"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      readWorkspaceState: async () => ({
        modelCatalog: { providers: [] },
        settings: { model: { current: { providerId: "zcode-unconfigured", modelId: "missing-model" } } },
      }),
    });
    assert.equal(code, EXIT_ERROR);
    const payload = JSON.parse(sinks.stdout());
    assert.equal(payload.ready, false);
    assert.match(payload.instructions, /zcode login/);
  });

  test("setup surfaces a CLI-resolution failure instead of throwing", async () => {
    const sinks = makeSinks();
    const code = await runCli(["setup", "--json"], {
      ...sinks,
      resolveZcodeCli: () => {
        throw new Error("Could not locate the ZCode CLI.");
      },
    });
    assert.equal(code, EXIT_ERROR);
    const payload = JSON.parse(sinks.stdout());
    assert.equal(payload.ready, false);
    assert.match(payload.cliError, /Could not locate the ZCode CLI/);
  });
});

describe("runCli — status", () => {
  test("status always exits 0, even when the provider is not configured", async () => {
    const sinks = makeSinks();
    const code = await runCli(["status"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      readWorkspaceState: async () => ({
        modelCatalog: { providers: [] },
        settings: { model: { current: { providerId: "zcode-unconfigured", modelId: "missing-model" } } },
      }),
    });
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stdout(), /Provider configured: no/);
  });
});

describe("runCli — code / review success and failure paths (runTurn stubbed)", () => {
  function fakeTurnResult(overrides = {}) {
    return {
      sessionId: "s1",
      response: "done: implemented the thing",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelRequestCount: 1 },
      sessionUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, modelRequestCount: 2, modelErrorCount: 0 },
      events: [],
      resultType: "completed",
      ...overrides,
    };
  }

  test("`code` prints the response to stdout and both usage metrics to stderr", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    const code = await runCli(["code", "add", "a", "health", "check"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stdout(), /done: implemented the thing/);
    assert.match(sinks.stderr(), /turn usage:.*in=10/);
    assert.match(sinks.stderr(), /session usage:.*errors=0/);
    assert.match(capturedCall.prompt, /add a health check/);
    assert.deepEqual(capturedCall.model, { providerId: "zai", modelId: "glm-5.3-flash" });
  });

  test("`code` passes permissionPolicy: \"allow\" to runTurn (writes are the whole point of the command)", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    await runCli(["code", "add", "a", "health", "check"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(capturedCall.permissionPolicy, "allow");
  });

  test("`code --model` overrides the default model", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    await runCli(["code", "fix", "bug", "--model", "custom/model-x"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.deepEqual(capturedCall.model, { providerId: "custom", modelId: "model-x" });
  });

  test("`review` defaults to the stronger review model", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const sinks = makeSinks();
    let capturedCall = null;
    const code = await runCli(["review", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult({ response: "Looks good. Verdict: approve." });
      },
    });
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stdout(), /Verdict: approve/);
    assert.deepEqual(capturedCall.model, { providerId: "zai", modelId: "glm-5.3" });
    assert.match(capturedCall.prompt, /working tree vs HEAD/);
    // review needs its tools (reading the files a diff touches) to work at
    // all — same reasoning as `code`, see handleReview's comment.
    assert.equal(capturedCall.permissionPolicy, "allow");
  });

  test("a turn.failed error (surfaced by runTurn) maps to EXIT_TURN_FAILED with code/message/retryable", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        const err = new Error("Model provider rejected the request.");
        err.code = "provider_error";
        err.retryable = true;
        err.zcodeTurnError = { code: "provider_error", message: err.message };
        err.sessionUsage = { modelErrorCount: 1 };
        throw err;
      },
    });
    assert.equal(code, EXIT_TURN_FAILED);
    assert.match(sinks.stderr(), /ZCode turn failed: Model provider rejected the request\./);
    assert.match(sinks.stderr(), /"provider_error"/);
    assert.match(sinks.stderr(), /retryable: true/);
    assert.match(sinks.stderr(), /modelErrorCount":1/);
  });

  test("a generic (non-turn) error from runTurn maps to EXIT_ERROR", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    assert.equal(code, EXIT_ERROR);
    assert.match(sinks.stderr(), /spawn ENOENT/);
  });

  test("resolveZcodeCli failing before runTurn is called maps to EXIT_ERROR", async () => {
    const sinks = makeSinks();
    let called = false;
    const code = await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: () => {
        throw new Error("Could not locate the ZCode CLI.");
      },
      runTurn: async () => {
        called = true;
        return {};
      },
    });
    assert.equal(code, EXIT_ERROR);
    assert.equal(called, false);
    assert.match(sinks.stderr(), /Could not locate the ZCode CLI/);
  });

  // ---------------------------------------------------------------- --timeout

  test("`code --timeout 300` reaches runTurn as timeoutMs: 300000", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    const code = await runCli(["code", "do", "something", "--timeout", "300"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.equal(capturedCall.timeoutMs, 300_000);
  });

  test("`review --timeout 300` reaches runTurn as timeoutMs: 300000", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const sinks = makeSinks();
    let capturedCall = null;
    const code = await runCli(["review", "--cwd", repo, "--timeout", "300"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.equal(capturedCall.timeoutMs, 300_000);
  });

  for (const bad of ["0", "-1", "abc", ""]) {
    test(`\`code --timeout ${JSON.stringify(bad)}\` is rejected with a non-zero exit, without calling runTurn`, async () => {
      const sinks = makeSinks();
      let called = false;
      const code = await runCli(["code", "do", "something", `--timeout=${bad}`], {
        ...sinks,
        resolveZcodeCli: fakeResolveZcodeCli,
        runTurn: async () => {
          called = true;
          return fakeTurnResult();
        },
      });
      assert.equal(code, EXIT_ERROR);
      assert.equal(called, false);
      assert.match(sinks.stderr(), /--timeout must be a positive number of seconds/);
    });
  }

  test("`code` with no --timeout applies the code-specific default (2700s = 2700000ms)", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(capturedCall.timeoutMs, 2_700_000);
  });

  test("`review` with no --timeout applies the review-specific default (1800s = 1800000ms)", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const sinks = makeSinks();
    let capturedCall = null;
    await runCli(["review", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(capturedCall.timeoutMs, 1_800_000);
  });

  test("code and review defaults differ when neither passes --timeout", async () => {
    const sinks1 = makeSinks();
    let codeCall = null;
    await runCli(["code", "do", "something"], {
      ...sinks1,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        codeCall = args;
        return fakeTurnResult();
      },
    });

    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const sinks2 = makeSinks();
    let reviewCall = null;
    await runCli(["review", "--cwd", repo], {
      ...sinks2,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        reviewCall = args;
        return fakeTurnResult();
      },
    });

    assert.notEqual(codeCall.timeoutMs, reviewCall.timeoutMs);
  });

  // -------------------------------------------------------------------- --mode

  test("`code --mode plan` reaches runTurn as mode: 'plan'", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    const code = await runCli(["code", "do", "something", "--mode", "plan"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.equal(capturedCall.mode, "plan");
    // --mode must NOT change permissionPolicy — see zcode-companion.mjs's
    // ZCODE_MODES doc comment on why the two are separate concerns.
    assert.equal(capturedCall.permissionPolicy, "allow");
  });

  test("`review --mode edit` reaches runTurn as mode: 'edit'", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const sinks = makeSinks();
    let capturedCall = null;
    const code = await runCli(["review", "--cwd", repo, "--mode", "edit"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.equal(capturedCall.mode, "edit");
  });

  test("`code` with no --mode leaves runTurn's mode undefined", async () => {
    const sinks = makeSinks();
    let capturedCall = null;
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        capturedCall = args;
        return fakeTurnResult();
      },
    });
    assert.equal(capturedCall.mode, undefined);
  });

  test("`code --mode bogus` is rejected with a non-zero exit, without calling runTurn", async () => {
    const sinks = makeSinks();
    let called = false;
    const code = await runCli(["code", "do", "something", "--mode", "bogus"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        called = true;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_ERROR);
    assert.equal(called, false);
    assert.match(sinks.stderr(), /--mode must be one of: build, edit, plan, yolo/);
  });

  test("`review --mode bogus` is rejected with a non-zero exit, without calling runTurn", async () => {
    const repo = makeGitRepo();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const sinks = makeSinks();
    let called = false;
    const code = await runCli(["review", "--cwd", repo, "--mode", "bogus"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        called = true;
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_ERROR);
    assert.equal(called, false);
    assert.match(sinks.stderr(), /--mode must be one of: build, edit, plan, yolo/);
  });

  // ------------------------------------------------------------------- --quiet

  test("`code --quiet` suppresses per-step progress but the final response/footer still print", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--quiet"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        // Simulate a real turn's progress stream: a state transition, a tool
        // call, and streamed model text — none of it must reach logError.
        args.onProgress({ type: "state.updated", reason: "prompt_started" });
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Bash",
          input: { command: "wc -l notes.txt" },
        });
        args.onProgress({ type: "model.streaming", kind: "text_delta", delta: "some streamed text" });
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stdout(), /done: implemented the thing/);
    assert.doesNotMatch(sinks.stderr(), /prompt_started/);
    assert.doesNotMatch(sinks.stderr(), /tool: Bash/);
    assert.doesNotMatch(sinks.stderr(), /some streamed text/);
    // The final summary footer (turn/session usage) is unaffected by --quiet.
    assert.match(sinks.stderr(), /turn usage:/);
  });

  test("raw tool_input_delta fragments (partial JSON tool arguments) never reach stderr", async () => {
    // Regression guard: the previous makeOnProgress forwarded ANY non-empty
    // model.streaming delta unconditionally, which included tool_input_delta
    // — a tool call's arguments streaming character-by-character as raw,
    // unredacted, uncapped partial JSON. A secret-shaped argument (e.g.
    // apiKey) could leak here well before the assembled tool_call event (and
    // its safe formatToolCallLine summary) ever arrived.
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({ type: "model.streaming", kind: "tool_input_start", delta: "" });
        args.onProgress({
          type: "model.streaming",
          kind: "tool_input_delta",
          delta: '{"apiKey":"sk-super-secret-value"',
        });
        args.onProgress({ type: "model.streaming", kind: "tool_input_end", delta: "" });
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.doesNotMatch(sinks.stderr(), /sk-super-secret-value/);
    assert.doesNotMatch(sinks.stderr(), /apiKey/);
  });

  test("without --quiet, the same progress stream DOES reach stderr (control for the test above)", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({ type: "state.updated", reason: "prompt_started" });
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Bash",
          input: { command: "wc -l notes.txt" },
        });
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stderr(), /prompt_started/);
    assert.match(sinks.stderr(), /tool: Bash wc -l notes\.txt/);
  });

  // ---------------------------------------------------------------- heartbeat

  describe("formatHeartbeatLine", () => {
    test("returns null for a non-heartbeat event", () => {
      assert.equal(formatHeartbeatLine({ type: "state.updated", reason: "prompt_started" }), null);
      assert.equal(formatHeartbeatLine(null), null);
    });

    test("an alive, progressing probe renders elapsed time, request count, and token count with deltas", () => {
      const line = formatHeartbeatLine({
        type: "heartbeat",
        elapsedMs: 12 * 60_000 + 30_000,
        alive: true,
        stalled: false,
        modelRequestCount: 4,
        modelRequestCountDelta: 1,
        totalTokens: 210_000,
        totalTokensDelta: 48_000,
      });
      assert.match(line, /12m30s/);
      assert.match(line, /жив/);
      assert.match(line, /запросов 4 \(\+1\)/);
      assert.match(line, /токенов 210k \(\+48k\)/);
    });

    test("a stalled probe reports 'no progress' distinctly, without request/token counts", () => {
      const line = formatHeartbeatLine({
        type: "heartbeat",
        elapsedMs: 18 * 60_000,
        alive: true,
        stalled: true,
        sinceLastProgressMs: 5 * 60_000,
        modelRequestCount: 4,
        totalTokens: 210_000,
      });
      assert.match(line, /18m00s/);
      assert.match(line, /жив/);
      assert.match(line, /без прогресса/);
      assert.match(line, /5m00s/);
      assert.doesNotMatch(line, /запросов/);
    });

    test("a dead (not alive) probe reports failure distinctly from a stall", () => {
      const line = formatHeartbeatLine({
        type: "heartbeat",
        elapsedMs: 60_000,
        alive: false,
        consecutiveFailedProbes: 2,
      });
      assert.match(line, /нет ответа/);
      assert.match(line, /2/);
      assert.doesNotMatch(line, /жив/);
    });
  });

  test("`code --quiet` also suppresses heartbeat progress lines", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--quiet"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "heartbeat",
          elapsedMs: 60_000,
          alive: true,
          stalled: false,
          modelRequestCount: 4,
          modelRequestCountDelta: 1,
          totalTokens: 210_000,
          totalTokensDelta: 48_000,
        });
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.doesNotMatch(sinks.stderr(), /жив/);
    assert.doesNotMatch(sinks.stderr(), /запросов/);
  });

  test("without --quiet, a heartbeat progress event reaches stderr", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "heartbeat",
          elapsedMs: 60_000,
          alive: true,
          stalled: false,
          modelRequestCount: 4,
          modelRequestCountDelta: 1,
          totalTokens: 210_000,
          totalTokensDelta: 48_000,
        });
        return fakeTurnResult();
      },
    });
    assert.equal(code, EXIT_OK);
    assert.match(sinks.stderr(), /жив/);
    assert.match(sinks.stderr(), /запросов 4 \(\+1\)/);
  });

  test("a runTurn timeout error is enhanced with the wait time and a --timeout suggestion", async () => {
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--timeout", "5"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        throw new Error(
          "ZCode turn timed out after 5000ms waiting for turn.completed/turn.failed (sessionId=s1).",
        );
      },
    });
    assert.equal(code, EXIT_ERROR);
    // Both the human-facing seconds figure and the flag to raise it with
    // must be present — a bare "timed out" message leaves the user stuck.
    assert.match(sinks.stderr(), /Waited 5s/);
    assert.match(sinks.stderr(), /--timeout/);
    // A small timeout doubling to a slightly bigger one is still a sensible
    // suggestion (5s -> 10s), unlike doubling a large one (see the test below).
    assert.match(sinks.stderr(), /--timeout 10\b/);
  });

  test("a timeout error above the doubling ceiling suggests a +50% bump, not a doubled value", async () => {
    // Regression guard for the new default (`code` = 2700s / 45min): doubling
    // an already-large timeout (e.g. suggesting 5400s/90min) reads as an
    // absurd ask. Past `TIMEOUT_DOUBLING_CEILING_SECONDS`, the suggestion
    // must scale down to +50% instead of blindly doubling.
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--timeout", "2700"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        throw new Error(
          "ZCode turn timed out after 2700000ms waiting for turn.completed/turn.failed (sessionId=s1).",
        );
      },
    });
    assert.equal(code, EXIT_ERROR);
    assert.match(sinks.stderr(), /Waited 2700s/);
    // 2700 * 1.5 = 4050 — NOT 5400 (a blind doubling).
    assert.match(sinks.stderr(), /--timeout 4050\b/);
    assert.doesNotMatch(sinks.stderr(), /--timeout 5400\b/);
  });
});

describe("makeOnProgress — progress callback and flags", () => {
  test("emits distinct lines for multiple sequential tool calls", () => {
    const lines = [];
    const onProgress = makeOnProgress((text) => lines.push(text), { cwd: "/repo" });
    onProgress({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Write",
      input: { file_path: "/repo/a.txt" },
    });
    onProgress({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Write",
      input: { file_path: "/repo/b.txt" },
    });
    onProgress({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Bash",
      input: { command: "ls -la" },
    });

    const combined = lines.join("");
    assert.match(combined, /tool: Write a\.txt/);
    assert.match(combined, /tool: Write b\.txt/);
    assert.match(combined, /tool: Bash ls -la/);
  });

  test("noStream suppresses text_delta and reasoning_delta but preserves tool calls and heartbeats", () => {
    const lines = [];
    const onProgress = makeOnProgress((text) => lines.push(text), { noStream: true, cwd: "/repo" });
    onProgress({ type: "model.streaming", kind: "reasoning_delta", delta: "secret thoughts" });
    onProgress({ type: "model.streaming", kind: "text_delta", delta: "streamed response" });
    onProgress({
      type: "model.streaming",
      kind: "tool_call",
      toolName: "Write",
      input: { file_path: "/repo/a.txt" },
    });
    onProgress({
      type: "heartbeat",
      elapsedMs: 60_000,
      alive: true,
      stalled: false,
      modelRequestCount: 2,
      totalTokens: 1000,
    });

    const combined = lines.join("");
    assert.doesNotMatch(combined, /secret thoughts/);
    assert.doesNotMatch(combined, /streamed response/);
    assert.match(combined, /tool: Write a\.txt/);
    assert.match(combined, /жив/);
  });
});

describe("git snapshot diffing and file changes summary", () => {
  test("diffGitSnapshots detects created, modified, and deleted files", () => {
    const repo = makeGitRepo();
    // Initially tracked.txt is committed. Let's create an untracked file to begin with.
    fs.writeFileSync(path.join(repo, "dirty-before.txt"), "untouched during turn\n");
    const before = captureGitSnapshot(repo);

    // During the turn: create a new file, modify tracked.txt, delete another file
    fs.writeFileSync(path.join(repo, "created.txt"), "hello\n");
    fs.writeFileSync(path.join(repo, "tracked.txt"), "modified content\n");

    const diff = diffGitSnapshots(before, repo);
    assert.equal(diff.isGit, true);

    const created = diff.changes.find((c) => c.path === "created.txt");
    const modified = diff.changes.find((c) => c.path === "tracked.txt");
    const dirtyBefore = diff.changes.find((c) => c.path === "dirty-before.txt");

    assert.ok(created, "created.txt should be in diff changes");
    assert.equal(created.kind, "created");

    assert.ok(modified, "tracked.txt should be in diff changes");
    assert.equal(modified.kind, "modified");

    assert.equal(dirtyBefore, undefined, "pre-existing dirty file untouched during turn must not appear");
  });

  test("diffGitSnapshots detects deleted files", () => {
    const repo = makeGitRepo();
    const before = captureGitSnapshot(repo);
    fs.rmSync(path.join(repo, "tracked.txt"));

    const diff = diffGitSnapshots(before, repo);
    const deleted = diff.changes.find((c) => c.path === "tracked.txt");
    assert.ok(deleted, "tracked.txt deletion should be detected");
    assert.equal(deleted.kind, "deleted");
  });

  test("renderChangesSummary formats created/modified/deleted list correctly", () => {
    const summary = renderChangesSummary({
      isGit: true,
      changes: [
        { path: "src/slug.mjs", kind: "created" },
        { path: "tests/slug.test.mjs", kind: "modified" },
        { path: "old.txt", kind: "deleted" },
      ],
    });

    assert.match(summary, /\[zcode\] изменённые файлы:/);
    assert.match(summary, /\[zcode\]   src\/slug\.mjs \(создан\)/);
    assert.match(summary, /\[zcode\]   tests\/slug\.test\.mjs \(изменён\)/);
    assert.match(summary, /\[zcode\]   old\.txt \(удалён\)/);
  });

  test("renderChangesSummary handles empty changes and non-git repos", () => {
    assert.equal(
      renderChangesSummary({ isGit: true, changes: [] }),
      "[zcode] изменённые файлы: (нет изменений)\n",
    );
    assert.equal(
      renderChangesSummary({ isGit: false, changes: [] }),
      "[zcode] сводка изменений недоступна вне git-репозитория\n",
    );
  });

  test("`code` command in git repo prints file changes summary in stderr", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "create", "a", "file", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        // Written directly (not via a file-writing tool call) — must land in
        // the "not by this run" part, since the journal has no record of it.
        fs.writeFileSync(path.join(repo, "generated.js"), "console.log('hi');\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    assert.match(sinks.stderr(), /\[zcode\] изменено в репозитории за время хода, но не этим запуском:/);
    assert.match(sinks.stderr(), /generated\.js \(создан\)/);
  });

  test("`code --quiet` suppresses both per-step progress and file changes summary", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "create", "a", "file", "--cwd", repo, "--quiet"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async () => {
        fs.writeFileSync(path.join(repo, "generated2.js"), "console.log('hi');\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    assert.doesNotMatch(sinks.stderr(), /изменённые файлы:/);
    assert.doesNotMatch(sinks.stderr(), /generated2\.js/);
    assert.match(sinks.stderr(), /turn usage:/);
  });

  test("`code --no-stream` keeps tool calls and changes summary while suppressing streaming deltas", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "create", "a", "file", "--cwd", repo, "--no-stream"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({ type: "model.streaming", kind: "reasoning_delta", delta: "thinking hard" });
        args.onProgress({ type: "model.streaming", kind: "text_delta", delta: "streaming text" });
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: path.join(repo, "streamed-tool.js") },
        });
        fs.writeFileSync(path.join(repo, "streamed-tool.js"), "export const x = 1;\n");
        return {
          sessionId: "s1",
          response: "done creating file",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    assert.doesNotMatch(sinks.stderr(), /thinking hard/);
    assert.doesNotMatch(sinks.stderr(), /streaming text/);
    assert.match(sinks.stderr(), /tool: Write streamed-tool\.js/);
    // Written via a `Write` tool call → recorded in the journal → part 1.
    assert.match(sinks.stderr(), /\[zcode\] изменено этим запуском:/);
    assert.match(sinks.stderr(), /streamed-tool\.js \(создан\)/);
  });
});

// --------------------------------------------------------- two-part summary
//
// These cover the parallel-edit defect fix: the changes summary must split
// into "written by this run" (from the file-write journal) and "everything
// else git saw change" (parallel edits, Bash side effects). All of them run
// against a real temporary git repository — the fake-app-server fixture has
// no git, so the git-dependent parts cannot be exercised there.

describe("two-part changes summary (parallel-edit fix)", () => {
  test("FILE_WRITING_TOOLS lists the empirically confirmed writers", () => {
    assert.deepEqual(FILE_WRITING_TOOLS, ["Write", "Edit"]);
  });

  test("createFileJournal records Write/Edit paths and Bash commands, ignores Read", () => {
    const journal = createFileJournal();
    journal.recordToolCall("Write", { file_path: "/repo/a.txt", content: "x" });
    journal.recordToolCall("Edit", { file_path: "/repo/b.txt", old_string: "a", new_string: "b" });
    journal.recordToolCall("Read", { file_path: "/repo/c.txt" });
    journal.recordToolCall("Bash", { command: "echo hi" });
    journal.recordToolCall("Glob", { pattern: "*.txt" });

    assert.deepEqual([...journal.writtenFiles].sort(), ["/repo/a.txt", "/repo/b.txt"]);
    assert.deepEqual(journal.bashCommands, ["echo hi"]);
  });

  test("journal records resolved absolute paths for relative file_path", () => {
    const journal = createFileJournal();
    journal.recordToolCall("Write", { file_path: "relative.txt", content: "x" });
    // path.resolve makes it absolute against cwd.
    assert.ok([...journal.writtenFiles].every((p) => path.isAbsolute(p)));
    assert.equal([...journal.writtenFiles].length, 1);
  });

  test("resolveDisplayPath relativizes against cwd", () => {
    assert.equal(resolveDisplayPath("/repo/src/index.mjs", "/repo"), "src/index.mjs");
    assert.equal(resolveDisplayPath("/repo", "/repo"), ".");
    // Outside cwd → falls back to the absolute path.
    assert.equal(resolveDisplayPath("/other/file.txt", "/repo"), "/other/file.txt");
  });

  test("renderJournaledChangesSummary: journal file lands in part 1 with git kind", () => {
    const cwd = "/repo";
    const summary = renderJournaledChangesSummary(
      {
        isGit: true,
        changes: [
          { path: "a.txt", kind: "created" },
          { path: "parallel.txt", kind: "created" },
        ],
      },
      { writtenFiles: ["/repo/a.txt"], bashCommands: [] },
      cwd,
    );

    assert.match(summary, /\[zcode\] изменено этим запуском:/);
    assert.match(summary, /a\.txt \(создан\)/);
    assert.match(summary, /\[zcode\] изменено в репозитории за время хода, но не этим запуском:/);
    assert.match(summary, /parallel\.txt \(создан\)/);
    // The journal file must NOT appear in part 2.
    const part2 = summary.split("не этим запуском:")[1] ?? "";
    assert.doesNotMatch(part2, /a\.txt/);
  });

  test("renderJournaledChangesSummary: parallel edit (not in journal) lands only in part 2", () => {
    const cwd = "/repo";
    const summary = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "parallel-only.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: [] },
      cwd,
    );

    assert.doesNotMatch(summary, /\[zcode\] изменено этим запуском:/);
    assert.match(summary, /\[zcode\] изменено в репозитории за время хода, но не этим запуском:/);
    assert.match(summary, /parallel-only\.txt/);
  });

  test("renderJournaledChangesSummary: file written without content change is 'записан, без изменений'", () => {
    const cwd = "/repo";
    const summary = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "other.txt", kind: "created" }] },
      { writtenFiles: ["/repo/touched-but-same.txt"], bashCommands: [] },
      cwd,
    );

    assert.match(summary, /touched-but-same\.txt \(записан, без изменений\)/);
  });

  test("renderJournaledChangesSummary: Bash count reflected in part 2 header", () => {
    const cwd = "/repo";
    const summary = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "bash-outcome.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: ["npm run build", "git add -A"] },
      cwd,
    );

    // Bash calls were declared this turn, so the source can't be pinned to
    // "not this run": the header must switch to "источник не установлен" and
    // show the count with a properly declined word ("2 команды"), and must NOT
    // assert inclusion ("включая") or blame on "not this run".
    assert.match(summary, /источник не установлен/);
    assert.match(summary, /2 команды Bash/);
    assert.doesNotMatch(summary, /включая/);
    assert.doesNotMatch(summary, /не этим запуском/);
    assert.match(summary, /bash-outcome\.txt \(создан\)/);
  });

  test("renderJournaledChangesSummary: empty parts are not printed", () => {
    const cwd = "/repo";
    const noChanges = renderJournaledChangesSummary({ isGit: true, changes: [] }, null, cwd);
    assert.equal(noChanges, "");
  });

  test("renderJournaledChangesSummary: .mimosa excluded from both parts", () => {
    const cwd = "/repo";
    const summary = renderJournaledChangesSummary(
      {
        isGit: true,
        changes: [
          { path: ".mimosa/hook.json", kind: "created" },
          { path: "real.txt", kind: "created" },
        ],
      },
      { writtenFiles: ["/repo/.mimosa/state.json"], bashCommands: [] },
      cwd,
    );

    assert.doesNotMatch(summary, /mimosa/);
    assert.match(summary, /real\.txt/);
  });

  test("renderJournaledChangesSummary: outside git, part 1 still prints, part 2 noted unavailable", () => {
    const cwd = "/nowhere";
    const summary = renderJournaledChangesSummary(
      { isGit: false, changes: [] },
      { writtenFiles: ["/nowhere/out.txt"], bashCommands: [] },
      cwd,
    );

    assert.match(summary, /\[zcode\] изменено этим запуском:/);
    assert.match(summary, /out\.txt \(записан, без изменений\)/);
    assert.match(summary, /сводка по репозиторию недоступна вне git-репозитория/);
  });

  test("renderJournaledChangesSummary: outside git with empty journal prints nothing", () => {
    const summary = renderJournaledChangesSummary({ isGit: false, changes: [] }, null, "/nowhere");
    assert.equal(summary, "");
  });

  test("parallel edit by another process during the turn lands in part 2, not part 1", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "write", "one", "file", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        // This run writes its own file via a Write tool call.
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: path.join(repo, "mine.txt"), content: "mine" },
        });
        fs.writeFileSync(path.join(repo, "mine.txt"), "mine\n");
        // Simulate a parallel writer touching a different file mid-turn.
        fs.writeFileSync(path.join(repo, "theirs.txt"), "theirs\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    const stderr = sinks.stderr();
    // Part 1: only this run's file.
    assert.match(stderr, /\[zcode\] изменено этим запуском:/);
    assert.match(stderr, /mine\.txt \(создан\)/);
    // Part 2: the parallel edit.
    assert.match(stderr, /\[zcode\] изменено в репозитории за время хода, но не этим запуском:/);
    assert.match(stderr, /theirs\.txt \(создан\)/);
    // mine.txt must not leak into part 2.
    const part2 = stderr.split("не этим запуском:")[1] ?? "";
    assert.doesNotMatch(part2, /mine\.txt/);
  });

  test("file written via Edit tool call is recorded in the journal", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "edit", "a", "file", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Edit",
          input: { file_path: path.join(repo, "tracked.txt"), old_string: "original", new_string: "edited" },
        });
        fs.writeFileSync(path.join(repo, "tracked.txt"), "edited\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    assert.match(sinks.stderr(), /\[zcode\] изменено этим запуском:/);
    assert.match(sinks.stderr(), /tracked\.txt \(изменён\)/);
  });

  test("Bash-only turn reflects command count in part 2 header", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "run", "a", "command", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Bash",
          input: { command: "echo generated > bash.txt" },
        });
        fs.writeFileSync(path.join(repo, "bash.txt"), "generated\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    const stderr = sinks.stderr();
    // Bash side effect is NOT in the journal → part 2, with Bash count.
    // Source is not established (a Bash call ran this turn), so the header
    // uses "источник не установлен" + a declined count ("1 команда Bash"),
    // and must not fall back to "включая … команд" or "… не этим запуском".
    assert.match(stderr, /источник не установлен/);
    assert.match(stderr, /1 команда Bash/);
    assert.doesNotMatch(stderr, /включая/);
    assert.doesNotMatch(stderr, /не этим запуском/);
    assert.match(stderr, /bash\.txt \(создан\)/);
  });

  test("summary still prints on turn failure (best-effort, unchanged exit code)", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: path.join(repo, "partial.txt"), content: "x" },
        });
        fs.writeFileSync(path.join(repo, "partial.txt"), "x\n");
        const err = new Error("Model provider rejected the request.");
        err.code = "provider_error";
        err.retryable = true;
        err.zcodeTurnError = { code: "provider_error", message: err.message };
        throw err;
      },
    });

    assert.equal(code, EXIT_TURN_FAILED);
    assert.match(sinks.stderr(), /\[zcode\] изменено этим запуском:/);
    assert.match(sinks.stderr(), /partial\.txt \(создан\)/);
  });

  test("error while building the summary does not change exit code", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      // diffGitSnapshots throws → summary degrades to one "недоступна" line.
      diffGitSnapshots: () => {
        throw new Error("git boom");
      },
      runTurn: async () => {
        fs.writeFileSync(path.join(repo, "ok.txt"), "ok\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    assert.match(sinks.stderr(), /\[zcode\] сводка недоступна: git boom/);
  });

  test("`code --quiet` suppresses the two-part summary entirely", async () => {
    const repo = makeGitRepo();
    const sinks = makeSinks();
    const code = await runCli(["code", "do", "something", "--cwd", repo, "--quiet"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: path.join(repo, "quiet.txt"), content: "x" },
        });
        fs.writeFileSync(path.join(repo, "quiet.txt"), "x\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    assert.doesNotMatch(sinks.stderr(), /изменено этим запуском/);
    assert.doesNotMatch(sinks.stderr(), /quiet\.txt/);
    assert.match(sinks.stderr(), /turn usage:/);
  });

  test("relative file_path in a Write event resolves against --cwd, not process.cwd()", async () => {
    // makeGitRepo() lands the repo under os.tmpdir(), which is guaranteed to
    // differ from the test process's own cwd — so a relative path resolved
    // against process.cwd() would miss the repo entirely and never match git.
    const repo = makeGitRepo();
    assert.notEqual(path.resolve(repo), path.resolve(process.cwd()));

    const sinks = makeSinks();
    const code = await runCli(["code", "create", "a", "file", "--cwd", repo], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        // Relative path — MUST be resolved against the run's --cwd (the repo),
        // not the test process's cwd.
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: "mine.txt", content: "mine" },
        });
        // The file really lands in the temp repo so git sees it.
        fs.writeFileSync(path.join(repo, "mine.txt"), "mine\n");
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    const stderr = sinks.stderr();
    // Part 1: this run's write, owned by the journal.
    assert.match(stderr, /\[zcode\] изменено этим запуском:/);
    assert.match(stderr, /mine\.txt \(создан\)/);
    // Part 2: there must be NO "changed in the repo but not by this run"
    // section — the journal already accounts for mine.txt, so git's change
    // is attributed to this run rather than appearing as a parallel edit.
    assert.equal(stderr.split("изменено в репозитории за время хода")[1], undefined);
  });

  test("symlinked working dir + Write-then-delete lands the file in only one part", async () => {
    const repoReal = makeGitRepo();
    // Commit a tracked file the turn will overwrite-then-delete, so git sees a
    // real deletion once the turn ends (an untracked file created+deleted would
    // leave no trace in git status).
    fs.writeFileSync(path.join(repoReal, "deep.txt"), "original\n");
    git(repoReal, ["add", "deep.txt"]);
    git(repoReal, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add deep", "--quiet"]);

    // Run THROUGH a symlink: the journal records .../repo-link/deep.txt while
    // git's rev-parse resolves it to .../repo-real/deep.txt. A deleted file
    // only canonicalizes to the same form as git if canonicalizePath walks up
    // to the nearest existing (real) parent.
    const repoLink = path.join(tmpDir, `repo-link-${repoCounter}`);
    fs.symlinkSync(repoReal, repoLink);

    const sinks = makeSinks();
    const code = await runCli(["code", "edit", "a", "file", "--cwd", repoLink], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          // Absolute path through the symlink: isolates this test from the
          // relative-path resolution fix (that one belongs to test 1).
          input: { file_path: path.join(repoLink, "deep.txt"), content: "deep" },
        });
        fs.writeFileSync(path.join(repoLink, "deep.txt"), "deep\n");
        // ...then delete it in the same turn: on disk it is gone by the end.
        fs.rmSync(path.join(repoLink, "deep.txt"));
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    const stderr = sinks.stderr();
    // The journal owns this file → part 1, with git's "deleted" kind.
    assert.match(stderr, /\[zcode\] изменено этим запуском:/);
    assert.match(stderr, /deep\.txt \(удалён\)/);
    // ...and it must NOT also appear in part 2 (the "not by this run" section):
    // the same file must not land in both parts.
    assert.equal(stderr.split("изменено в репозитории за время хода")[1], undefined);
  });

  test("write-then-delete outside --cwd lands in only one part (no /var vs /private/var split)", async () => {
    const repoReal = makeGitRepo();
    // `sub` is a real subdirectory the turn's --cwd will point at through a
    // symlink, so paths written "up and out" of it (../outside.txt) land at the
    // repo ROOT — inside git but OUTSIDE the run's cwd.
    fs.mkdirSync(path.join(repoReal, "sub"), { recursive: true });
    // A tracked file at the repo root; overwriting then deleting it during the
    // turn makes git later report a deletion while the journal owns the write.
    fs.writeFileSync(path.join(repoReal, "outside.txt"), "original\n");
    git(repoReal, ["add", "outside.txt"]);
    git(repoReal, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add outside", "--quiet"]);

    // Reach the repo THROUGH a symlink: the journal records the symlink form
    // (`/var/...`/`/tmp/...`) while git resolves to `/private/...`. Before the
    // fix, resolveDisplayPath's outside-cwd branch passed those raw values to
    // formatDisplayPath, whose final `return raw` then returned the non-canonical
    // form — so the same file appeared in BOTH parts of the summary.
    const repoLink = path.join(tmpDir, `repo-link-outside-${repoCounter}`);
    fs.symlinkSync(repoReal, repoLink);
    const cwd = path.join(repoLink, "sub");

    const sinks = makeSinks();
    const code = await runCli(["code", "write", "../outside.txt", "--cwd", cwd], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "model.streaming",
          kind: "tool_call",
          toolName: "Write",
          input: { file_path: "../outside.txt", content: "deep" },
        });
        fs.writeFileSync(path.join(cwd, "../outside.txt"), "deep\n");
        fs.rmSync(path.join(cwd, "../outside.txt"));
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.equal(code, EXIT_OK);
    const stderr = sinks.stderr();
    // Part 1: the journal owns this file → deleted.
    assert.match(stderr, /\[zcode\] изменено этим запуском:/);
    assert.match(stderr, /outside\.txt \(удалён\)/);
    // Part 2: must NOT also list it — the file must not land in both parts.
    assert.equal(stderr.split("изменено в репозитории за время хода")[1], undefined);
  });
});

// -------------------------------------------------------------- state values
//
// `state.updated` progress lines should show concrete model=/mode= values from
// the patch when present, instead of bare reason strings like "model_changed".

describe("state.updated shows model=/mode= values", () => {
  test("prints model= and mode= when patch carries them", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "state.updated",
          reason: "model_changed",
          patch: { model: { current: { modelId: "glm-5.3-flash" } }, mode: { current: "build" } },
        });
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.match(sinks.stderr(), /\[zcode\] model=glm-5\.3-flash mode=build/);
    assert.doesNotMatch(sinks.stderr(), /model_changed/);
  });

  test("prints only model= when mode is absent", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({
          type: "state.updated",
          reason: "model_changed",
          patch: { model: { current: { modelId: "glm-5.3" } } },
        });
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.match(sinks.stderr(), /\[zcode\] model=glm-5\.3\b/);
    assert.doesNotMatch(sinks.stderr(), /mode=/);
  });

  test("falls back to reason string when patch has no model/mode", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({ type: "state.updated", reason: "prompt_started", patch: { status: "running" } });
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.match(sinks.stderr(), /\[zcode\] prompt_started/);
  });

  test("state.updated with no model/mode and no reason prints nothing", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        args.onProgress({ type: "state.updated", patch: { status: "idle" } });
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    // No bare reason line, no model=/mode= line.
    assert.doesNotMatch(sinks.stderr(), /\[zcode\] idle/);
  });

  test("state.updated with a model/mode value that is an object never prints [object Object]", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        // A malformed/edge patch where the model value is an object rather than
        // a string: the type guard must drop it instead of stringifying it to
        // "[object Object]" on stderr. mode is a valid string and must still show.
        args.onProgress({
          type: "state.updated",
          reason: "model_changed",
          patch: { model: { current: { modelId: { nested: "object" } } }, mode: { current: "build" } },
        });
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.doesNotMatch(sinks.stderr(), /\[object Object\]/);
    assert.match(sinks.stderr(), /mode=build/);
  });

  test("state.updated redacts a secret-shaped string value via redactSecrets", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        // A model/mode value whose string content carries a JSON "apiKey"
        // field — exactly the shape API_KEY_PATTERN targets — must not reach
        // stderr verbatim.
        args.onProgress({
          type: "state.updated",
          reason: "model_changed",
          patch: { model: { current: { modelId: '{"apiKey":"sk-test-secret"}' } }, mode: { current: "build" } },
        });
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    assert.doesNotMatch(sinks.stderr(), /sk-test-secret/);
  });

  test("duplicate startup state.updated lines collapse: two identical -> one; a changed value -> a second", async () => {
    const sinks = makeSinks();
    await runCli(["code", "do", "something"], {
      ...sinks,
      resolveZcodeCli: fakeResolveZcodeCli,
      runTurn: async (args) => {
        const state = (mode) => ({
          type: "state.updated",
          patch: { model: { current: { modelId: "glm-5.3" } }, mode: { current: mode } },
        });
        args.onProgress(state("build")); // emitted
        args.onProgress(state("build")); // identical duplicate -> suppressed
        args.onProgress(state("yolo")); // value changed -> emitted again
        return {
          sessionId: "s1",
          response: "done",
          usage: { totalTokens: 10 },
          sessionUsage: { totalTokens: 10 },
          events: [],
          resultType: "completed",
        };
      },
    });

    const matches = sinks.stderr().match(/\[zcode\] model=glm-5\.3 mode=\w+/g) || [];
    assert.equal(matches.length, 2);
    assert.equal(matches[0], "[zcode] model=glm-5.3 mode=build");
    assert.equal(matches[1], "[zcode] model=glm-5.3 mode=yolo");
  });
});

// ------------------------------------------------ A: честный заголовок второй части

describe("А: честный заголовок второй части (declineCommands + header)", () => {
  test("declineCommands declines 'команда' by last digit (incl. 11/111)", () => {
    assert.equal(declineCommands(1), "команда");
    assert.equal(declineCommands(2), "команды");
    assert.equal(declineCommands(3), "команды");
    assert.equal(declineCommands(4), "команды");
    assert.equal(declineCommands(5), "команд");
    assert.equal(declineCommands(0), "команд");
    assert.equal(declineCommands(9), "команд");
    assert.equal(declineCommands(10), "команд");
    assert.equal(declineCommands(11), "команд");
    assert.equal(declineCommands(12), "команд");
    assert.equal(declineCommands(13), "команд");
    assert.equal(declineCommands(14), "команд");
    assert.equal(declineCommands(21), "команда");
    assert.equal(declineCommands(22), "команды");
    assert.equal(declineCommands(25), "команд");
    assert.equal(declineCommands(111), "команд");
  });

  test("part 2 header with Bash calls says source is not established (2 commands)", () => {
    const summary = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "bash-outcome.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: ["npm run build", "git add -A"] },
      "/repo",
    );
    assert.match(summary, /источник не установлен/);
    assert.match(summary, /2 команды Bash/);
    // Must not claim inclusion ("включая") or blame on "not this run".
    assert.doesNotMatch(summary, /включая/);
    assert.doesNotMatch(summary, /не этим запуском/);
    assert.match(summary, /bash-outcome\.txt \(создан\)/);
  });

  test("part 2 header declines the count for 1 и 5 и 11 Bash calls", () => {
    const one = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "b.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: ["ls -la"] },
      "/repo",
    );
    assert.match(one, /1 команда Bash/);

    const five = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "b.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: Array(5).fill("x") },
      "/repo",
    );
    assert.match(five, /5 команд Bash/);

    const eleven = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "b.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: Array(11).fill("x") },
      "/repo",
    );
    assert.match(eleven, /11 команд Bash/);
  });

  test("part 2 header with NO Bash calls falls back to 'не этим запуском'", () => {
    const summary = renderJournaledChangesSummary(
      { isGit: true, changes: [{ path: "parallel.txt", kind: "created" }] },
      { writtenFiles: [], bashCommands: [] },
      "/repo",
    );
    assert.match(summary, /\[zcode\] изменено в репозитории за время хода, но не этим запуском:/);
    assert.doesNotMatch(summary, /источник не установлен/);
    assert.doesNotMatch(summary, /Bash/);
  });
});
