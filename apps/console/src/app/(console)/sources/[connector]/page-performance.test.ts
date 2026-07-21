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
const RACES_SECOND_PHASE =
  /const \[diagnostics, providerOrigin\] = await Promise\.all\(\[\s*loadConnectorDiagnostics\(/;
const CALLS_LIST_STREAMS = /listStreams\(/;
const AWAITS_DIAGNOSTICS_SERIALLY = /const diagnostics = await loadConnectorDiagnostics\(/;

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
});

test("the first phase (connection + manifests) still resolves before the second-phase reads that depend on it", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const body = modelBody(src);
  // The connector/instance ids the second phase consumes come from this
  // load-bearing first `Promise.all`; it must precede the second-phase race.
  const firstPhase = body.indexOf("await Promise.all([resolveConnectionForRecordsRoute");
  const streamProjection = body.indexOf("const streams = streamsFromConnectorSummary(summary)");
  const secondPhase = body.indexOf("const [diagnostics, providerOrigin] = await Promise.all([");
  assert.ok(firstPhase >= 0, "first phase must resolve the connection and manifests together");
  assert.ok(streamProjection >= 0, "stream rows must derive from the scoped summary before diagnostics render");
  assert.ok(secondPhase >= 0, "second phase must race the remaining dependent reads");
  assert.ok(
    firstPhase < streamProjection && streamProjection < secondPhase,
    "the connection/manifests phase must resolve before stream projection and the diagnostics/provider-origin race"
  );
});
