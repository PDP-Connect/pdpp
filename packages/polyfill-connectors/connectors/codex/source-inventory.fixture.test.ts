import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

/**
 * Source-inventory fixture coverage for the Codex CLI local collector
 * (complete-local-agent-collectors tasks 1.2 + 2.2).
 *
 * Runs the real connector against the committed, fully-synthetic source homes
 * under `fixtures/codex/source-home/`. Pins the classification contract
 * against durable fixtures covering every store class: declared/collected
 * streams, inventory-only stores, the deferred `logs` store, an excluded
 * auth-adjacent file, diagnostics-only private stores (`memories`,
 * `context_mode`), an undeclared "unknown" store, and a second device home.
 *
 * The risky-store fixtures (logs, shell-snapshots, cache, config, history,
 * session_index, auth, memories, context-mode) embed obvious synthetic
 * sentinels of the form `FIXTURE_FAKE_*_DO_NOT_COLLECT`. The
 * redaction/negative tests assert those sentinels never appear in any emitted
 * RECORD or STATE — proving risky log/shell/config payloads stay
 * inventory-only, deferred, or excluded rather than being collected.
 */

const FIXTURE_ROOT = join(import.meta.dirname, "../../fixtures/codex/source-home");
const DEVICE_A_HOME = join(FIXTURE_ROOT, "deviceA/codex-home");
const DEVICE_B_HOME = join(FIXTURE_ROOT, "deviceB/codex-home");

const SECRET_SENTINELS = [
  "FIXTURE_FAKE_HISTORY_PROMPT_DO_NOT_COLLECT",
  "FIXTURE_FAKE_SESSION_INDEX_PAYLOAD_DO_NOT_COLLECT",
  "FIXTURE_FAKE_SHELL_EXPORT_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_SHELL_BEARER_DO_NOT_COLLECT",
  "FIXTURE_FAKE_LOG_BEARER_DO_NOT_COLLECT",
  "FIXTURE_FAKE_LOG_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_CACHE_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_CONFIG_SECRET_DO_NOT_COLLECT",
  "FIXTURE_FAKE_MEMORY_PRIVATE_DO_NOT_COLLECT",
  "FIXTURE_FAKE_CONTEXT_MODE_PRIVATE_DO_NOT_COLLECT",
  "FIXTURE_FAKE_AUTH_TOKEN_DO_NOT_COLLECT",
  "FIXTURE_FAKE_ACCOUNT_ID_DO_NOT_COLLECT",
  "FIXTURE_FAKE_UNKNOWN_STORE_PAYLOAD_DO_NOT_COLLECT",
];

const ALL_LOCAL_STREAMS = [
  { name: "rules" },
  { name: "prompts" },
  { name: "skills" },
  { name: "history" },
  { name: "session_index" },
  { name: "shell_snapshots" },
  { name: "cache_inventory" },
  { name: "config_inventory" },
  { name: "logs" },
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

test("codex fixture home: coverage diagnostics classify every known store", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  assert.equal(result.exitCode, 0);
  const recs = records(result.messages);

  // Declared/collected stores.
  for (const store of ["rules", "prompts", "skills"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "collected", `${store} should be collected`);
  }
  // Inventory-only stores.
  for (const store of ["history", "session_index", "shell_snapshots", "cache", "config"]) {
    assert.equal(coverageFor(recs, store)?.data.status, "inventory_only", `${store} should be inventory_only`);
  }
  // Deferred store (no payload emission; metadata only).
  assert.equal(coverageFor(recs, "logs")?.data.status, "deferred", "logs should be deferred");

  // Diagnostics-only private stores and excluded auth-adjacent store.
  for (const store of ["memories", "context_mode"]) {
    const cov = coverageFor(recs, store);
    assert.equal(cov?.data.status, "inventory_only", `${store} should be diagnostics-only inventory_only`);
    assert.equal(cov?.data.stream, null, `${store} must not map to a requestable stream`);
  }
  const auth = coverageFor(recs, "auth");
  assert.equal(auth?.data.status, "excluded");
  assert.equal(auth?.data.stream, null);
});

test("codex fixture home: risky-store secret sentinels are never emitted", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  assert.equal(result.exitCode, 0);

  const serialized = JSON.stringify(result.messages);
  for (const sentinel of SECRET_SENTINELS) {
    assert(!serialized.includes(sentinel), `sentinel leaked into connector output: ${sentinel}`);
  }
});

test("codex fixture home: inventory-only stores emit metadata without payload", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  const recs = records(result.messages);

  // history / session_index emit a metadata record for the file, not its body.
  for (const [stream, rel] of [
    ["history", "history.jsonl"],
    ["session_index", "session_index.jsonl"],
  ] as const) {
    const rec = recs.find((r) => r.stream === stream && r.data.relative_path === rel);
    assert(rec, `${stream} should inventory ${rel}`);
    assert.equal(rec.data.classification, "inventory_only");
    assert(!("content" in rec.data), `${stream} inventory record must not carry payload`);
  }

  // shell_snapshots emits per-file metadata (dir listing) but not the script body.
  assert(
    recs.some((r) => r.stream === "shell_snapshots" && r.data.relative_path === "shell-snapshots/snapshot-1.sh"),
    "shell_snapshots should inventory the snapshot file"
  );
});

test("codex fixture home: deferred logs store emits metadata but no log payload", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  const recs = records(result.messages);

  const logRec = recs.find((r) => r.stream === "logs");
  if (logRec) {
    assert.equal(logRec.data.classification, "defer", "logs record must be classified defer");
    assert(!("content" in logRec.data), "logs must not carry payload content");
  }
});

test("codex fixture home: undeclared 'unknown' store is never collected", async () => {
  const result = await runFixtureConnector({ home: DEVICE_A_HOME, streams: ALL_LOCAL_STREAMS });
  const recs = records(result.messages);

  assert(
    !recs.some((r) => JSON.stringify(r.data).includes("unknown-future-store")),
    "an undeclared store must not appear in any emitted record"
  );
});

test("codex fixture homes: two device homes inventory independently", async () => {
  const a = await runFixtureConnector({ home: DEVICE_A_HOME, streams: [{ name: "prompts" }] });
  const b = await runFixtureConnector({ home: DEVICE_B_HOME, streams: [{ name: "prompts" }] });
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);

  const aPrompts = records(a.messages).filter((r) => r.stream === "prompts");
  const bPrompts = records(b.messages).filter((r) => r.stream === "prompts");
  assert(aPrompts.length > 0 && bPrompts.length > 0);

  assert(JSON.stringify(bPrompts).includes("Device B"), "device B prompt should reflect device B content");
  assert(!JSON.stringify(aPrompts).includes("Device B"), "device A must not see device B content");
});

async function runFixtureConnector(input: {
  home: string;
  streams: Array<{ name: string }>;
}): Promise<{ exitCode: number | null; messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    allowFailedDone: true,
    cwd: join(import.meta.dirname, "../.."),
    entrypoint: "connectors/codex/index.ts",
    env: { CODEX_HOME: input.home },
    start: { scope: { streams: input.streams }, type: "START" },
  });
  return { exitCode: result.code, messages: result.messages };
}
