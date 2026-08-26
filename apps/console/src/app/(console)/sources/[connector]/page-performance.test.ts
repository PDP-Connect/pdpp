// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

// The connection detail page resolves the connection + manifests first, then
// derives stream rows from the connection-scoped summary read-model and races
// only the remaining diagnostics/provider-origin reads. It must not call
// `/v1/streams`: for high-volume local sources that endpoint re-aggregates
// current records and blocks first paint for seconds.
const DERIVES_STREAMS_FROM_SUMMARY = /const streams = streamsFromConnectorSummary\(summary\)/;
// The destructured list is open-ended: additional independent second-phase
// reads (e.g. the connection configuration ledger) may join this race, but
// `loadConnectorDiagnostics` must remain its FIRST element so no read is
// promoted ahead of it into a serial await.
const RACES_SECOND_PHASE =
  /const \[diagnostics, providerOrigin(?:, \w+)*\] = await Promise\.all\(\[\s*loadConnectorDiagnostics\(/;
/** The same destructuring, without pinning the first element, for offset math. */
const CALLS_LIST_STREAMS = /listStreams\(/;
const AWAITS_DIAGNOSTICS_SERIALLY = /const diagnostics = await loadConnectorDiagnostics\(/;
// Configuration is an owner-visible panel, not a gate on first paint: its two
// reads must ride the existing race rather than block the page ahead of it.
const SECOND_PHASE_START_RE = /const \[diagnostics, providerOrigin(?:, \w+)*\] = await Promise\.all\(\[/;
const AWAITS_CONFIG_SERIALLY = /const configuration = await getConnectionConfig\(/;
const AWAITS_CONFIG_REVISIONS_SERIALLY = /const configRevisions = await listConnectionConfigRevisions\(/;
const DECLARED_STREAMS = /for \(const name of summary\.streams\)/;
const RETAINED_STREAMS = /for \(const record of summary\.stream_records \?\? \[\]\)/;
const COLLECTION_FACT_STREAMS = /for \(const entry of summary\.collection_report \?\? \[\]\)/;
const VERDICT_STREAMS = /for \(const entry of summary\.rendered_verdict\?\.streams \?\? \[\]\)/;
const GAP_STREAMS = /pushGapStreams\(summary\.last_run\?\.known_gaps\)/;

function modelBody(src: string): string {
  const start = src.indexOf("async function loadConnectorPageModel");
  assert.ok(start >= 0, "loadConnectorPageModel must exist");
  const end = src.indexOf("async function loadConnectorDiagnostics", start);
  assert.ok(end > start, "loadConnectorDiagnostics must follow loadConnectorPageModel");
  return src.slice(start, end);
}

test("connection detail page uses the scoped summary read-model instead of re-fetching streams", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const body = modelBody(src);
  assert.match(body, DERIVES_STREAMS_FROM_SUMMARY);
  // The remaining independent second-phase reads must still be issued together.
  assert.match(body, RACES_SECOND_PHASE);
  // Do not regress to the expensive `/v1/streams` aggregation path.
  assert.doesNotMatch(src, CALLS_LIST_STREAMS);
  assert.doesNotMatch(body, AWAITS_DIAGNOSTICS_SERIALLY);
  // A configuration read must never become a serial await ahead of the race.
  assert.doesNotMatch(body, AWAITS_CONFIG_SERIALLY);
  assert.doesNotMatch(body, AWAITS_CONFIG_REVISIONS_SERIALLY);
});

test("the first phase (connection + manifests) still resolves before the second-phase reads that depend on it", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const body = modelBody(src);
  // The connector/instance ids the second phase consumes come from this
  // load-bearing first `Promise.all`; it must precede the second-phase race.
  const firstPhase = body.indexOf("await Promise.all([\n    resolveConnectionForRecordsRoute");
  const streamProjection = body.indexOf("const streams = streamsFromConnectorSummary(summary)");
  const secondPhase = body.search(SECOND_PHASE_START_RE);
  assert.ok(firstPhase >= 0, "first phase must resolve the connection and manifests together");
  assert.ok(streamProjection >= 0, "stream rows must derive from the scoped summary before diagnostics render");
  assert.ok(secondPhase >= 0, "second phase must race the remaining dependent reads");
  assert.ok(
    firstPhase < streamProjection && streamProjection < secondPhase,
    "the connection/manifests phase must resolve before stream projection and the diagnostics/provider-origin race"
  );
});

test("connection detail unions every server stream evidence source", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, DECLARED_STREAMS);
  assert.match(src, RETAINED_STREAMS);
  assert.match(src, COLLECTION_FACT_STREAMS);
  assert.match(src, VERDICT_STREAMS);
  assert.match(src, GAP_STREAMS);
});
