// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { unresolvedOwnerActionEvidenceFromSummary } from "../server/owner-action-gate.js";

function summaryWithAction(action, overrides = {}) {
  return {
    connection_id: "cin_test",
    connection_health: { reason_code: "session_required" },
    rendered_verdict: { required_actions: [action] },
    ...overrides,
  };
}

test("owner-action gate treats urgent owner reauth as unresolved automation-blocking evidence", () => {
  const evidence = unresolvedOwnerActionEvidenceFromSummary(
    summaryWithAction({
      audience: "owner",
      kind: "reauth",
      surface: { kind: "browser_session" },
      satisfied_when: { kind: "credential_present_and_unrejected" },
      urgency: "now",
    }),
    "cin_route"
  );

  assert.deepEqual(evidence, {
    key: "owner_action:cin_test:reauth:browser_session:credential_present_and_unrejected:session_required",
    reason: "session_required",
  });
});

test("owner-action gate treats urgent provider interaction as unresolved automation-blocking evidence", () => {
  const evidence = unresolvedOwnerActionEvidenceFromSummary(
    summaryWithAction({
      audience: "owner",
      kind: "add_info",
      surface: { kind: "provider_interaction" },
      satisfied_when: { kind: "attention_resolved" },
      urgency: "overdue",
    })
  );

  assert.equal(evidence?.reason, "session_required");
  assert.match(evidence?.key ?? "", /owner_action:cin_test:add_info:provider_interaction:attention_resolved/u);
});

test("owner-action gate does not pause automation for owner retry accelerants", () => {
  for (const kind of ["retry_gap", "refresh_now"]) {
    const evidence = unresolvedOwnerActionEvidenceFromSummary(
      summaryWithAction({
        audience: "owner",
        kind,
        surface: { kind: "runtime_retry" },
        satisfied_when: { kind: "gap_recovered" },
        urgency: "verifying",
      })
    );

    assert.equal(evidence, null, `${kind} should not suppress unattended automation`);
  }
});

test("owner-action gate only pauses automation for urgent repair actions", () => {
  const evidence = unresolvedOwnerActionEvidenceFromSummary(
    summaryWithAction({
      audience: "owner",
      kind: "reauth",
      surface: { kind: "browser_session" },
      satisfied_when: { kind: "credential_present_and_unrejected" },
      urgency: "soon",
    })
  );

  assert.equal(evidence, null);
});

test("owner-action gate scopes fallback evidence by route connection id", () => {
  const evidence = unresolvedOwnerActionEvidenceFromSummary(
    summaryWithAction(
      {
        audience: "owner",
        kind: "reauth",
        surface: { kind: "browser_session" },
        satisfied_when: { kind: "credential_present_and_unrejected" },
        urgency: "now",
      },
      {
        connection_id: null,
        connector_id: "chatgpt",
      }
    ),
    "cin_chatgpt_route"
  );

  assert.match(evidence?.key ?? "", /^owner_action:cin_chatgpt_route:reauth:browser_session:/u);
});

test("owner-action gate ignores non-owner or non-satisfiable actions", () => {
  assert.equal(
    unresolvedOwnerActionEvidenceFromSummary(
      summaryWithAction({
        audience: "maintainer",
        kind: "code_fix",
        surface: { kind: "maintainer" },
        satisfied_when: { kind: "none" },
        urgency: "soon",
      })
    ),
    null
  );
  assert.equal(
    unresolvedOwnerActionEvidenceFromSummary(
      summaryWithAction({
        audience: "owner",
        kind: "reauth",
        surface: { kind: "stored_credential" },
        satisfied_when: { kind: "none" },
        urgency: "now",
      })
    ),
    null
  );
});
