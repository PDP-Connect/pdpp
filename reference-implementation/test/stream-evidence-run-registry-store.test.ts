// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteStreamEvidenceRunRegistryStore } from "../server/stores/stream-evidence-run-registry-store.ts";

function withTempDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-run-registry-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

test(
  "claimStreamEvidenceForRunId: concurrent claims for the SAME (run_id, stream) — exactly one wins",
  withTempDb(async () => {
    // Independent exact-head re-review: a separate has()-then-mark() pair is
    // a TOCTOU race under concurrent invocations. This proves the single
    // atomic claim actually serializes: of N concurrent calls for the same
    // (run_id, stream), exactly one must observe `claimed: true`.
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claimStreamEvidenceForRunId("cin_concurrency", "run_race", "messages"))
    );
    const wins = results.filter((claimed) => claimed === true).length;
    const losses = results.filter((claimed) => claimed === false).length;
    assert.equal(wins, 1, "exactly one of the concurrent claims for the same (run_id, stream) must win");
    assert.equal(losses, 7, "every other concurrent claim for the same (run_id, stream) must lose");
  })
);

test(
  "claimStreamEvidenceForRunId: a second SEQUENTIAL claim for the same (run_id, stream) loses",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const first = await store.claimStreamEvidenceForRunId("cin_sequential", "run_a", "messages");
    const second = await store.claimStreamEvidenceForRunId("cin_sequential", "run_a", "messages");
    assert.equal(first, true, "the first claim for a fresh (run_id, stream) must win");
    assert.equal(second, false, "a later claim for the SAME (run_id, stream) must lose, even sequentially");
  })
);

test(
  "claimStreamEvidenceForRunId: a DIFFERENT stream under the same run_id is an independent claim",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const messages = await store.claimStreamEvidenceForRunId("cin_control", "run_shared", "messages");
    const bodies = await store.claimStreamEvidenceForRunId("cin_control", "run_shared", "bodies");
    assert.equal(messages, true, "the first stream under this run_id must win its own claim");
    assert.equal(bodies, true, "a different stream under the SAME run_id must win an independent claim");
  })
);

test(
  "claimStreamEvidenceForRunId: the SAME stream under a DIFFERENT run_id is an independent claim",
  withTempDb(async () => {
    const store = createSqliteStreamEvidenceRunRegistryStore();
    const runOne = await store.claimStreamEvidenceForRunId("cin_control", "run_one", "messages");
    const runTwo = await store.claimStreamEvidenceForRunId("cin_control", "run_two", "messages");
    assert.equal(runOne, true, "the first run_id claiming this stream must win");
    assert.equal(runTwo, true, "a different run_id claiming the SAME stream must win an independent claim");
  })
);

test(
  "claimStreamEvidenceForRunId: durability — a claim recorded before closeDb()/initDb() (simulating a process restart) is still honored",
  withTempDb(async () => {
    // This is the exact scenario independent exact-head re-review flagged:
    // an in-memory registry loses the fact on process restart. Here the
    // underlying SQLite FILE (not `:memory:`) persists across a close/reopen
    // of the same path, standing in for a runtime process restart while the
    // durable store's backing file survives.
    const dir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-run-registry-restart-"));
    const dbPath = join(dir, "pdpp.sqlite");
    try {
      initDb(dbPath);
      const store = createSqliteStreamEvidenceRunRegistryStore();
      const before = await store.claimStreamEvidenceForRunId("cin_restart", "run_restart", "messages");
      assert.equal(before, true, "the pre-restart claim must win");
      closeDb();

      // Reopen the SAME database file, standing in for a fresh process
      // lifetime after a restart.
      initDb(dbPath);
      const storeAfterRestart = createSqliteStreamEvidenceRunRegistryStore();
      const after = await storeAfterRestart.claimStreamEvidenceForRunId("cin_restart", "run_restart", "messages");
      assert.equal(
        after,
        false,
        "re-claiming the SAME (run_id, stream) after a simulated process restart must still lose " +
          "— the durable claim from before the restart must still be honored"
      );
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  })
);
