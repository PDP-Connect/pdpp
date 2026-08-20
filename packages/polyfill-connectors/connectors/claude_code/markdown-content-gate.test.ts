// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The markdown streams (skills, slash_commands, memory_notes) gate re-emission
 * on FILE CONTENT, not on mtime.
 *
 * mtime is owner-controlled metadata, not a content fact. `git checkout` and
 * `rsync --times` both restore a prior mtime onto genuinely different bytes.
 * Under the old mtime-equality gate that file was skipped forever — reproduced
 * directly before the fix: a SKILL.md whose body changed completely, with its
 * mtime restored to the cursor's value, emitted ZERO records on the next run.
 *
 * These tests pin both directions, because a gate is only honest if it holds
 * both:
 *   - changed content + identical mtime  => MUST re-emit (the data-loss bug)
 *   - identical content + changed mtime  => MUST stay suppressed (no churn)
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "claude_code", "index.ts");

/** A fixed mtime, reapplied after every write so mtime is never the signal. */
const PINNED_MTIME = new Date("2026-01-01T00:00:00Z");

async function writePinned(path: string, body: string): Promise<void> {
  await writeFile(path, body);
  await utimes(path, PINNED_MTIME, PINNED_MTIME);
}

async function runClaudeCode(
  home: string,
  stream: string,
  state: Record<string, unknown>
): Promise<{ carried: Record<string, unknown>; records: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: ENTRYPOINT,
    env: {
      CLAUDE_CODE_HOME: home,
      HOME: home,
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
    },
    start: { scope: { streams: [{ name: stream }] }, state, type: "START" },
  });
  const carried: Record<string, unknown> = {};
  for (const message of result.messages) {
    if (message.type === "STATE" && typeof (message as { stream?: string }).stream === "string") {
      carried[(message as { stream: string }).stream] = (message as { cursor?: unknown }).cursor;
    }
  }
  return {
    carried,
    records: result.messages.filter((m) => m.type === "RECORD" && m.stream === stream),
  };
}

test("a skill whose content changes under a restored mtime is re-emitted", async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-cc-content-gate-"));
  try {
    const skillDir = join(home, "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writePinned(skillPath, "---\nname: demo\n---\nORIGINAL BODY\n");

    const first = await runClaudeCode(home, "skills", {});
    assert.equal(first.records.length, 1, "the skill should be emitted on a fresh run");

    // The exact `git checkout` / `rsync --times` shape: content replaced,
    // mtime restored to the value already in the cursor.
    await writePinned(skillPath, "---\nname: demo\n---\nCOMPLETELY DIFFERENT BODY\n");

    const second = await runClaudeCode(home, "skills", first.carried);
    // The load-bearing assertion. Under the mtime gate this was 0.
    assert.equal(second.records.length, 1, "changed content under an identical mtime must re-emit, not be skipped");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("an unchanged skill stays suppressed even when its mtime moves", async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-cc-content-gate-stable-"));
  try {
    const skillDir = join(home, "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    const body = "---\nname: demo\n---\nSTABLE BODY\n";
    await writePinned(skillPath, body);

    const first = await runClaudeCode(home, "skills", {});
    assert.equal(first.records.length, 1);

    // Byte-identical rewrite, but the mtime jumps forward — a touch, or any
    // tool that rewrites in place. Content is the signal, so this must NOT
    // churn. Guards the opposite failure from the test above.
    const later = new Date("2026-06-01T00:00:00Z");
    await writeFile(skillPath, body);
    await utimes(skillPath, later, later);

    const second = await runClaudeCode(home, "skills", first.carried);
    assert.equal(second.records.length, 0, "identical content must stay suppressed regardless of mtime");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("a slash command whose content changes under a restored mtime is re-emitted", async () => {
  const home = await mkdtemp(join(tmpdir(), "pdpp-cc-content-gate-cmd-"));
  try {
    const commandsDir = join(home, "commands");
    await mkdir(commandsDir, { recursive: true });
    const cmdPath = join(commandsDir, "deploy.md");
    await writePinned(cmdPath, "---\ndescription: original\n---\nrun the original steps\n");

    const first = await runClaudeCode(home, "slash_commands", {});
    assert.equal(first.records.length, 1);

    await writePinned(cmdPath, "---\ndescription: rewritten\n---\nrun completely different steps\n");

    const second = await runClaudeCode(home, "slash_commands", first.carried);
    assert.equal(second.records.length, 1, "slash_commands must use the same content gate as skills");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
