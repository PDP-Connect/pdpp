// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import { deleteAllRecordsForConnector, ingestRecord } from "../server/records.ts";

test("deleteAllRecordsForConnector canonicalizes first-party registry URLs before deleting records", async () => {
  initDb(":memory:");
  try {
    const storageTarget = {
      connector_id: "github",
      connector_instance_id: "cin_test_github_fixture_transition",
    };
    await ingestRecord(storageTarget, {
      data: {
        id: "gh:commit:abc1",
        message: "fixture commit that must not survive manifest reconciliation",
        repo_full_name: "seedowner/personal-site",
      },
      emitted_at: "2026-04-25T00:00:00.000Z",
      key: "gh:commit:abc1",
      op: "upsert",
      stream: "commits",
    });

    const result = await deleteAllRecordsForConnector("https://registry.pdpp.dev/connectors/github");

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.streams, ["commits"]);
    const remaining = getDb()
      .prepare("SELECT COUNT(*) AS count FROM records WHERE connector_id = ?")
      .get<{ count: number }>("github");
    assert.ok(remaining, "remaining record count query returns a row");
    assert.equal(remaining.count, 0);
  } finally {
    closeDb();
  }
});
