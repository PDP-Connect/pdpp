// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { decideBackoffDispatch } from "../runtime/scheduler/dispatch-governor.ts";

function input(overrides = {}) {
  return {
    announcedBackoff: undefined,
    announcedBlocked: undefined,
    backoffApplied: true,
    blocked: false,
    eligible: true,
    persistedBackoffStarted: false,
    persistedGaveUp: false,
    reasonClass: "source_pressure",
    recoveryOnly: true,
    ...overrides,
  };
}

test("decideBackoffDispatch returns exact backoff transition and dedup mutation decisions", (t) => {
  t.diagnostic("BASELINE: authored test active");

  const cases = [
    {
      expected: {
        announcedBackoffMutation: "delete",
        announcedBlockedMutation: "keep",
        eligible: true,
        recoveryOnly: true,
        transitions: [],
      },
      inputs: input({
        announcedBackoff: "source_pressure",
        backoffApplied: false,
        eligible: true,
        recoveryOnly: true,
      }),
      name: "no backoff clears announcedBackoff and preserves eligibility",
    },
    {
      expected: {
        announcedBackoffMutation: "set",
        announcedBlockedMutation: "keep",
        eligible: true,
        recoveryOnly: true,
        transitions: [{ kind: "backoff_started" }],
      },
      inputs: input(),
      name: "new backoff reason emits exactly backoff_started and sets announcedBackoffMutation",
    },
    {
      expected: {
        announcedBackoffMutation: "set",
        announcedBlockedMutation: "keep",
        eligible: true,
        recoveryOnly: true,
        transitions: [],
      },
      inputs: input({ persistedBackoffStarted: true }),
      name: "persisted backoff_started suppresses duplicate transition emission",
    },
    {
      expected: {
        announcedBackoffMutation: "set",
        announcedBlockedMutation: "keep",
        eligible: true,
        recoveryOnly: true,
        transitions: [],
      },
      inputs: input({ announcedBackoff: "source_pressure" }),
      name: "already-announced backoff suppresses duplicate transition emission",
    },
    {
      expected: {
        announcedBackoffMutation: "set",
        announcedBlockedMutation: "set",
        eligible: false,
        recoveryOnly: false,
        transitions: [{ kind: "gave_up" }],
      },
      inputs: input({
        announcedBackoff: "source_pressure",
        blocked: true,
      }),
      name: "blocked backoff emits gave_up once, sets announcedBlockedMutation, and suppresses dispatch",
    },
    {
      expected: {
        announcedBackoffMutation: "keep",
        announcedBlockedMutation: "keep",
        eligible: true,
        recoveryOnly: true,
        transitions: [],
      },
      inputs: input({ reasonClass: null }),
      name: "backoffApplied with no reasonClass keeps both cells and emits no transitions",
    },
  ];

  for (const { name, inputs, expected } of cases) {
    assert.deepEqual(decideBackoffDispatch(inputs), expected, name);
  }
});
