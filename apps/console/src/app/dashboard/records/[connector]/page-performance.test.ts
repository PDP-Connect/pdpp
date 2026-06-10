import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

// The connection detail page resolves the connection + manifests first, then
// reads streams, recent runs, and diagnostics. Those three reads depend only on
// the connector/instance ids resolved in the first phase — never on each other.
// Awaiting them in series is a 3-deep request waterfall against the reference
// deployment; they must be raced.
const RACES_SECOND_PHASE = /const \[streams, runsResp, diagnostics\] = await Promise\.all\(\[\s*listStreams\(/;
const AWAITS_STREAMS_SERIALLY = /const streams = await listStreams\(/;
const AWAITS_RUNS_SERIALLY = /const runsResp = await listRuns\(/;
const AWAITS_DIAGNOSTICS_SERIALLY = /const diagnostics = await loadConnectorDiagnostics\(/;

function modelBody(src: string): string {
  const start = src.indexOf("async function loadConnectorPageModel");
  assert.ok(start >= 0, "loadConnectorPageModel must exist");
  const end = src.indexOf("async function loadConnectorDiagnostics", start);
  assert.ok(end > start, "loadConnectorDiagnostics must follow loadConnectorPageModel");
  return src.slice(start, end);
}

test("connection detail page races streams, runs, and diagnostics instead of awaiting them in series", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const body = modelBody(src);
  // The independent second-phase reads must be issued together.
  assert.match(body, RACES_SECOND_PHASE);
  // None of them may be re-serialized into its own `await` (a regression to the
  // waterfall shape).
  assert.doesNotMatch(body, AWAITS_STREAMS_SERIALLY);
  assert.doesNotMatch(body, AWAITS_RUNS_SERIALLY);
  assert.doesNotMatch(body, AWAITS_DIAGNOSTICS_SERIALLY);
});

test("the first phase (connection + manifests) still resolves before the second-phase reads that depend on it", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const body = modelBody(src);
  // The connector/instance ids the second phase consumes come from this
  // load-bearing first `Promise.all`; it must precede the second-phase race.
  const firstPhase = body.indexOf("await Promise.all([resolveConnectionForRecordsRoute");
  const secondPhase = body.indexOf("const [streams, runsResp, diagnostics] = await Promise.all([");
  assert.ok(firstPhase >= 0, "first phase must resolve the connection and manifests together");
  assert.ok(secondPhase >= 0, "second phase must race the dependent reads");
  assert.ok(
    firstPhase < secondPhase,
    "the connection/manifests phase must resolve before the streams/runs/diagnostics race that depends on its ids"
  );
});
