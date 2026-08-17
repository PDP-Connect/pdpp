// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the scoped-archive message-family DETAIL_COVERAGE duplication bug
 * (production: 8 Slack runs, 0 successes — see
 * openspec/changes/fix-slack-scoped-archive-coverage-duplication).
 *
 * `reconcileMessageSourceCache` heals a base archive missing channels a prior
 * run observed by pulling each missing channel's existing scoped archive
 * (archive-scoped/<digest>/) — see the single-scoped-archive case in
 * archive-reclaim.test.ts. When 2+ DISTINCT scoped archives are needed (each
 * covering a different missing channel — production sees 3),
 * `mergeScopedMessageArchivePasses`'s `for (const archive of
 * deps.scopedArchives)` loop calls `runRequestedStreams` once per archive.
 *
 * Before the fix, `runRequestedStreams` itself emitted the messages
 * self-coverage DETAIL_COVERAGE (state_stream=messages, stream=messages) and
 * the message-family DETAIL_COVERAGE (state_stream=messages,
 * stream=reactions|message_attachments) on EVERY call — so N archives meant N
 * emissions of each pair through the same emit side-channel.
 * reference-implementation/runtime/index.ts's `trackDetailCoverage` rejects
 * any repeated (state_stream, stream) pair ("Connector emitted duplicate
 * DETAIL_COVERAGE for state_stream=messages stream=messages"), so a
 * production run touching 2+ scoped archives never completed.
 *
 * This test seeds a base archive missing TWO channels, each recoverable from
 * its own separate pre-existing scoped archive, drives the real connector
 * (PDPP_SLACK_SKIP_SLACKDUMP=1 — no real slackdump subprocess) via
 * `runConnectorProtocolSubprocess`, and asserts on the RAW emitted message
 * sequence: each (state_stream, stream) DETAIL_COVERAGE pair must appear
 * EXACTLY ONCE, with `considered` equal to the summed row count across the
 * base archive + both scoped archives (mergeMessagesPassResults sums
 * `considered`).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveConnectorArtifactDir } from "../../src/connector-artifact-root.ts";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const SLACK_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "slack", "index.ts");

function seedArchiveRoot(artifactRoot: string, workspace: string): string {
  return resolveConnectorArtifactDir("slack", [workspace], {
    PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
  }).root;
}

/** Mirrors archive-reclaim.test.ts's digest helper: the connector selects a
 *  scoped archive by hashing its sorted covered-channel-id set. */
async function scopedArchiveDigest(channels: readonly string[]): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(JSON.stringify([...new Set(channels)].sort()))
    .digest("hex")
    .slice(0, 12);
}

function seedArchiveSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE CHANNEL (ID TEXT NOT NULL, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
    CREATE TABLE MESSAGE (
      CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER,
      TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL
    );
  `);
}

function insertChannel(db: DatabaseSync, id: string, name: string): void {
  db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
    id,
    name,
    JSON.stringify({ is_channel: true, is_member: true, name }),
    1
  );
}

function insertMessages(db: DatabaseSync, channelId: string, count: number, tsPrefix: string): void {
  const stmt = db.prepare(
    "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (let i = 0; i < count; i += 1) {
    const ts = `${tsPrefix}${String(i).padStart(6, "0")}`;
    const text = `message ${String(i)}`;
    stmt.run(channelId, ts, null, 1, text, null, new TextEncoder().encode(JSON.stringify({ text, user: "U1" })), 1);
  }
}

function detailCoverageMessages(result: { messages: EmittedMessage[] }) {
  return result.messages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE"
  );
}

test("scoped-archive fold across 2+ archives: each (state_stream, stream) DETAIL_COVERAGE pair emits exactly once, with the summed considered", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "pdpp-slack-scoped-coverage-"));
  try {
    const workspace = "scoped-coverage-ws";
    const baseArchiveDir = join(seedArchiveRoot(artifactRoot, workspace), "archive");
    const scopedDigestA = await scopedArchiveDigest(["C0MISSING_A"]);
    const scopedDigestB = await scopedArchiveDigest(["C0MISSING_B"]);
    const scopedArchiveDirA = join(seedArchiveRoot(artifactRoot, workspace), "archive-scoped", scopedDigestA);
    const scopedArchiveDirB = join(seedArchiveRoot(artifactRoot, workspace), "archive-scoped", scopedDigestB);
    await mkdir(baseArchiveDir, { recursive: true });
    await mkdir(scopedArchiveDirA, { recursive: true });
    await mkdir(scopedArchiveDirB, { recursive: true });

    // Base archive: only the still-present channel. C0MISSING_A/B disappeared
    // from it (e.g. slackdump export scope drifted) but a prior run's state
    // still lists them as observed, forcing reconcileMessageSourceCache to
    // heal both from their own separate scoped archives.
    const baseDb = new DatabaseSync(join(baseArchiveDir, "slackdump.sqlite"));
    try {
      seedArchiveSchema(baseDb);
      insertChannel(baseDb, "C0PRESENT", "present");
      insertMessages(baseDb, "C0PRESENT", 2, "1714032800.");
    } finally {
      baseDb.close();
    }
    const scopedDbA = new DatabaseSync(join(scopedArchiveDirA, "slackdump.sqlite"));
    try {
      seedArchiveSchema(scopedDbA);
      insertChannel(scopedDbA, "C0MISSING_A", "missing-a");
      insertMessages(scopedDbA, "C0MISSING_A", 3, "1714032810.");
    } finally {
      scopedDbA.close();
    }
    const scopedDbB = new DatabaseSync(join(scopedArchiveDirB, "slackdump.sqlite"));
    try {
      seedArchiveSchema(scopedDbB);
      insertChannel(scopedDbB, "C0MISSING_B", "missing-b");
      insertMessages(scopedDbB, "C0MISSING_B", 5, "1714032820.");
    } finally {
      scopedDbB.close();
    }

    const result = await runConnectorProtocolSubprocess({
      cwd: PACKAGE_ROOT,
      entrypoint: SLACK_ENTRYPOINT,
      env: {
        PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
        PDPP_SLACK_SKIP_SLACKDUMP: "1",
        SLACK_COOKIE: "xoxd-fake",
        SLACK_TOKEN: "xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        SLACK_WORKSPACE: workspace,
      },
      start: {
        type: "START",
        scope: { streams: [{ name: "messages" }, { name: "reactions" }, { name: "message_attachments" }] },
        state: {
          messages: {
            channel_last_ts: {
              C0MISSING_A: "1714032700.000000",
              C0MISSING_B: "1714032700.000000",
              C0PRESENT: "1714032700.000000",
            },
            last_ts: "1714032700.000000",
            observed_channel_ids: ["C0MISSING_A", "C0MISSING_B", "C0PRESENT"],
          },
        },
      },
    });

    const done = result.messages.findLast((m): m is Extract<EmittedMessage, { type: "DONE" }> => m.type === "DONE");
    assert.ok(done, "connector reached a terminal DONE");
    assert.equal(
      done.status,
      "succeeded",
      `run must succeed after healing both missing channels: ${JSON.stringify(done)}`
    );

    const coverage = detailCoverageMessages(result);
    const messagesCoverage = coverage.filter((m) => m.state_stream === "messages" && m.stream === "messages");
    const reactionsCoverage = coverage.filter((m) => m.state_stream === "messages" && m.stream === "reactions");
    const attachmentsCoverage = coverage.filter(
      (m) => m.state_stream === "messages" && m.stream === "message_attachments"
    );

    // THE BUG: with 2 scoped archives folded (base + A + B = 3 total
    // runRequestedStreams calls), each (state_stream, stream) pair emitted 3
    // times pre-fix. The RI runtime rejects any repeat, so production Slack
    // never completed a run with 2+ scoped archives. Fixed behavior: exactly
    // one emission per pair, regardless of archive count.
    assert.equal(
      messagesCoverage.length,
      1,
      "messages self-coverage must emit exactly once across the base + 2 scoped archives, not once per archive " +
        `(got ${messagesCoverage.length} — this is the duplicate the runtime rejects)`
    );
    assert.equal(
      reactionsCoverage.length,
      1,
      `reactions family coverage must emit exactly once across the fold (got ${reactionsCoverage.length})`
    );
    assert.equal(
      attachmentsCoverage.length,
      1,
      `message_attachments family coverage must emit exactly once across the fold (got ${attachmentsCoverage.length})`
    );

    // The merged denominator: mergeMessagesPassResults sums `considered`
    // across archives. Base (2 rows) + scoped A (3 rows) + scoped B (5 rows)
    // = 10. A regression that keeps emission single but reverts to only the
    // LAST archive's total (5) or the FIRST call's total (2) must fail here.
    assert.equal(messagesCoverage[0]?.considered, 10, "considered is the SUMMED total across every archive folded");
    assert.equal(
      reactionsCoverage[0]?.considered,
      10,
      "reactions family denominator mirrors the summed messages total"
    );
    assert.equal(
      attachmentsCoverage[0]?.considered,
      10,
      "message_attachments family denominator mirrors the summed messages total"
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
