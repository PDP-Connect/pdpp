// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateStreamCoherence,
  isCheckpointOnlyClaim,
  type StreamEvidenceEnvelope,
  type StreamProofDeclaration,
} from "../src/evidence/index.ts";

function envelope(overrides: Partial<StreamEvidenceEnvelope> = {}): StreamEvidenceEnvelope {
  return {
    checkpoint: "committed",
    collected: 0,
    considered: null,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    ...overrides,
  };
}

const FULL_INVENTORY: StreamProofDeclaration = { coverage_strategy: "full_inventory" };

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;
const IMPORT_KEYWORD = /\bimport\b/;
const REQUIRE_CALL = /\brequire\s*\(/;

test("a zero-collection run with a measured enumeration boundary proves verified emptiness", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope({ considered: 0, covered: 0 }), FULL_INVENTORY), {
    proven: true,
    reason: "enumeration_boundary",
  });
});

test("a committed checkpoint with no coverage evidence proves nothing", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope(), FULL_INVENTORY), {
    proven: false,
    reason: "checkpoint_only",
  });
});

test("a skipped stream is not laundered into proven by a committed checkpoint", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope({ skipped: { reason: "upstream_unavailable" } }), FULL_INVENTORY), {
    proven: false,
    reason: "unresolved_attempt",
  });
});

test("an open recoverable gap is not laundered into proven by a committed checkpoint", () => {
  assert.deepEqual(
    evaluateStreamCoherence(envelope({ considered: 10, covered: 10, pending_detail_gaps: 3 }), FULL_INVENTORY),
    {
      proven: false,
      reason: "unresolved_attempt",
    }
  );
});

test("a satisfied enumeration boundary on a non-empty run stays proven", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope({ collected: 42, considered: 42 }), FULL_INVENTORY), {
    proven: true,
    reason: "enumeration_boundary",
  });
});

test("a declared covered count satisfies the boundary when collected suppressed unchanged records", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope({ collected: 0, considered: 40, covered: 40 }), FULL_INVENTORY), {
    proven: true,
    reason: "enumeration_boundary",
  });
});

test("a shortfall under a per-item accounting strategy is not proven", () => {
  assert.deepEqual(
    evaluateStreamCoherence(envelope({ collected: 7, considered: 40 }), {
      coverage_strategy: "parent_detail_accounting",
    }),
    { proven: false, reason: "boundary_shortfall" }
  );
});

test("a window-bounding strategy still needs its window closed to lean on the boundary", () => {
  assert.deepEqual(
    evaluateStreamCoherence(envelope({ collected: 7, considered: 40, checkpoint: "pending" }), FULL_INVENTORY),
    { proven: false, reason: "boundary_shortfall" }
  );
});

test("a closed window proves its measured boundary despite a changed-record-only collected count", () => {
  // `collected` counts only changed records here; the boundary was measured and
  // the window closed, so this is coverage, not a shortfall.
  assert.deepEqual(evaluateStreamCoherence(envelope({ collected: 5, considered: 100 }), FULL_INVENTORY), {
    proven: true,
    reason: "enumeration_boundary",
  });
});

test("a manifest declaring no proof strategy yields not-proven, never a synthesized completeness", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope({ collected: 500 }), {}), {
    proven: false,
    reason: "no_proof_strategy",
  });
});

test("a measured enumeration boundary stands on its own without a declared strategy keyword", () => {
  // `considered` measured at the enumeration site IS the strategy-specific
  // proof; requiring a second declaration would discard real evidence.
  assert.deepEqual(evaluateStreamCoherence(envelope({ collected: 0, considered: 10, covered: 10 }), {}), {
    proven: true,
    reason: "enumeration_boundary",
  });
  assert.deepEqual(evaluateStreamCoherence(envelope({ collected: 7, considered: 40 }), {}), {
    proven: false,
    reason: "boundary_shortfall",
  });
});

test("a manifest-declared accepted absence is positive evidence in its own right", () => {
  assert.deepEqual(evaluateStreamCoherence(envelope(), { accepted_absence: "unsupported" }), {
    proven: true,
    reason: "accepted_absence",
  });
});

test("a malformed considered denominator is treated as absent, not as a zero boundary", () => {
  const malformed = envelope({ considered: Number.NaN as number });
  assert.deepEqual(evaluateStreamCoherence(malformed, FULL_INVENTORY), {
    proven: false,
    reason: "checkpoint_only",
  });
});

test("isCheckpointOnlyClaim names the rejected shape and excludes measured or accepted streams", () => {
  assert.equal(isCheckpointOnlyClaim(envelope(), FULL_INVENTORY), true);
  assert.equal(isCheckpointOnlyClaim(envelope({ considered: 0 }), FULL_INVENTORY), false);
  assert.equal(isCheckpointOnlyClaim(envelope(), { accepted_absence: "deferred" }), false);
  assert.equal(isCheckpointOnlyClaim(envelope({ checkpoint: "not_committed" }), FULL_INVENTORY), false);
});

test("the coherence module is provably pure: it declares no imports and no ambient access", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/evidence/coherence.ts", import.meta.url)), "utf8");
  const code = source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
  assert.equal(IMPORT_KEYWORD.test(code), false, "coherence.ts must import nothing — not the RI, not the server");
  assert.equal(REQUIRE_CALL.test(code), false, "no CommonJS require");
  for (const ambient of ["process", "globalThis", "Date", "Math.random", "fetch"]) {
    assert.equal(code.includes(ambient), false, `coherence.ts must not reference ${ambient}`);
  }
});
