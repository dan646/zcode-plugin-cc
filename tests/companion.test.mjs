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
import { buildReviewDiff } from "../plugins/zcode/scripts/lib/diff.mjs";
import {
  runCli,
  parseModelFlag,
  parseTimeoutFlag,
  parseModeFlag,
  formatToolCallLine,
  formatHeartbeatLine,
  buildCodePrompt,
  buildReviewPrompt,
  ZCODE_MODES,
  EXIT_OK,
  EXIT_ERROR,
  EXIT_TURN_FAILED,
} from "../plugins/zcode/scripts/zcode-companion.mjs";

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
    assert.equal(formatToolCallLine({ type: "model.streaming", kind: "tool_call" }), null); // no toolName
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
