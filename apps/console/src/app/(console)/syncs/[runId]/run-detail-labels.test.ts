// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: the run-detail assistance/stats callouts used to print raw
 * internal enum strings and snake_case field names straight into owner-facing
 * UI (`blocked · provide_value · response_required`, `commit_failed`). These
 * helpers are the only path to that UI now, so pinning them pins the fix.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeAssistanceOwnerAction,
  describeAssistanceProgressPosture,
  describeAssistanceResponseContract,
  describeCheckpointStatLabel,
  describeInteractionStatLabel,
  describeProgressStatLabel,
  describeTerminalRunStatus,
} from "./run-detail-labels.ts";

test("assistance progress posture never leaks the raw snake_case value", () => {
  assert.equal(describeAssistanceProgressPosture("blocked"), "Blocked");
  assert.equal(describeAssistanceProgressPosture("running"), "Running");
  assert.equal(describeAssistanceProgressPosture("waiting_retry"), "Waiting to retry");
});

test("assistance owner action never leaks the raw snake_case value", () => {
  assert.equal(describeAssistanceOwnerAction("provide_value"), "Needs a value from you");
  assert.equal(describeAssistanceOwnerAction("operate_attachment"), "Needs you to complete a step");
  assert.equal(describeAssistanceOwnerAction("act_elsewhere"), "Approve outside this dashboard");
  assert.equal(describeAssistanceOwnerAction("none"), "No action needed");
});

test("assistance response contract never leaks the raw snake_case value", () => {
  assert.equal(describeAssistanceResponseContract("response_required"), "Response required");
  assert.equal(describeAssistanceResponseContract("none"), "No response required");
});

test("terminal run status humanizes succeeded_with_gaps instead of passing it through raw", () => {
  assert.equal(describeTerminalRunStatus("succeeded_with_gaps"), "succeeded with gaps");
  assert.equal(describeTerminalRunStatus("succeeded"), "succeeded");
  assert.equal(describeTerminalRunStatus("failed"), "failed");
  assert.equal(describeTerminalRunStatus("cancelled"), "cancelled");
  assert.equal(describeTerminalRunStatus("deferred"), "deferred");
});

test("stat-card row labels are Title Case, not the raw field name", () => {
  assert.equal(describeCheckpointStatLabel("commit_failed"), "Failed to commit");
  assert.equal(describeCheckpointStatLabel("staged"), "Staged");
  assert.equal(describeCheckpointStatLabel("advanced"), "Advanced");
  assert.equal(describeProgressStatLabel("last_message"), "Last message");
  assert.equal(describeProgressStatLabel("last_count"), "Last count");
  assert.equal(describeProgressStatLabel("last_total"), "Last total");
  assert.equal(describeProgressStatLabel("reports"), "Reports");
  // Named in its unit: the stat counts `run.stream_skipped` events, which a
  // connector emits per dropped RECORD. A bare "Skipped" next to a number
  // read as a stream count.
  assert.equal(describeProgressStatLabel("skipped"), "Skipped items");
  assert.equal(describeInteractionStatLabel("required"), "Required");
  assert.equal(describeInteractionStatLabel("completed"), "Completed");
});
