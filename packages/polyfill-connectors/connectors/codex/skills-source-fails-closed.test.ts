// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `emitSkillsStream` must fail closed on an unreadable skills directory.
 *
 * codex's other two markdown streams (`rules`, `prompts`) already route through
 * `listIfExists`, which distinguishes ENOENT (legitimate absence) from a real
 * read failure and rethrows the latter. `emitSkillsStream` was the odd one out:
 * it swallowed EVERY error, so a permission failure on the skills directory was
 * indistinguishable from "this owner has no skills".
 *
 * The filesystem is this connector's entire source of truth, so an unreadable
 * directory is a source-boundary failure, never evidence of emptiness.
 *
 * The unreadable case is skipped as root, which bypasses permission bits.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "codex", "index.ts");
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

async function runSkills(codexHome: string): Promise<{ records: number; states: number }> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: { CODEX_HOME: codexHome, HOME: codexHome },
    start: { scope: { streams: [{ name: "skills" }] }, state: {}, type: "START" },
  });
  return {
    records: result.messages.filter((m) => m.type === "RECORD" && m.stream === "skills").length,
    states: result.messages.filter((m) => m.type === "STATE" && m.stream === "skills").length,
  };
}

test("an unreadable codex skills directory does not report an empty enumeration", {
  skip: RUNNING_AS_ROOT,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-codex-unreadable-"));
  const skillsDir = join(home, "skills");
  try {
    await mkdir(join(skillsDir, "demo"), { recursive: true });
    await writeFile(join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\n---\nREAL BODY\n");
    await chmod(skillsDir, 0o000);

    const outcome = await runSkills(home);

    // The load-bearing assertion: the unreadable directory must not be
    // silently reported as a clean, empty, checkpointed enumeration.
    assert.equal(outcome.records, 0, "no records can be read from an unreadable directory");
    assert.equal(
      outcome.states,
      0,
      "an unreadable source directory must not checkpoint a cursor claiming an empty enumeration"
    );
  } finally {
    await chmod(skillsDir, 0o755).catch(() => undefined);
    await rm(home, { force: true, recursive: true });
  }
});

test("a readable codex skills directory still emits its skills", async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-codex-readable-"));
  try {
    await mkdir(join(home, "skills", "demo"), { recursive: true });
    await writeFile(join(home, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nREAL BODY\n");

    const outcome = await runSkills(home);

    // Guards the opposite failure: a fail-closed guard that also tripped on a
    // perfectly readable directory would break every owner who has skills.
    assert.equal(outcome.records, 1, "a readable skills directory must still be enumerated");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
