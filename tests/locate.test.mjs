import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { resolveZcodeCli, workspaceRef } from "../plugins/zcode/scripts/lib/locate.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-locate-test-"));
after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("workspaceRef derives workspaceKey as sha256(path).hex.slice(0, 12)", () => {
  const absPath = "/Users/example/project";
  const ref = workspaceRef(absPath);
  assert.equal(ref.workspacePath, absPath);
  assert.equal(ref.workspaceKey, createHash("sha256").update(absPath).digest("hex").slice(0, 12));
  assert.equal(ref.workspaceKey.length, 12);
});

test("workspaceRef rejects relative paths", () => {
  assert.throws(() => workspaceRef("relative/path"), /absolute path/);
});

// A path that is guaranteed not to house the real bundled CLI, so these tests
// behave the same whether or not ZCode.app happens to be installed on the
// machine running them.
const missingAppCliPath = path.join(tmpDir, "not-a-real-zcode-app", "zcode.cjs");

test("resolveZcodeCli(ZCODE_CLI) wraps a .cjs script with node", () => {
  const scriptPath = path.join(tmpDir, "zcode.cjs");
  fs.writeFileSync(scriptPath, "// fake cli\n");
  const cli = resolveZcodeCli({ env: { ZCODE_CLI: scriptPath }, appCliPath: missingAppCliPath });
  assert.equal(cli.command, process.execPath);
  assert.deepEqual(cli.args, [scriptPath]);
});

test("resolveZcodeCli(ZCODE_CLI) treats a non-script path as directly executable", () => {
  const binPath = path.join(tmpDir, "zcode-bin");
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode: 0o755 });
  const cli = resolveZcodeCli({ env: { ZCODE_CLI: binPath }, appCliPath: missingAppCliPath });
  assert.deepEqual(cli, { command: binPath, args: [] });
});

test("resolveZcodeCli falls back to the bundled app path when ZCODE_CLI is unset", () => {
  const appPath = path.join(tmpDir, "ZCode.app", "zcode.cjs");
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
  fs.writeFileSync(appPath, "// fake bundled cli\n");
  const cli = resolveZcodeCli({ env: {}, appCliPath: appPath });
  assert.equal(cli.command, process.execPath);
  assert.deepEqual(cli.args, [appPath]);
});

test("resolveZcodeCli finds an executable on PATH when nothing else matches, and returns its absolute path", () => {
  const binPath = path.join(tmpDir, "zcode");
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode: 0o755 });
  const cli = resolveZcodeCli({ env: { PATH: tmpDir }, appCliPath: missingAppCliPath });
  // Must be the resolved absolute path, not the bare "zcode" name: the
  // resolver's PATH and the transport's spawn environment are not guaranteed
  // to agree on where "zcode" points, so returning the bare name risks
  // ENOENT or spawning an unrelated binary at spawn time.
  assert.deepEqual(cli, { command: binPath, args: [] });
});

test("resolveZcodeCli resolves a relative PATH entry to an absolute command", () => {
  // A PATH entry doesn't have to be absolute (e.g. a shell config with
  // `PATH="./bin:$PATH"`, or a relative `node_modules/.bin`). The resolved
  // command must always be absolute — a relative one would later be resolved
  // by `spawn()` against whatever `cwd` the transport happens to use, not
  // necessarily the cwd in effect here, and could pick up the wrong binary
  // (or nothing at all).
  const dir = fs.mkdtempSync(path.join(tmpDir, "relpath-"));
  const binPath = path.join(dir, "zcode");
  fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode: 0o755 });

  const relativeDir = path.relative(process.cwd(), dir);
  const cli = resolveZcodeCli({ env: { PATH: relativeDir }, appCliPath: missingAppCliPath });

  assert.ok(path.isAbsolute(cli.command), `expected an absolute command, got: ${cli.command}`);
  assert.equal(cli.command, binPath);
});

test(
  "resolveZcodeCli skips a non-executable file on PATH",
  { skip: process.platform === "win32" },
  () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, "nonexec-"));
    const binPath = path.join(dir, "zcode");
    fs.writeFileSync(binPath, "#!/bin/sh\necho fake\n", { mode: 0o644 }); // no execute bit
    assert.throws(
      () => resolveZcodeCli({ env: { PATH: dir }, appCliPath: missingAppCliPath }),
      /Could not locate the ZCode CLI/,
    );
  },
);

// --- Round 3 defect #9: existsSync accepts directories, and relative paths
// resolve against the wrong cwd at spawn time -------------------------------

test("resolveZcodeCli rejects ZCODE_CLI pointing at a directory, not a file (e.g. the .app bundle itself)", () => {
  const dirPath = fs.mkdtempSync(path.join(tmpDir, "zcode-app-bundle-"));
  // `fs.existsSync` alone would accept this directory and hand it straight
  // to spawn() — which fails to exec a directory in exactly the way
  // docs/zcode-protocol-recon.md's ".app path breaks on update" warning
  // describes. With no other candidate available, resolution must fail.
  assert.throws(
    () => resolveZcodeCli({ env: { ZCODE_CLI: dirPath }, appCliPath: missingAppCliPath }),
    /Could not locate the ZCode CLI/,
  );
});

test("resolveZcodeCli rejects the bundled app path when it is a directory, not a file", () => {
  const dirPath = fs.mkdtempSync(path.join(tmpDir, "bundled-app-dir-"));
  assert.throws(() => resolveZcodeCli({ env: {}, appCliPath: dirPath }), /Could not locate the ZCode CLI/);
});

test("resolveZcodeCli resolves a relative ZCODE_CLI path against this process's cwd", () => {
  const scriptPath = path.join(tmpDir, "relative-zcode.cjs");
  fs.writeFileSync(scriptPath, "// fake cli\n");
  const relative = path.relative(process.cwd(), scriptPath);
  const cli = resolveZcodeCli({ env: { ZCODE_CLI: relative }, appCliPath: missingAppCliPath });
  assert.equal(cli.command, process.execPath);
  // Must be the resolved absolute path, not the relative string handed in —
  // otherwise spawn() would later resolve it against a possibly-different
  // `cwd`, inconsistent with how a relative PATH entry is already handled.
  assert.deepEqual(cli.args, [scriptPath]);
});

test("resolveZcodeCli resolves a relative appCliPath against this process's cwd", () => {
  const appPath = path.join(tmpDir, "relative-app-dir", "zcode.cjs");
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
  fs.writeFileSync(appPath, "// fake bundled cli\n");
  const relative = path.relative(process.cwd(), appPath);
  const cli = resolveZcodeCli({ env: {}, appCliPath: relative });
  assert.equal(cli.command, process.execPath);
  assert.deepEqual(cli.args, [appPath]);
});

test("resolveZcodeCli throws a helpful error when nothing is found", () => {
  assert.throws(
    () => resolveZcodeCli({ env: { PATH: path.join(tmpDir, "empty") }, appCliPath: missingAppCliPath }),
    (err) => {
      assert.match(err.message, /Could not locate the ZCode CLI/);
      assert.match(err.message, /ZCODE_CLI/);
      return true;
    },
  );
});
