// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Source-inventory fixture coverage for the Claude Code local collector
 * (complete-local-agent-collectors tasks 1.2 + 2.2).
 *
 * These tests run the real connector against the committed, fully-synthetic
 * source homes under `fixtures/claude_code/source-home/`. Unlike the
 * `source-preflight.test.ts` suite (which builds ad-hoc temp homes), this
 * suite pins the classification contract against durable fixtures that cover
 * every store class: declared/collected streams, inventory-only stores,
 * deferred stores, an excluded auth-adjacent file, a diagnostics-only private
 * store, an undeclared "unknown" store, and a second device source home.
 *
 * The risky-store fixtures (cache, backups, debug, downloads, config,
 * file-history, auth, context-mode) all embed obvious synthetic sentinel
 * strings of the form `FIXTURE_FAKE_*_DO_NOT_COLLECT`. The redaction/negative
 * tests assert those sentinels never appear in any emitted RECORD or STATE —
 * proving risky log/debug/config payloads stay inventory-only or excluded.
 */

const FIXTURE_ROOT = join(import.meta.dirname, "../../fixtures/claude_code/source-home");
const DEVICE_A_HOME = join(FIXTURE_ROOT, "deviceA/claude-home");
const DEVICE_B_HOME = join(FIXTURE_ROOT, "deviceB/claude-home");

/**
 * Every synthetic secret/payload sentinel planted in the risky-store
 * fixtures. None of these may appear in connector output.
 */
const SECRET_SENTINELS = [
  "FIXTURE_FAKE_FILE_HISTORY_PAYLOAD_DO_NOT_COLLECT",
  "FIXTURE_FAKE_CACHE_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_BACKUP_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_DEBUG_BEARER_DO_NOT_COLLECT",
  "FIXTURE_FAKE_DEBUG_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_DOWNLOAD_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_CONFIG_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_CONTEXT_MODE_PRIVATE_DO_NOT_COLLECT",
  "FIXTURE_FAKE_AUTH_TOKEN_DO_NOT_COLLECT",
  "FIXTURE_FAKE_INSTALL_ID_DO_NOT_COLLECT",
  "FIXTURE_FAKE_UNKNOWN_STORE_PAYLOAD_DO_NOT_COLLECT",
];

const ALL_LOCAL_STREAMS = [
  { name: "skills" },
  { name: "slash_commands" },
  { name: "memory_notes" },
  { name: "file_history" },
  { name: "cache_inventory" },
  { name: "backup_inventory" },
  { name: "config_inventory" },
  { name: "debug_artifacts" },
  { name: "downloads" },
  { name: "coverage_diagnostics" },
];

function records(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "RECORD" }>[] {
  return messages.filter((msg): msg is Extract<EmittedMessage, { type: "RECORD" }> => msg.type === "RECORD");
}

function coverageFor(
  recs: Extract<EmittedMessage, { type: "RECORD" }>[],
  store: string
): Extract<EmittedMessage, { type: "RECORD" }> | undefined {
  return recs.find((r) => r.stream === "coverage_diagnostics" && r.data.store === store);
}

test("claude_code fixture home: coverage diagnostics classify every known store", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  assert.equal(result.exitCode, 0);
  const recs = records(result.messages);

  // Declared/collected stores.
  for (const store of ["projects", "skills", "commands"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "collected", `${store} should be collected`);
  }
  // Inventory-only stores.
  for (const store of ["file_history", "cache", "backups", "config"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "inventory_only", `${store} should be inventory_only`);
  }
  // Deferred stores (no payload emission; metadata only).
  for (const store of ["debug", "downloads"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "deferred", `${store} should be deferred`);
  }
  // Diagnostics-only private store and excluded auth-adjacent store.
  const contextMode = coverageFor(recs, "context_mode");
  assert.equal(contextMode?.data.status, "inventory_only");
  assert.equal(contextMode?.data.stream, null, "context_mode must not map to a requestable stream");
  const auth = coverageFor(recs, "auth");
  assert.equal(auth?.data.status, "excluded");
  assert.equal(auth?.data.stream, null);
});

test("claude_code fixture home: risky-store secret sentinels are never emitted", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  assert.equal(result.exitCode, 0);

  // Scan the ENTIRE message stream (RECORD, STATE, PROGRESS, DONE) — no
  // sentinel from any cache/backup/debug/download/config/auth/context-mode
  // fixture may surface anywhere.
  const serialized = JSON.stringify(result.messages);
  for (const sentinel of SECRET_SENTINELS) {
    assert(!serialized.includes(sentinel), `sentinel leaked into connector output: ${sentinel}`);
  }
});

test("claude_code fixture home: inventory-only stores emit metadata without payload", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  const recs = records(result.messages);

  // cache_inventory emits the directory as a metadata record with a path
  // hash, size, mtime, and reason — but no file payload.
  const cacheRec = recs.find((r) => r.stream === "cache_inventory" && r.data.relative_path === "cache");
  assert(cacheRec, "cache_inventory should emit a metadata record for the cache dir");
  assert.equal(cacheRec.data.classification, "inventory_only");
  assert.equal(typeof cacheRec.data.path_hash, "string");
  assert(!("content" in cacheRec.data), "inventory records must not carry payload content");

  // file_history emits per-file metadata (dir listing) but not the snapshot body.
  assert(
    recs.some((r) => r.stream === "file_history" && r.data.relative_path === "file-history/snapshot.json"),
    "file_history should inventory the snapshot file"
  );
});

test("claude_code fixture home: deferred stores emit metadata but no payload content", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  const recs = records(result.messages);

  // debug_artifacts / downloads are classified `defer`: a metadata inventory
  // record is allowed, but the log/debug/download payload must never appear.
  for (const stream of ["debug_artifacts", "downloads"]) {
    const rec = recs.find((r) => r.stream === stream);
    if (rec) {
      assert.equal(rec.data.classification, "defer", `${stream} record must be classified defer`);
      assert(!("content" in rec.data), `${stream} must not carry payload content`);
    }
  }
});

test("claude_code fixture home: undeclared 'unknown' store is never collected", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  const recs = records(result.messages);

  assert(
    !recs.some((r) => JSON.stringify(r.data).includes("unknown-future-store")),
    "an undeclared store must not appear in any emitted record"
  );
});

function statesFor(messages: EmittedMessage[], stream: string): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (msg): msg is Extract<EmittedMessage, { type: "STATE" }> => msg.type === "STATE" && msg.stream === stream
  );
}

test("claude_code inventory: unchanged store does not re-version across runs", async () => {
  // Run 1: no prior state — the inventory record emits and STATE carries a
  // fingerprint for the store.
  const run1 = await runFixtureConnector({ home: DEVICE_A_HOME, streams: [{ name: "backup_inventory" }] });
  assert.equal(run1.exitCode, 0);
  const run1Records = records(run1.messages).filter((r) => r.stream === "backup_inventory");
  assert(run1Records.length > 0, "first run emits the backup_inventory record");

  const run1States = statesFor(run1.messages, "backup_inventory");
  assert(run1States.length > 0, "first run writes a backup_inventory STATE");
  const cursor = run1States.at(-1)?.cursor as { fingerprints?: Record<string, string> } | undefined;
  assert(cursor?.fingerprints && Object.keys(cursor.fingerprints).length > 0, "STATE carries inventory fingerprints");

  // Run 2: feed run 1's STATE back in. The fixture is byte-identical, so the
  // gate must suppress the re-emit — this is the no-op churn the gate exists
  // to stop. (mtime stability is the same direction as a real mtime tick: the
  // gate excludes mtime/size, so it would suppress either way.)
  const run2 = await runFixtureConnector({
    home: DEVICE_A_HOME,
    state: { backup_inventory: cursor },
    streams: [{ name: "backup_inventory" }],
  });
  assert.equal(run2.exitCode, 0);
  const run2Records = records(run2.messages).filter((r) => r.stream === "backup_inventory");
  assert.equal(run2Records.length, 0, "unchanged inventory store does not re-emit on the second run");

  // STATE is still written so the cursor survives forward.
  const run2States = statesFor(run2.messages, "backup_inventory");
  assert(run2States.length > 0, "second run still writes the carry-forward STATE");
});

test("claude_code fixture homes: two device homes inventory independently", async () => {
  const a = await runFixtureConnector({ home: DEVICE_A_HOME, streams: [{ name: "skills" }] });
  const b = await runFixtureConnector({ home: DEVICE_B_HOME, streams: [{ name: "skills" }] });
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);

  const aSkills = records(a.messages).filter((r) => r.stream === "skills");
  const bSkills = records(b.messages).filter((r) => r.stream === "skills");
  assert(aSkills.length > 0 && bSkills.length > 0);

  // Device B's skill body is distinct; device A's output must not contain it
  // and vice versa — the homes do not bleed into each other.
  assert(JSON.stringify(bSkills).includes("Device B"), "device B skill should reflect device B content");
  assert(!JSON.stringify(aSkills).includes("Device B"), "device A must not see device B content");
});

async function runFixtureConnector(input: {
  home: string;
  state?: Record<string, unknown>;
  streams: Array<{ name: string }>;
}): Promise<{ exitCode: number | null; messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/claude_code/index.ts",
    env: {
      CLAUDE_CODE_HOME: input.home,
      CLAUDE_CODE_PROJECTS_DIR: join(input.home, "projects"),
    },
    start: {
      scope: { streams: input.streams },
      ...(input.state ? { state: input.state } : {}),
      type: "START",
    },
  });
  return { exitCode: result.code, messages: result.messages };
}
