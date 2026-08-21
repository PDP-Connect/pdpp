// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Slack cursor invariant: a durable watermark records what was EMITTED,
 * never what was merely ITERATED.
 *
 * Why this is a data-loss invariant and not a reporting nicety: the next
 * run asks the archive for rows with `TS > cursor` (buildMessageRowsQuery).
 * A row that raises the cursor without being emitted is therefore never
 * fetched again and never stored — silent, permanent loss, with no gap or
 * diagnostic to show for it.
 *
 * The two ways a walked row can fail to be emitted, both covered here:
 *
 *   1. The run is channel-scoped, so `emitMessageRecordScopedByChannel`
 *      drops rows for channels outside the scope. A scoped run reads the
 *      whole BASE archive, so it walks rows for every other channel in the
 *      workspace on its way past.
 *   2. The `messages` stream is not requested at all (a reactions-only or
 *      attachments-only run still co-traverses the same MESSAGE rows).
 *
 * Plus the query-side half of the same rule: a channel with no committed
 * cursor must start from zero, not inherit an unrelated global floor.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { RecordData } from "../../src/connector-runtime.ts";
import { buildMessageRowsQuery, emitMessagesPass } from "./index.ts";
import type { MessageRow } from "./types.ts";

function messageRow(channelId: string, ts: string): MessageRow {
  return {
    CHANNEL_ID: channelId,
    DATA: JSON.stringify({ text: "hi", user: "U1" }),
    IS_PARENT: 0,
    NUM_FILES: 0,
    THREAD_TS: null,
    TS: ts,
    TXT: "hi",
  };
}

/**
 * Mirrors the production wiring in `collect()`: `messages` records go
 * through the channel-scope guard, which resolves `false` for a record
 * outside the scope. Everything else is emitted unconditionally.
 */
function scopedDeps(inScope: ReadonlySet<string>): {
  deps: Parameters<typeof emitMessagesPass>[0];
  emitted: RecordData[];
} {
  const emitted: RecordData[] = [];
  return {
    emitted,
    deps: {
      emitRecord: (stream: string, data: RecordData) => {
        if (stream === "messages" && !(typeof data.channel_id === "string" && inScope.has(data.channel_id))) {
          return Promise.resolve(false);
        }
        emitted.push(data);
        return Promise.resolve(true);
      },
      emittedAt: "2026-08-21T00:00:00.000Z",
      progress: () => Promise.resolve(),
      requested: new Map([["messages", { name: "messages" }]]),
    } as Parameters<typeof emitMessagesPass>[0],
  };
}

// ─── 1. Dropped by the channel-scope guard ───────────────────────────────

test("a row dropped by the channel-scope guard does not advance that channel's watermark", async () => {
  const { deps, emitted } = scopedDeps(new Set(["C_IN"]));
  const result = await emitMessagesPass(
    deps,
    [messageRow("C_IN", "1700000000.000100"), messageRow("C_OUT", "1700000009.000900")],
    null
  );

  assert.equal(emitted.length, 1, "only the in-scope row reached the runtime");
  assert.equal(
    result.channelMaxTs.C_OUT,
    undefined,
    "the dropped channel must have NO durable watermark: a cursor here would make its history unreachable"
  );
  assert.equal(result.channelMaxTs.C_IN, "1700000000.000100", "the emitted channel still advances");
});

test("the global last_ts does not advance past a row the scope guard dropped", async () => {
  // The dropped row carries the HIGHEST ts in the pass, so a watermark
  // taken over iteration would commit the global floor to a message that
  // was never stored.
  const { deps } = scopedDeps(new Set(["C_IN"]));
  const result = await emitMessagesPass(
    deps,
    [messageRow("C_IN", "1700000000.000100"), messageRow("C_OUT", "1700009999.000900")],
    null
  );

  assert.equal(result.maxMessageTs, "1700000000.000100", "last_ts reflects the emitted max, not the iterated max");
});

test("iterated-max stays observable, and separate from the durable cursor", async () => {
  const { deps } = scopedDeps(new Set(["C_IN"]));
  const result = await emitMessagesPass(
    deps,
    [messageRow("C_IN", "1700000000.000100"), messageRow("C_OUT", "1700009999.000900")],
    null
  );

  assert.equal(
    result.iteratedChannelMaxTs.C_OUT,
    "1700009999.000900",
    "progress reporting can still see the walked row"
  );
  assert.equal(result.channelMaxTs.C_OUT, undefined, "but it must not leak into the durable cursor");
  assert.notDeepEqual(result.channelMaxTs, result.iteratedChannelMaxTs, "the two are genuinely distinct");
});

test("a fully out-of-scope pass commits no cursor at all", async () => {
  const { deps, emitted } = scopedDeps(new Set(["C_ELSEWHERE"]));
  const result = await emitMessagesPass(deps, [messageRow("C_A", "1700000001.000000")], null);

  assert.equal(emitted.length, 0);
  assert.deepEqual(result.channelMaxTs, {}, "nothing emitted means nothing committed");
  assert.equal(result.maxMessageTs, null);
});

test("considered/covered still count every walked row, emitted or not", async () => {
  // Coverage accounting is deliberately NOT changed by the cursor fix: the
  // rows really were weighed. Only the cursor is emission-gated.
  const { deps } = scopedDeps(new Set(["C_IN"]));
  const result = await emitMessagesPass(
    deps,
    [messageRow("C_IN", "1700000000.000100"), messageRow("C_OUT", "1700000009.000900")],
    null
  );

  assert.equal(result.considered, 2);
  assert.equal(result.covered, 2);
});

// ─── 2. `messages` not requested ─────────────────────────────────────────

test("a reactions-only pass does not advance the messages cursor", async () => {
  const emitted: RecordData[] = [];
  const deps = {
    emitRecord: (_stream: string, data: RecordData) => {
      emitted.push(data);
      return Promise.resolve();
    },
    emittedAt: "2026-08-21T00:00:00.000Z",
    progress: () => Promise.resolve(),
    requested: new Map([["reactions", { name: "reactions" }]]),
  } as Parameters<typeof emitMessagesPass>[0];

  const result = await emitMessagesPass(deps, [messageRow("C1", "1700000000.000100")], null);

  assert.deepEqual(
    result.channelMaxTs,
    {},
    "no messages record was emitted, so the messages cursor must not move past this row"
  );
  assert.equal(result.maxMessageTs, null);
});

// ─── 3. A void-returning emitRecord still counts as accepted ─────────────

test("an emitRecord that resolves void is treated as accepted", async () => {
  // Every non-scoping caller passes ctx.emitRecord straight through, which
  // resolves void. Those runs must keep advancing their cursor normally.
  const deps = {
    emitRecord: () => Promise.resolve(),
    emittedAt: "2026-08-21T00:00:00.000Z",
    progress: () => Promise.resolve(),
    requested: new Map([["messages", { name: "messages" }]]),
  } as Parameters<typeof emitMessagesPass>[0];

  const result = await emitMessagesPass(deps, [messageRow("C1", "1700000000.000100")], null);

  assert.equal(result.channelMaxTs.C1, "1700000000.000100");
  assert.equal(result.maxMessageTs, "1700000000.000100");
});

// ─── 4. The query-side half: no global floor for an unwalked channel ─────

interface Seed {
  channelId: string;
  ts: string;
}

function makeArchive(rows: readonly Seed[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE MESSAGE (
      CHANNEL_ID TEXT NOT NULL,
      TS TEXT NOT NULL,
      THREAD_TS TEXT,
      IS_PARENT INTEGER,
      TXT TEXT,
      NUM_FILES INTEGER,
      DATA BLOB,
      CHUNK_ID INTEGER NOT NULL
    );
  `);
  const stmt = db.prepare(
    "INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const r of rows) {
    stmt.run(r.channelId, r.ts, null, 0, "hi", 0, "hi", 1);
  }
  return db;
}

function selectRows(db: DatabaseSync, thresholds: Parameters<typeof buildMessageRowsQuery>[0]): string[] {
  const { sql, params } = buildMessageRowsQuery(thresholds);
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => `${String(row.CHANNEL_ID)}:${String(row.TS)}`)
    .sort();
}

test("a channel absent from channel_last_ts does not inherit the global floor", () => {
  // C_KNOWN has walked up to ...500. C_UNSEEN has never been walked, and
  // all of its history predates that floor. Under the old
  // `COALESCE(t.last_ts, legacy)` shape every C_UNSEEN row was suppressed
  // forever — the query never returns it, so no cursor is ever written for
  // it, so the same floor applies again on the next run.
  const db = makeArchive([
    { channelId: "C_KNOWN", ts: "1700000600.000000" },
    { channelId: "C_UNSEEN", ts: "1700000100.000000" },
    { channelId: "C_UNSEEN", ts: "1700000200.000000" },
  ]);
  try {
    const got = selectRows(db, {
      channelLastTs: { C_KNOWN: "1700000500.000000" },
      legacyLastTs: "1700000500.000000",
      sinceTs: null,
    });

    assert.deepEqual(
      got,
      ["C_KNOWN:1700000600.000000", "C_UNSEEN:1700000100.000000", "C_UNSEEN:1700000200.000000"],
      "the unwalked channel's full history is reachable; the known channel stays incremental"
    );
  } finally {
    db.close();
  }
});

test("a legacy cursor with NO per-channel map still floors every channel", () => {
  // The pre-migration shape: one workspace-wide cursor, no per-channel
  // rows. That floor was genuinely derived from a walk of everything, so it
  // legitimately applies to every channel. Dropping it here would re-emit
  // the entire archive on every run.
  const db = makeArchive([
    { channelId: "C_A", ts: "1700000100.000000" },
    { channelId: "C_B", ts: "1700000900.000000" },
  ]);
  try {
    const got = selectRows(db, {
      channelLastTs: {},
      legacyLastTs: "1700000500.000000",
      sinceTs: null,
    });

    assert.deepEqual(got, ["C_B:1700000900.000000"], "the legacy floor still applies when there is no channel map");
  } finally {
    db.close();
  }
});

test("collection_scope.since still composes with the per-channel predicate", () => {
  // A declared `since` boundary is a different kind of claim from a cursor
  // and must keep bounding an unwalked channel, which now has no cursor
  // floor of its own.
  const db = makeArchive([
    { channelId: "C_UNSEEN", ts: "1700000100.000000" },
    { channelId: "C_UNSEEN", ts: "1700000800.000000" },
  ]);
  try {
    const got = selectRows(db, {
      channelLastTs: { C_KNOWN: "1700000500.000000" },
      legacyLastTs: null,
      sinceTs: "1700000700.000000",
    });

    assert.deepEqual(got, ["C_UNSEEN:1700000800.000000"], "since bounds the unwalked channel even with no cursor");
  } finally {
    db.close();
  }
});
