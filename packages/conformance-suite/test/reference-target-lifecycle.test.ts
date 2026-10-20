// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Lifecycle safety of scripts/reference-target.sh, exercised by sourcing the
// script's functions (it only dispatches when executed) with stub processes and
// a synthetic checkout. No reference implementation is started.
//
// Protected risks:
//   - signalling a PID the kernel reused for an unrelated process after the
//     owned server exited early;
//   - labelling a stale build output with the new commit after a failed rebuild;
//   - two runs sharing one output directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PATTERN_BYSTANDER_ALIVE = /BYSTANDER_ALIVE/;
const PATTERN_BYSTANDER_KILLED = /BYSTANDER_KILLED/;
const PATTERN_STOPPED = /STOPPED/;
const PATTERN_RC_1 = /rc=1/;
const PATTERN_START_D = /start=\d+/;
const PATTERN_BUILD_FAILED = /build failed/;
const PATTERN_NOT_INSTALLED = /NOT_INSTALLED/;
const PATTERN_MISSING_OR_EMPTY = /missing or empty/;
const PATTERN_SECOND_1 = /second=1/;

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "reference-target.sh");
const SCRATCH_ROOT = join(process.env.TMPDIR ?? join(homedir(), ".tmp"), "conformance-lifecycle-tests");
mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = mkdtempSync(join(SCRATCH_ROOT, "run-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run a bash snippet with the script's functions loaded. */
function sh(snippet: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `set -euo pipefail; source "${SCRIPT}"; ${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, PDPP_REF_STATE_DIR: join(scratch, "state"), ...env },
    timeout: 60_000,
  });
}

it("instance omission accepts only its specific PAR refusal and tolerates unrelated OAuth error shapes", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import ast, json, re, sys
source = open(sys.argv[1]).read()
functions = [node for block in re.findall(r"<<'PY'\\n(.*?)\\nPY", source, re.S)
    for node in ast.parse(block).body if isinstance(node, ast.FunctionDef) and node.name == "is_omission_refusal"]
assert len(functions) == 1
scope = {"json": json}
exec(compile(ast.Module(body=functions, type_ignores=[]), "refusal classifier", "exec"), scope)
classify = scope["is_omission_refusal"]
specific = json.dumps({"error": {"code": "source.authorization_details_invalid",
    "message": "Omitted instance_ids requires exactly one eligible instance for stream 'items', found 2"}})
assert classify("PAR", 400, specific) is True
for stage, status in [("review", 400), ("approval", 400), ("PAR", 401), ("PAR", 404)]:
    assert classify(stage, status, specific) is False
for body in ['{"error":"invalid_request"}', '{"error":null}', '[]', 'null', 'not-json',
    '{"error":{"code":"source.authorization_details_invalid","message":[]}}', '{}']:
    assert classify("PAR", 400, body) is False
`,
      SCRIPT,
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
});

describe("process identity: a recycled PID is never signalled", () => {
  it("does not signal a bystander that holds the PID of a server that exited early", () => {
    // The 'server' exits immediately; its recorded start time then belongs to a
    // dead process. The bystander stands in for an unrelated process that was
    // handed the number afterwards (simulated by pointing SERVER_PID at it).
    const result = sh(`
      sleep 0.2 & SERVER_PID=$!
      SERVER_START=$(proc_start_time "$SERVER_PID")
      wait "$SERVER_PID"
      sleep 30 & bystander=$!
      SERVER_PID=$bystander
      stop_all
      if kill -0 "$bystander" 2>/dev/null; then echo BYSTANDER_ALIVE; else echo BYSTANDER_KILLED; fi
      kill -KILL "$bystander" 2>/dev/null || true
      wait "$bystander" 2>/dev/null || true
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, PATTERN_BYSTANDER_ALIVE);
    assert.doesNotMatch(result.stdout, PATTERN_BYSTANDER_KILLED);
  });

  it("stops the owned process whose identity still matches", () => {
    const result = sh(`
      sleep 30 & SERVER_PID=$!
      SERVER_START=$(proc_start_time "$SERVER_PID")
      pid=$SERVER_PID
      stop_all
      if kill -0 "$pid" 2>/dev/null; then echo STILL_ALIVE; else echo STOPPED; fi
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, PATTERN_STOPPED);
  });

  it("wait_until_ready reports an early server exit instead of waiting on a reused PID", () => {
    const result = sh(`
      LOG_FILE=/dev/null
      true & SERVER_PID=$!
      SERVER_START=$(proc_start_time "$SERVER_PID" || echo 1)
      wait "$SERVER_PID" || true
      sleep 30 & other=$!
      SERVER_PID=$other
      rc=0
      READY_TIMEOUT_SECONDS=5
      wait_until_ready || rc=$?
      kill -KILL "$other" 2>/dev/null || true
      echo "rc=$rc"
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, PATTERN_RC_1);
  });

  it("parses start time from a comm containing spaces and parentheses", () => {
    const result = sh(`
      mkdir -p "$PDPP_REF_STATE_DIR"
      cp "$(readlink -f "$(command -v python3)")" "$PDPP_REF_STATE_DIR/we ird) (name"
      "$PDPP_REF_STATE_DIR/we ird) (name" -c 'import time; time.sleep(30)' & pid=$!
      sleep 0.2
      echo "start=$(proc_start_time "$pid")"
      kill -KILL "$pid"; wait "$pid" 2>/dev/null || true
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, PATTERN_START_D);
  });
});

/** A git checkout whose four vendored packages build via small npm scripts. */
function fakeCheckout(name: string, builds: Record<string, string>) {
  const root = join(scratch, name);
  rmSync(root, { recursive: true, force: true });
  const packages: Record<string, string> = {
    "packages/connector-protocol": "dist/index.js",
    "reference-implementation/vendor/read-core": "dist/index.js",
    "reference-implementation/vendor/cli": "dist/src/index.js",
    "reference-implementation/vendor/mcp-server": "dist/src/server.js",
  };
  for (const [dir, output] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    const build = builds[dir] ?? `mkdir -p ${dirname(output)} && echo built > ${output}`;
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir, version: "0.0.0", scripts: { build } }));
  }
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "node_modules\ndist\n");
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, "-c", "user.email=t@e.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { root, git };
}

const STAMP = "node_modules/.pdpp-conformance-built-sha";

describe("build provenance: a failed or empty rebuild never inherits a stamp or stale output", () => {
  it("builds, verifies every output, then stamps HEAD", () => {
    const { root, git } = fakeCheckout("ok", {});
    const head = git("rev-parse", "HEAD").stdout.trim();
    const result = sh("build_vendored_and_stamp", { PDPP_DC_REF: root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, STAMP), "utf8").trim(), head);
    assert.ok(existsSync(join(root, "reference-implementation/vendor/mcp-server/dist/src/server.js")));
  });

  it("removes stale output and refuses to stamp when a rebuild fails", () => {
    const failing = "reference-implementation/vendor/mcp-server";
    const { root, git } = fakeCheckout("stale", { [failing]: "echo boom >&2; exit 1" });
    // Output left by an earlier, successful build of an older commit.
    const stale = join(root, failing, "dist/src/server.js");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "OLD COMMIT OUTPUT");
    writeFileSync(join(root, STAMP), "0000000000000000000000000000000000000000");
    const result = sh("build_vendored_and_stamp", { PDPP_DC_REF: root });
    assert.notEqual(result.status, 0, "a failed build must fail the install");
    assert.match(result.stderr, PATTERN_BUILD_FAILED);
    assert.equal(existsSync(stale), false, "stale output must not survive a failed rebuild");
    assert.equal(existsSync(join(root, STAMP)), false, "no stamp may remain for the new HEAD");
    const isInstalled = sh("is_installed && echo INSTALLED || echo NOT_INSTALLED", { PDPP_DC_REF: root });
    assert.match(isInstalled.stdout, PATTERN_NOT_INSTALLED);
    assert.ok(git("rev-parse", "HEAD").stdout.trim().length > 0);
  });

  it("refuses to stamp when a build exits zero but emits no output", () => {
    const silent = "reference-implementation/vendor/cli";
    const { root } = fakeCheckout("silent", { [silent]: "true" });
    const result = sh("build_vendored_and_stamp", { PDPP_DC_REF: root });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, PATTERN_MISSING_OR_EMPTY);
    assert.equal(existsSync(join(root, STAMP)), false);
  });
});

describe("output directories: concurrent runs cannot share one", () => {
  it("refuses a second claim on a directory that is in use", () => {
    const out = join(scratch, "out-shared");
    mkdirSync(out, { recursive: true });
    const result = sh(
      `
      claim_out_dir "${out}"
      rc=0
      ( bash -c 'set -euo pipefail; source "${SCRIPT}"; claim_out_dir "${out}"' ) 2>/dev/null || rc=$?
      echo "second=$rc"
    `
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, PATTERN_SECOND_1);
  });

  it("clears only the files a run owns, so a stale report cannot survive", () => {
    const out = join(scratch, "out-clear");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "report.json"), "STALE");
    writeFileSync(join(out, "server.log"), "STALE");
    writeFileSync(join(out, "notes.txt"), "mine");
    const result = sh(`claim_out_dir "${out}"`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(out, "report.json")), false);
    assert.equal(existsSync(join(out, "server.log")), false);
    assert.equal(readFileSync(join(out, "notes.txt"), "utf8"), "mine");
  });
});
