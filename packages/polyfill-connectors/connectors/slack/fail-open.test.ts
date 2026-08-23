// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite enumeration failures are not empty inventories. These tests exercise
 * the production stream orchestration against real in-memory SQLite errors and
 * verify the three durable consequences of a failed read:
 * no positive coverage declaration, no fingerprint pruning, and no STATE.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import {
  emitStateCheckpoints,
  FINGERPRINT_EXCLUDE,
  pruneRequestedFingerprintCursors,
  runRequestedStreams,
  type StreamDeps,
} from "./index.ts";

const FAILED_STREAMS = ["workspace", "channel_memberships", "users", "files", "canvases"] as const;

function requested(stream: string): Map<string, StreamScope> {
  return new Map([[stream, { name: stream }]]);
}

function seededCursor(stream: string): FingerprintCursor {
  return openFingerprintCursor(
    { fingerprints: { stale_id: "prior-fingerprint" } },
    { excludeFromFingerprint: FINGERPRINT_EXCLUDE[stream as keyof typeof FINGERPRINT_EXCLUDE] }
  );
}

function makeDeps(
  db: DatabaseSync,
  stream: string,
  messages: EmittedMessage[],
  fingerprintCursors: Map<string, FingerprintCursor>
): StreamDeps {
  return {
    db,
    emit: (message) => {
      messages.push(message);
      return Promise.resolve();
    },
    emitRecord: () => Promise.resolve(),
    emittedAt: "2026-08-23T12:00:00.000Z",
    failedStreams: new Set(),
    fingerprintCursors,
    progress: () => Promise.resolve(),
    requested: requested(stream),
  };
}

async function runStream(stream: string, db: DatabaseSync): Promise<{ deps: StreamDeps; messages: EmittedMessage[] }> {
  const messages: EmittedMessage[] = [];
  const cursors = new Map([[stream, seededCursor(stream)]]);
  const deps = makeDeps(db, stream, messages, cursors);
  const emit = (message: EmittedMessage): Promise<void> => {
    messages.push(message);
    return Promise.resolve();
  };
  await runRequestedStreams(deps, {}, {} as Parameters<typeof runRequestedStreams>[2], emit);
  return { deps, messages };
}

function emitStateFor(
  deps: StreamDeps,
  messages: EmittedMessage[],
  stream: string
): void {
  emitStateCheckpoints({
    archivePath: "/tmp/slack-test-archive",
    baseArchiveResumedAt: {},
    channelLastTs: {},
    committedMaxTs: null,
    emit: (message) => {
      messages.push(message);
      return Promise.resolve();
    },
    failedStreams: deps.failedStreams,
    fingerprintCursors: deps.fingerprintCursors,
    observedChannelIds: [],
    requested: requested(stream),
    scopedArchiveResumedAt: {},
  });
}

for (const stream of FAILED_STREAMS) {
  test(`failed SQLite enumeration: ${stream} stays retryable and uncheckpointed`, async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const { deps, messages } = await runStream(stream, db);

      assert.deepEqual(
        messages.filter((message) => message.type === "DETAIL_COVERAGE"),
        [],
        "a failed read must not declare 0/0 coverage"
      );
      const gap = messages.find((message) => message.type === "DETAIL_GAP");
      assert.equal(gap?.stream, stream);
      assert.equal(gap?.reason, "temporary_unavailable");
      assert.equal(gap?.retryable, true);
      assert.equal(deps.failedStreams.has(stream), true);

      pruneRequestedFingerprintCursors(deps.requested, deps.failedStreams, deps.fingerprintCursors);
      assert.equal(deps.fingerprintCursors.get(stream)?.toState().stale_id, "prior-fingerprint");

      emitStateFor(deps, messages, stream);
      assert.equal(
        messages.some((message) => message.type === "STATE" && message.stream === stream),
        false,
        "a failed stream must not receive a STATE checkpoint"
      );
    } finally {
      db.close();
    }
  });
}

function healthyDb(stream: (typeof FAILED_STREAMS)[number]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  if (stream === "workspace") {
    db.exec("CREATE TABLE WORKSPACE (ID TEXT, TEAM TEXT, TEAM_ID TEXT, USERNAME TEXT, USER_ID TEXT, URL TEXT, ENTERPRISE_ID TEXT, DATA TEXT)");
    db.prepare("INSERT INTO WORKSPACE VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "T1",
      "Acme",
      "T1",
      "alice",
      "U1",
      "https://acme.slack.com",
      null,
      JSON.stringify({ name: "Acme" })
    );
  } else if (stream === "channel_memberships") {
    db.exec("CREATE TABLE CHANNEL_USER (CHANNEL_ID TEXT, USER_ID TEXT)");
    db.prepare("INSERT INTO CHANNEL_USER VALUES (?, ?)").run("C1", "U1");
  } else if (stream === "users") {
    db.exec("CREATE TABLE S_USER (ID TEXT, USERNAME TEXT, DATA TEXT, CHUNK_ID INTEGER)");
    db.prepare("INSERT INTO S_USER VALUES (?, ?, ?, ?)").run("U1", "alice", JSON.stringify({ name: "Alice" }), 1);
  } else if (stream === "files") {
    db.exec("CREATE TABLE FILE (ID TEXT, FILENAME TEXT, URL TEXT, MODE TEXT, DATA TEXT, CHUNK_ID INTEGER)");
    db.prepare("INSERT INTO FILE VALUES (?, ?, ?, ?, ?, ?)").run(
      "F1",
      "note.txt",
      "https://files.slack.com/F1",
      "hosted",
      JSON.stringify({ created: 1_700_000_000, filetype: "text", mimetype: "text/plain" }),
      1
    );
  } else {
    db.exec("CREATE TABLE FILE (ID TEXT, FILENAME TEXT, URL TEXT, MODE TEXT, CHANNEL_ID TEXT, MESSAGE_ID INTEGER, DATA TEXT, CHUNK_ID INTEGER)");
    db.exec("CREATE TABLE CHANNEL (ID TEXT, DATA TEXT, CHUNK_ID INTEGER)");
    db.prepare("INSERT INTO FILE VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "F1",
      "canvas",
      "https://files.slack.com/F1",
      "quip",
      "C1",
      null,
      JSON.stringify({ title: "Canvas", filetype: "quip", mimetype: "application/vnd.slack-docs" }),
      1
    );
    db.prepare("INSERT INTO CHANNEL VALUES (?, ?, ?)").run("C1", JSON.stringify({}), 1);
  }
  return db;
}

test("healthy SQLite enumerations still declare complete coverage for all five streams", async () => {
  for (const stream of FAILED_STREAMS) {
    const db = healthyDb(stream);
    try {
      const { deps, messages } = await runStream(stream, db);
      assert.equal(deps.failedStreams.size, 0, `${stream} healthy run must not be marked failed`);
      const coverage = messages.find((message) => message.type === "DETAIL_COVERAGE" && message.stream === stream);
      assert.equal(coverage?.considered, 1, `${stream} healthy run must enumerate one item`);
      assert.equal(coverage?.covered, 1, `${stream} healthy run must cover the enumerated item`);
    } finally {
      db.close();
    }
  }
});
