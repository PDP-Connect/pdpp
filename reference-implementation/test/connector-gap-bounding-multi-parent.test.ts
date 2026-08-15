// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStreamCoherence } from "../../packages/reference-contract/src/evidence/coherence.ts";
import { buildCollectionFacts } from "../runtime/connector-gap-bounding.ts";

test("collection facts aggregate every parent of a shared detail stream", () => {
  const facts = buildCollectionFacts({
    committedStateStreams: new Set(["direct_messages"]),
    detailCoverageByStateStream: new Map([
      ["group_messages", [{ considered: 3, covered: 2, requiredKeys: ["g1", "g2", "g3"], stream: "attachments" }]],
      ["direct_messages", [{ considered: 2, covered: 2, requiredKeys: ["d1", "d2"], stream: "attachments" }]],
    ]),
    durableDetailGaps: [],
    emittedByStream: new Map([["attachments", 4]]),
    knownGaps: [],
    newState: { direct_messages: { cursor: "d" }, group_messages: { cursor: "g" } },
    persistState: true,
    scopeByStream: new Map([
      ["attachments", {}],
      ["group_messages", {}],
      ["direct_messages", {}],
    ]),
  });

  assert.ok(facts);
  const attachment = facts.streams[0] as Record<string, unknown>;
  assert.equal(attachment.considered, 5, "the denominator includes both independently enumerated parents");
  assert.equal(attachment.covered, 4, "covered counts are additive only when both parents declared them");
  assert.equal(attachment.checkpoint, "not_committed", "one committed parent cannot prove the shared stream complete");
});

test("collection facts keep covered unknown when any parent omitted it", () => {
  const facts = buildCollectionFacts({
    committedStateStreams: new Set(["group_messages", "direct_messages"]),
    detailCoverageByStateStream: new Map([
      ["group_messages", [{ considered: 3, covered: 3, requiredKeys: ["g1", "g2", "g3"], stream: "attachments" }]],
      ["direct_messages", [{ considered: 2, requiredKeys: ["d1", "d2"], stream: "attachments" }]],
    ]),
    durableDetailGaps: [],
    emittedByStream: new Map([["attachments", 5]]),
    knownGaps: [],
    newState: { direct_messages: { cursor: "d" }, group_messages: { cursor: "g" } },
    persistState: true,
    scopeByStream: new Map([
      ["attachments", {}],
      ["group_messages", {}],
      ["direct_messages", {}],
    ]),
  });

  assert.ok(facts);
  const attachment = facts.streams[0] as Record<string, unknown>;
  assert.equal(attachment.considered, 5);
  assert.equal("covered" in attachment, false, "one parent's proof must not stand in for another's missing proof");
  assert.equal(attachment.checkpoint, "committed");
});

test("manifest-declared parents keep a missing parent's checkpoint visible", () => {
  const facts = buildCollectionFacts({
    committedStateStreams: new Set(["direct_messages"]),
    detailCoverageByStateStream: new Map([
      ["direct_messages", [{ considered: 1, covered: 1, requiredKeys: ["d1"], stream: "attachments" }]],
    ]),
    durableDetailGaps: [],
    emittedByStream: new Map([["attachments", 1]]),
    knownGaps: [],
    manifestDetailParentStreamsByStream: new Map([["attachments", new Set(["group_messages", "direct_messages"])]]),
    newState: { direct_messages: { cursor: "d" } },
    persistState: true,
    scopeByStream: new Map([
      ["attachments", {}],
      ["group_messages", {}],
      ["direct_messages", {}],
    ]),
  });

  assert.ok(facts);
  const attachment = facts.streams[0] as Record<string, unknown>;
  assert.equal(attachment.checkpoint, "not_staged");
  assert.equal("considered" in attachment, false, "one parent's denominator cannot stand in for a missing parent");
  assert.equal("covered" in attachment, false, "one parent's numerator cannot stand in for a missing parent");
  assert.deepEqual(
    evaluateStreamCoherence(
      {
        checkpoint: attachment.checkpoint as string,
        collected: attachment.collected as number,
        considered: null,
        covered: null,
        pending_detail_gaps: attachment.pending_detail_gaps as number,
        skipped: null,
      },
      { coverage_strategy: "parent_detail_accounting" }
    ),
    { proven: false, reason: "no_proof_strategy" }
  );
});
