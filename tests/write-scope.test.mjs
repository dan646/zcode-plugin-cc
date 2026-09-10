import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { createWriteScopePolicy, matchesPathGlob } from "../plugins/zcode/scripts/lib/write-scope.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-write-scope-test-"));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("matchesPathGlob", () => {
  test("supports ** at the beginning, middle, and end", () => {
    assert.equal(matchesPathGlob("src/app/index.mjs", "**/index.mjs"), true);
    assert.equal(matchesPathGlob("src/app/index.mjs", "src/**/index.mjs"), true);
    assert.equal(matchesPathGlob("src/app/index.mjs", "src/**"), true);
    assert.equal(matchesPathGlob("src/index.mjs", "src/**/index.mjs"), true);
  });

  test("supports * and ? without crossing path segments", () => {
    assert.equal(matchesPathGlob("database/migrations/2026_create.php", "database/migrations/*.php"), true);
    assert.equal(matchesPathGlob("database/migrations/nested/a.php", "database/migrations/*.php"), false);
    assert.equal(matchesPathGlob("app/a1.mjs", "app/a?.mjs"), true);
    assert.equal(matchesPathGlob("app/ab.mjs", "app/a?.mjs"), true);
    assert.equal(matchesPathGlob("app/a12.mjs", "app/a?.mjs"), false);
  });

  test("treats dots literally and a slashless pattern as a root-level pattern", () => {
    assert.equal(matchesPathGlob("README.md", "*.md"), true);
    assert.equal(matchesPathGlob("docs/README.md", "*.md"), false);
    assert.equal(matchesPathGlob(".env", "*"), true);
  });

  test("matches a directory itself for a trailing ** pattern", () => {
    assert.equal(matchesPathGlob("app", "app/**"), true);
    assert.equal(matchesPathGlob("app/components", "app/**"), true);
    assert.equal(matchesPathGlob("application", "app/**"), false);
  });
});

describe("createWriteScopePolicy", () => {
  test("allows Write and Edit inside --allow", () => {
    const policy = createWriteScopePolicy({ cwd: "/scope", allow: ["app/**"] });
    assert.equal(policy.decide({ toolName: "Write", input: { file_path: "app/a.mjs" } }).decision, "allow");
    assert.equal(policy.decide({ toolName: "Edit", input: { file_path: "/scope/app/a.mjs" } }).decision, "allow");
  });

  test("gives --deny priority and reports the rejected relative path", () => {
    const denied = [];
    const policy = createWriteScopePolicy({
      cwd: "/scope",
      allow: ["app/**"],
      deny: ["app/private/**"],
      onDenied: (entry) => denied.push(entry),
    });
    const result = policy.decide({ toolName: "Write", toolCallId: "call-1", input: { file_path: "app/private/key.mjs" } });
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /app\/private\/key\.mjs/);
    assert.equal(denied[0].toolCallId, "call-1");
  });

  test("denies paths outside cwd and an unusable Write/Edit path", () => {
    const policy = createWriteScopePolicy({ cwd: "/scope", deny: ["secrets/**"] });
    assert.equal(policy.decide({ toolName: "Edit", input: { file_path: "../outside.txt" } }).decision, "deny");
    assert.equal(policy.decide({ toolName: "Write", input: {} }).decision, "deny");
  });

  test("checks every path-bearing tool and permits Bash", () => {
    const policy = createWriteScopePolicy({ cwd: "/scope", allow: ["src/**"] });
    assert.equal(policy.decide({ toolName: "Write", input: { file_path: "src/inside.txt" } }).decision, "allow");
    assert.equal(policy.decide({ toolName: "NotebookEdit", input: { notebook_path: "notebooks/outside.ipynb" } }).decision, "deny");
    assert.equal(policy.decide({ toolName: "future-writer", input: { path: "docs/outside.txt" } }).decision, "deny");
    assert.equal(policy.decide({ toolName: "Bash", input: { command: "echo x > elsewhere.txt" } }).decision, "allow");
  });

  test("denies case variants of an on-disk denied path on macOS", { skip: process.platform !== "darwin" }, () => {
    const cwd = fs.mkdtempSync(path.join(tmpDir, "case-insensitive-"));
    fs.mkdirSync(path.join(cwd, "resources", "js"), { recursive: true });
    const policy = createWriteScopePolicy({ cwd, deny: ["resources/js/**"] });

    assert.equal(policy.decide({ toolName: "Write", input: { file_path: "Resources/JS/app.tsx" } }).decision, "deny");
    assert.equal(policy.decide({ toolName: "Write", input: { file_path: "RESOURCES/js/app.tsx" } }).decision, "deny");
  });
});
