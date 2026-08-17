// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { RecordData } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { emitSteamSnapshotRecords } from "./index.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/owned-game-record.json", import.meta.url), "utf8")
) as RecordData;

test("Steam full snapshots remain fully covered when fingerprints suppress unchanged records", async () => {
  assert.equal(fixture.playtime_forever, 0, "provider-reported zero playtime must remain zero, not become null");
  const firstCursor = openFingerprintCursor({});
  const firstEmitted: RecordData[] = [];
  const first = await emitSteamSnapshotRecords("owned_games", [fixture], firstCursor, (_stream, record) => {
    firstEmitted.push(record);
    return Promise.resolve();
  });

  assert.deepEqual(first, { considered: 1, covered: 1, emitted: 1 });
  assert.equal(firstEmitted.length, 1);

  const secondCursor = openFingerprintCursor({ fingerprints: firstCursor.toState() });
  const second = await emitSteamSnapshotRecords("owned_games", [fixture], secondCursor, () => Promise.resolve());

  assert.deepEqual(second, { considered: 1, covered: 1, emitted: 0 });
});
