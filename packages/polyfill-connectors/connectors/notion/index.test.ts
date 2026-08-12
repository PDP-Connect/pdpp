import assert from "node:assert/strict";
import test from "node:test";

import { buildFullScanCoverageMessage } from "../../src/connector-runtime.ts";

test("Notion full-scan coverage records the enumerated boundary, including empty", () => {
  assert.deepEqual(buildFullScanCoverageMessage("pages", 0), {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    stream: "pages",
    state_stream: "pages",
    required_keys: [],
    hydrated_keys: [],
    considered: 0,
    covered: 0,
  });
  assert.deepEqual(buildFullScanCoverageMessage("databases", 162), {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    stream: "databases",
    state_stream: "databases",
    required_keys: [],
    hydrated_keys: [],
    considered: 162,
    covered: 162,
  });
});
