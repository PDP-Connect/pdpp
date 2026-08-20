// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An unreadable source directory must never be reported as "zero files".
 *
 * The filesystem is this connector's whole source of truth, so a directory it
 * cannot enumerate is a source-boundary failure — NOT evidence of emptiness.
 * A missing directory (ENOENT) is different: an owner with no
 * `~/.claude/skills` genuinely has no skills, and an empty answer is correct.
 *
 * Reproduced before the guard: `chmod 000` on a skills directory holding a real
 * skill produced 0 records, ZERO skips, no error, and a STATE checkpoint with
 * an empty cursor — the run silently recorded "this owner has no skills" and
 * persisted it. That is the fail-open shape these tests forbid.
 *
 * These tests are skipped when running as root, which bypasses permission bits.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "claude_code", "index.ts");
// chmod bits do not restrain root, so the unreadable-dir premise cannot hold.
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

async function runSkills(home: string): Promise<{
  records: number;
  states: number;
  unreadable: number;
}> {
  const result = await runConnectorProtocolSubprocess({
    // Matches every existing claude_code protocol test: this connector can exit
    // non-zero after DONE for reasons unrelated to the streams under test.
    allowFailedDone: true,
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      CLAUDE_CODE_HOME: home,
      CLAUDE_CODE_PROJECTS_DIR: join(home, "projects"),
      HOME: home,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
    },
    start: { scope: { streams: [{ name: "skills" }] }, state: {}, type: "START" },
  });
  return {
    records: result.messages.filter((m) => m.type === "RECORD" && m.stream === "skills").length,
    states: result.messages.filter((m) => m.type === "STATE" && m.stream === "skills").length,
    unreadable: result.messages.filter(
      (m) => m.type === "SKIP_RESULT" && m.stream === "skills" && m.reason === "source_unreadable"
    ).length,
  };
}

test("an unreadable skills directory does not checkpoint an empty cursor", { skip: RUNNING_AS_ROOT }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-cc-unreadable-"));
  const skillsDir = join(home, "skills");
  try {
    await mkdir(join(home, "projects"), { recursive: true });
    const skillDir = join(skillsDir, "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: demo\n---\nREAL BODY\n");
    await chmod(skillsDir, 0o000);

    const outcome = await runSkills(home);

    // The load-bearing assertion. Before the guard this was `states: 1` with an
    // empty `file_mtimes` map — a persisted claim that the owner has no skills.
    assert.equal(
      outcome.states,
      0,
      "an unreadable source directory must not produce a STATE checkpoint claiming an empty enumeration"
    );
    assert.equal(outcome.records, 0, "no records can be read from an unreadable directory");
    assert.equal(outcome.unreadable, 1, "the failed enumeration must surface as a skip, not silence");
  } finally {
    await chmod(skillsDir, 0o755).catch(() => undefined);
    await rm(home, { force: true, recursive: true });
  }
});

test("a genuinely missing skills directory is still an honest empty enumeration", async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-cc-absent-"));
  try {
    // A readable home with a `projects` dir but NO `skills` dir: the skills
    // enumeration hits ENOENT. This owner truly has no skills, so the run must
    // succeed and checkpoint normally. Guards the opposite failure — a
    // fail-closed guard that also tripped on legitimate absence would break
    // every owner who has never created a skill.
    //
    // (`projects` is created because the connector requires the surrounding
    // home layout to run at all; a bare temp dir exits non-zero on the
    // unmodified connector too, so its absence would not test this guard.)
    await mkdir(join(home, "projects"), { recursive: true });

    const outcome = await runSkills(home);

    // The distinction that matters: absence is NOT reported as a source
    // failure. (Verified against the unmodified connector, an absent skills
    // directory also produces no STATE — the stream is simply not exercised.
    // This guard must not change that; it must only stop an UNREADABLE
    // directory from checkpointing.)
    assert.equal(outcome.unreadable, 0, "an absent directory is legitimate, not a source failure");
    assert.equal(outcome.records, 0);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
