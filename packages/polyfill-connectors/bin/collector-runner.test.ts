// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildCollectorStartMessage, LocalDeviceOutbox } from "@pdpp/collector-runtime";
import {
  buildConnectorSpec,
  parseArgs,
  readOutboxStatus,
  recoverDeadLetters,
  scopedDefaultQueuePath,
} from "./collector-runner.ts";

async function tempOutboxPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-collector-runner-outbox-"));
  return join(dir, "outbox.sqlite");
}

/** Enqueue one record batch and dead-letter it (claim → deadLetter, the only valid transition). */
function seedOneDeadLetter(outboxPath: string, sourceInstanceId: string, error: string): void {
  const outbox = new LocalDeviceOutbox({ path: outboxPath });
  try {
    outbox.enqueue({ id: "item-1", kind: "record_batch", payload: { ok: true }, sourceInstanceId });
    const [claimed] = outbox.claimReady({ holder: "seed", leaseMs: 60_000, sourceInstanceId });
    assert.ok(claimed, "expected to claim the seeded item");
    outbox.deadLetter({ error, holder: "seed", id: claimed.id, leaseEpoch: claimed.lease_epoch });
  } finally {
    outbox.close();
  }
}

// These tests pin the START wire for stream backfill:
// CLI argv → parseArgs → buildConnectorSpec → buildCollectorStartMessage.
// They prove that `--backfill-streams attachments` reaches the connector
// subprocess as `START.streamsToBackfill`.
//
// The resumable operator loop now lives in `runCollectorConnector` and
// `LocalDeviceClient` (state GET/PUT) — see
// `src/collector-runner.test.ts` for the load/replay/persist regression.

test("CLI run --connector gmail uses bundled defaults so operators don't need --command/--args/--streams", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "gmail",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--source-instance-id",
    "src",
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, "gmail");
  assert.equal(spec.command, "tsx");
  assert.deepEqual(spec.args, ["connectors/gmail/index.ts"]);
  // Gmail streams must include attachments so the connector hydrates
  // new-UID attachments on every incremental run; backfill is opt-in.
  assert.ok(spec.streams.includes("attachments"));
  assert.ok(spec.streams.includes("messages"));
  // Network binding is required so the runtime gate refuses to run
  // Gmail in a profile that doesn't advertise network access.
  assert.equal(spec.runtime_requirements?.bindings?.network?.required, true);
  // No backfill requested unless --backfill-streams is passed.
  assert.equal(spec.streamsToBackfill, undefined);
});

test("CLI --backfill-streams reaches the connector as START.streamsToBackfill", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "gmail",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--source-instance-id",
    "src",
    "--backfill-streams",
    "attachments",
  ]);
  const spec = buildConnectorSpec(options);
  assert.deepEqual(spec.streamsToBackfill, ["attachments"]);

  // This is the wire the Gmail audit Finding 1 said was missing.
  // buildCollectorStartMessage is what runs against `child.stdin`
  // in collectConnectorMessages — emitting a START line that the
  // Gmail connector reads and routes into runAllMailPasses, which
  // honors streamsToBackfill to walk a bounded historical UID window.
  // The subprocess's STATE emit is persisted/replayed by future runs through
  // `runCollectorConnector` per OpenSpec
  // `design-local-collector-state-sync`.
  const start = buildCollectorStartMessage(spec.streams, spec.streamsToBackfill);
  assert.deepEqual(start.streamsToBackfill, ["attachments"]);
  assert.equal(start.type, "START");
});

test("CLI --resources reaches the connector as START scope resources", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "slack",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--source-instance-id",
    "src",
    "--streams",
    "messages,reactions",
    "--resources",
    "messages:C07JYF0U8BY|C016X99931T",
  ]);
  const spec = buildConnectorSpec(options);
  const start = buildCollectorStartMessage(spec.streams, spec.streamsToBackfill, null, spec.resources);

  assert.deepEqual(start.scope.streams, [
    { name: "messages", resources: ["C07JYF0U8BY", "C016X99931T"] },
    { name: "reactions" },
  ]);
});

test("CLI local-agent defaults request safe inventory and coverage streams", () => {
  const claude = buildConnectorSpec(
    parseArgs([
      "run",
      "--base-url",
      "http://127.0.0.1:7662",
      "--connector",
      "claude_code",
      "--device-id",
      "dev",
      "--device-token",
      "tok",
      "--source-instance-id",
      "src",
    ])
  );
  assert.deepEqual(
    claude.streams,
    [
      "sessions",
      "messages",
      "attachments",
      "memory_notes",
      "skills",
      "slash_commands",
      "file_history",
      "cache_inventory",
      "coverage_diagnostics",
      "backup_inventory",
      "config_inventory",
    ],
    "unscoped Claude Code runs should request all safe local completeness streams"
  );

  const codex = buildConnectorSpec(
    parseArgs([
      "run",
      "--base-url",
      "http://127.0.0.1:7662",
      "--connector",
      "codex",
      "--device-id",
      "dev",
      "--device-token",
      "tok",
      "--source-instance-id",
      "src",
    ])
  );
  assert.deepEqual(
    codex.streams,
    [
      "sessions",
      "messages",
      "function_calls",
      "rules",
      "prompts",
      "skills",
      "history",
      "session_index",
      "shell_snapshots",
      "config_inventory",
      "cache_inventory",
      "coverage_diagnostics",
    ],
    "unscoped Codex runs should request all safe local completeness streams"
  );
  assert(!claude.streams.includes("context_mode"), "Claude context_mode remains diagnostics-only");
  assert(!codex.streams.includes("context_mode"), "Codex context_mode remains diagnostics-only");
  assert(!codex.streams.includes("memories"), "Codex memories remain diagnostics-only");
});

test("CLI run --connector signal uses its own LocalCollectorDefinition streams, not a hand-maintained CLI table", () => {
  // Regression for the drift this fixes: `KNOWN_CONNECTOR_DEFAULTS` used to
  // be a hand-copied table that only listed codex/claude_code/gmail, so any
  // other registered local-collector connector (signal included) failed
  // with "run requires --streams" before spawn, even though its own
  // `LocalCollectorDefinition` (src/collector-registry.ts) already declares
  // a default stream set. Reproduced pre-fix; this pins the fix.
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "signal",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--source-instance-id",
    "src",
  ]);
  const spec = buildConnectorSpec(options);
  assert.equal(spec.connector_id, "signal");
  assert.equal(spec.command, "tsx");
  assert.deepEqual(spec.args, ["connectors/signal/index.ts"]);
  assert.deepEqual(spec.streams, ["messages", "conversations", "reactions", "attachments"]);
  assert.equal(spec.runtime_requirements?.bindings?.filesystem?.required, true);
});

test("CLI --backfill-streams supports comma-separated lists (forward compatibility for additional historical streams)", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "gmail",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--source-instance-id",
    "src",
    "--backfill-streams",
    "attachments, message_bodies",
  ]);
  const spec = buildConnectorSpec(options);
  assert.deepEqual(spec.streamsToBackfill, ["attachments", "message_bodies"]);
});

test("CLI run without --connector defaults still rejects unknown connectors that have no streams supplied", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "unknown_connector_id",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--source-instance-id",
    "src",
  ]);
  assert.throws(() => buildConnectorSpec(options), /requires --streams/);
});

test("CLI prefers connection id alias while preserving source-instance compatibility", () => {
  const options = parseArgs([
    "run",
    "--base-url",
    "http://127.0.0.1:7662",
    "--connector",
    "codex",
    "--device-id",
    "dev",
    "--device-token",
    "tok",
    "--connection-id",
    "conn-1",
  ]);

  assert.equal(options.sourceInstanceId, "conn-1");
});

test("default collector queue path is scoped by connection id", () => {
  assert.equal(
    scopedDefaultQueuePath("/tmp/collector-runner-queue.json", "/tmp/collector-runner-queue.json", "conn/a b"),
    "/tmp/collector-runner-queue.conn_2Fa_20b.json"
  );
  assert.equal(
    scopedDefaultQueuePath("/tmp/custom.json", "/tmp/collector-runner-queue.json", "conn/a b"),
    "/tmp/custom.json"
  );
});

// ─── status / recover: bounded, read-only outbox inspection and dead-letter
// recovery (no network call, no connector spawn). These pin the honest
// distinction "the collector stopped" (a genuinely empty/idle outbox) from
// "the source is stuck" (a dead-lettered record blocking the outbox), the
// same distinction `docs/operator/local-collector-runbook.md`'s
// `lifecycle_state` table documents for the published local collector.

test("status: an idle outbox with no work reports healthy_idle and zero dead letters", async () => {
  const outboxPath = await tempOutboxPath();
  const report = readOutboxStatus(outboxPath, "conn-1");
  assert.equal(report.lifecycleState, "healthy_idle");
  assert.equal(report.summary.total, 0);
  assert.equal(report.deadLetterErrors.dead_letter_count, 0);
});

test("status: a dead-lettered record reports dead_letter lifecycle and names the error class", async () => {
  const outboxPath = await tempOutboxPath();
  seedOneDeadLetter(outboxPath, "conn-1", "boom: mime_type must be a valid media type");
  const report = readOutboxStatus(outboxPath, "conn-1");
  assert.equal(report.lifecycleState, "dead_letter");
  assert.equal(report.summary.deadLetter, 1);
  assert.equal(report.deadLetterErrors.dead_letter_count, 1);
  assert.equal(report.deadLetterErrors.top_classes[0]?.count, 1);
});

test("status: dead-lettered work in another connection's outbox lane does not appear (source-instance scoping)", async () => {
  const outboxPath = await tempOutboxPath();
  seedOneDeadLetter(outboxPath, "conn-other", "boom");
  const report = readOutboxStatus(outboxPath, "conn-1");
  assert.equal(report.lifecycleState, "healthy_idle");
  assert.equal(report.summary.total, 0);
});

test("recover: preview (no --apply) reports the match count but does not requeue", async () => {
  const outboxPath = await tempOutboxPath();
  seedOneDeadLetter(outboxPath, "conn-1", "boom");
  const preview = recoverDeadLetters(outboxPath, "conn-1", false);
  assert.equal(preview.applied, false);
  assert.equal(preview.matched, 1);
  assert.equal(preview.requeued, 0);
  // A preview must not have mutated the outbox — status still shows the dead letter.
  const status = readOutboxStatus(outboxPath, "conn-1");
  assert.equal(status.summary.deadLetter, 1);
});

test("recover: --apply requeues the dead letter so the next run can retry it", async () => {
  const outboxPath = await tempOutboxPath();
  seedOneDeadLetter(outboxPath, "conn-1", "boom");
  const applied = recoverDeadLetters(outboxPath, "conn-1", true);
  assert.equal(applied.applied, true);
  assert.equal(applied.matched, 1);
  assert.equal(applied.requeued, 1);
  const status = readOutboxStatus(outboxPath, "conn-1");
  assert.equal(status.summary.deadLetter, 0);
  assert.equal(status.summary.ready, 1);
  assert.equal(status.lifecycleState, "draining");
});

test("CLI status/recover subcommands parse --connection-id and --apply", () => {
  const status = parseArgs(["status", "--connection-id", "conn-1"]);
  assert.equal(status.command, "status");
  assert.equal(status.sourceInstanceId, "conn-1");
  assert.equal(status.apply, undefined);

  const recoverPreview = parseArgs(["recover", "--connection-id", "conn-1"]);
  assert.equal(recoverPreview.command, "recover");
  assert.equal(recoverPreview.apply, undefined);

  const recoverApply = parseArgs(["recover", "--connection-id", "conn-1", "--apply"]);
  assert.equal(recoverApply.command, "recover");
  assert.equal(recoverApply.apply, true);
});
