import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCollectorStartMessage } from "../src/collector-runner.ts";
import { buildConnectorSpec, parseArgs } from "./collector-runner.ts";

// These tests pin the operator path for stream backfill end-to-end:
// CLI argv → parseArgs → buildConnectorSpec → buildCollectorStartMessage.
// They are the proof that `--backfill-streams attachments` actually
// reaches the connector subprocess as `START.streamsToBackfill`.

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

test("CLI --backfill-streams reaches the connector as START.streamsToBackfill (operator path for historical attachment backfill)", () => {
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
  const start = buildCollectorStartMessage(spec.streams, spec.streamsToBackfill);
  assert.deepEqual(start.streamsToBackfill, ["attachments"]);
  assert.equal(start.type, "START");
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
