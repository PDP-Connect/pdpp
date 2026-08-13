// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConsentApprovalDetail,
  executeRefApprovalDetail,
  type RefApprovalConsentDetail,
  type RefApprovalDetail,
} from "../operations/ref-approval-detail/index.ts";

const FORBIDDEN_DEVICE_CODE_RE = /forbidden device_code/;
const FORBIDDEN_AUTHORIZATION_RE = /forbidden Authorization/;

function detail(): RefApprovalConsentDetail {
  return {
    approval_id: "apr_review",
    client: {
      client_id: "concert_finder",
      display: {
        name: "Concert Finder",
        policy_uri: "https://app.example/policy",
        tos_uri: null,
        uri: "https://app.example",
      },
      registration_mode: "pre_registered_public",
    },
    created_at: "2026-08-11T12:00:00.000Z",
    expires_at: "2026-08-11T12:10:00.000Z",
    grant_outcome: {
      access_mode: "continuous",
      description: "Ongoing access; this reference implementation sets no grant expiry.",
    },
    kind: "consent",
    object: "approval_review",
    purpose: { code: "https://pdpp.org/purpose/personalization", description: "Suggest concerts." },
    retention: { period: "P30D" },
    source: { id: "spotify", kind: "connector" },
    streams: [
      {
        client_claims: { use: "recommendations" },
        connection_id: "cin_music",
        fields: ["name"],
        name: "top_artists",
        necessity: null,
        resources: ["saved"],
        time_range: { since: "2026-01-01" },
        view: "basic",
      },
    ],
    trust: "unverified",
  };
}

test("ref.approvals.detail returns the complete allowlisted review projection", async () => {
  const projected = await executeRefApprovalDetail({ getPendingApprovalDetail: detail });
  assert.deepEqual(projected, detail());
});

test("ref.approvals.detail returns null for a terminal or expired approval", async () => {
  const projected = await executeRefApprovalDetail({ getPendingApprovalDetail: () => null });
  assert.equal(projected, null);
});

test("ref.approvals.detail rejects a dependency that leaks a raw pending-row secret", async () => {
  const leaked: RefApprovalDetail = {
    ...detail(),
    // @ts-expect-error -- deliberate off-contract leak verifies the runtime redaction guard
    device_code: "dc_bearer_equivalent",
  };
  await assert.rejects(executeRefApprovalDetail({ getPendingApprovalDetail: () => leaked }), FORBIDDEN_DEVICE_CODE_RE);
});

test("ref.approvals.detail drops unsafe registered display URIs before rendering", () => {
  const projected = buildConsentApprovalDetail(
    {
      approval_id: "apr_links",
      created_at: "2026-08-11T12:00:00.000Z",
      expires_at: "2026-08-11T12:10:00.000Z",
    },
    {
      client: {
        client_display: {
          name: "Link Tester",
          policy_uri: "https://policy.example/privacy",
          tos_uri: "https://user:pass@terms.example/tos",
          uri: "javascript:alert(1)",
        },
        client_id: "link_tester",
        registration_mode: "dynamic_public",
      },
      selection: { access_mode: "single_use" },
    },
    []
  );

  assert.ok(projected);
  assert.equal(projected.client.display.uri, null);
  assert.equal(projected.client.display.policy_uri, "https://policy.example/privacy");
  assert.equal(projected.client.display.tos_uri, null);
});

test("ref.approvals.detail recursively strips common credential-shaped JSON names", () => {
  const projected = buildConsentApprovalDetail(
    {
      approval_id: "apr_secret_json",
      created_at: "2026-08-11T12:00:00.000Z",
      expires_at: "2026-08-11T12:10:00.000Z",
    },
    {
      client: { client_id: "secret_tester" },
      selection: {
        access_mode: "continuous",
        retention: {
          nested: {
            Authorization: "Bearer bearer-value",
            client_secret: "client-secret-value",
            clientSecret: "client-secret-value",
            notes: "safe",
          },
        },
      },
    },
    [
      {
        client_claims: {
          audit: [{ refresh_token: "refresh-value" }, { ordinary_tokenized_label: "safe label" }],
          safe: "claim",
        },
        name: "events",
        resources: [{ "api-key": "api-key-value", id: "record_1" }],
      },
    ]
  );

  assert.ok(projected);
  assert.deepEqual(projected.retention, {
    nested: { notes: "safe" },
  });
  assert.deepEqual(projected.streams[0]?.client_claims, {
    audit: [{}, { ordinary_tokenized_label: "safe label" }],
    safe: "claim",
  });
  assert.deepEqual(projected.streams[0]?.resources, [{ id: "record_1" }]);
});

test("ref.approvals.detail rejects nested credential-shaped dependency leaks case-insensitively", async () => {
  const leaked: RefApprovalDetail = {
    ...detail(),
    retention: {
      nested: {
        Authorization: "Bearer bearer-value",
      },
    },
  };
  await assert.rejects(
    executeRefApprovalDetail({ getPendingApprovalDetail: () => leaked }),
    FORBIDDEN_AUTHORIZATION_RE
  );
});
