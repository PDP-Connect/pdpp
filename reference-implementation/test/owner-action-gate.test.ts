// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { unresolvedOwnerActionEvidenceFromSummary } from "../server/owner-action-gate.ts";

const ADD_INFO_OWNER_ACTION_KEY = /owner_action:cin_test:add_info:provider_interaction:attention_resolved/u;
const ROUTE_CONNECTION_OWNER_ACTION_KEY = /^owner_action:cin_chatgpt_route:reauth:browser_session:/u;

interface RequiredActionFixture {
  audience: string;
  kind: string;
  satisfied_when: { kind: string };
  surface: { kind: string };
  urgency: string;
}

interface SummaryFixture {
  connection_health: { reason_code: string };
  connection_id: string | null;
  connector_id?: string;
  rendered_verdict: { required_actions: RequiredActionFixture[] };
}

interface SummaryOverrides {
  connection_id?: string | null;
  connector_id?: string;
}

function summaryWithAction(action: RequiredActionFixture, overrides: SummaryOverrides = {}): SummaryFixture {
  return {
    connection_health: { reason_code: "session_required" },
    connection_id: "cin_test",
    rendered_verdict: { required_actions: [action] },
    ...overrides,
  };
}

test("owner-action gate treats urgent owner reauth as unresolved automation-blocking evidence", () => {
  const evidence = unresolvedOwnerActionEvidenceFromSummary(
    summaryWithAction({
      audience: "owner",
      kind: "reauth",
      satisfied_when: { kind: "credential_present_and_unrejected" },
      surface: { kind: "browser_session" },
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
      satisfied_when: { kind: "attention_resolved" },
      surface: { kind: "provider_interaction" },
      urgency: "overdue",
    })
  );

  assert.equal(evidence?.reason, "session_required");
  assert.match(evidence?.key, ADD_INFO_OWNER_ACTION_KEY);
});

test("owner-action gate does not pause automation for owner retry accelerants", () => {
  for (const kind of ["retry_gap", "refresh_now"]) {
    const evidence = unresolvedOwnerActionEvidenceFromSummary(
      summaryWithAction({
        audience: "owner",
        kind,
        satisfied_when: { kind: "gap_recovered" },
        surface: { kind: "runtime_retry" },
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
      satisfied_when: { kind: "credential_present_and_unrejected" },
      surface: { kind: "browser_session" },
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
        satisfied_when: { kind: "credential_present_and_unrejected" },
        surface: { kind: "browser_session" },
        urgency: "now",
      },
      {
        connection_id: null,
        connector_id: "chatgpt",
      }
    ),
    "cin_chatgpt_route"
  );

  assert.ok(evidence);
  assert.match(evidence.key, ROUTE_CONNECTION_OWNER_ACTION_KEY);
});

test("owner-action gate ignores non-owner or non-satisfiable actions", () => {
  assert.equal(
    unresolvedOwnerActionEvidenceFromSummary(
      summaryWithAction({
        audience: "maintainer",
        kind: "code_fix",
        satisfied_when: { kind: "none" },
        surface: { kind: "maintainer" },
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
        satisfied_when: { kind: "none" },
        surface: { kind: "stored_credential" },
        urgency: "now",
      })
    ),
    null
  );
});
