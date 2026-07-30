// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactInput,
  parseArgs,
  parseArtifact,
  validateArgs,
} from "../scripts/repair/apply-browser-surface-replacement-correction.ts";

const ARTIFACT = JSON.stringify({
  correction: {
    applied_at: "2026-07-30T00:00:00.000Z",
    episode: {
      first_event_seq: 2,
      first_observed_at: "2026-07-29T00:00:00.000Z",
      id: "reviewed-episode",
      last_event_seq: 2,
      last_observed_at: "2026-07-29T00:00:00.000Z",
    },
    members: [],
    prior_failed_replacement_id: "reviewed-predecessor",
    replacement_batch_id: "reviewed-batch",
  },
  version: 1,
});
const AMBIGUOUS_ACTION_ERROR = /at most one/;
const REVOKE_TIMESTAMP_ERROR = /requires --revoked-at/;

test("reviewed replacement correction accepts one exact artifact and derives its digest", () => {
  const parsed = parseArtifact(ARTIFACT);
  assert.equal(parsed.version, 1);
  assert.equal(artifactInput(ARTIFACT).reviewed_artifact_sha256.length, 64);
  assert.notEqual(
    artifactInput(`${ARTIFACT}\n`).reviewed_artifact_sha256,
    artifactInput(ARTIFACT).reviewed_artifact_sha256
  );
});

test("reviewed replacement correction refuses ambiguous maintenance actions", () => {
  assert.equal(validateArgs(parseArgs(["--artifact=episode.json"])), null);
  assert.match(
    validateArgs(parseArgs(["--artifact=episode.json", "--apply", "--verify"])) || "",
    AMBIGUOUS_ACTION_ERROR
  );
  assert.match(validateArgs(parseArgs(["--artifact=episode.json", "--revoke"])) || "", REVOKE_TIMESTAMP_ERROR);
});
