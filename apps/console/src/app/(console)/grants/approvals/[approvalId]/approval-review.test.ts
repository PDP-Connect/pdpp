// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalReview, ConsentApprovalReview, SingleConsentApprovalArtifact } from "../../../lib/ref-client.ts";
import { ApprovalReview as ApprovalReviewView } from "./approval-review.tsx";

(globalThis as { React?: typeof React }).React = React;

const APPROVAL_BUTTON_RE = /Approve and issue grant/;
const APPROVAL_CONFIRMATION_RE = /name="approval_confirmation"[^>]*value="approve"/;
const APPROVAL_REVISION_RE =
  /name="approval_review_revision"[^>]*value="reference\.approval-review\.v1:sha256:reviewDigest"/;
const REQUEST_URI_RE = /name="request_uri"[^>]*value="urn:pdpp:pending-consent:dc_reviewed"/;
const NO_APPROVAL_BUTTON_RE = /<button[^>]*>Approve and issue grant<\/button>/;
const NO_DEVICE_SECRET_RE = /device_code|user_code|params_json/;
const OWNER_DEVICE_CONTROL_RE = /Owner device control/;
const OWNER_DEVICE_WARNING_RE = /not a scoped third-party data grant/;
const REVIEW_CONTINUE_RE = /Continue to approval/;
const BATCH_NON_ACTIONABLE_RE = /Batch approval is not available from this console review/;
const BATCH_ARTIFACT_VERSION_RE = /reference\.batch-approval-review\.v1/;
const NO_APPROVAL_ID_RE = /name="approval_id"[^>]*value="dc_/;
const NO_MUTABLE_CONSENT_RE = /name="subject_id"|name="ai_training_consented"/;
const NO_OWNER_DEVICE_SCOPE_RE = /Resolved streams|Purpose/;

function noAction(): void {
  // Rendering proof only.
}

function artifact(overrides: Partial<SingleConsentApprovalArtifact> = {}): SingleConsentApprovalArtifact {
  return {
    access_mode: "continuous",
    ai_training_consented: true,
    client: {
      client_display: {
        name: "Concert Finder",
        policy_uri: "https://concert.example/policy",
        tos_uri: "data:text/html,owned",
        uri: "javascript:alert(1)",
      },
      client_id: "concert_finder",
      registration_mode: "pre_registered_public",
    },
    expires_at: "2026-08-11T12:10:00.000Z",
    client_claims: { commitments: ["Use only for concert recommendations"] },
    purpose_code: "https://pdpp.dev/purpose/ai_training",
    purpose_description: "Train a concert-ranking model.",
    resolved_streams: [
      {
        fields: ["name", "popularity"],
        instance_ids: ["cin_music_primary", "cin_music_backup"],
        name: "top_artists",
        resources: ["artist_1", "artist_2"],
        time_constraint: { field: "played_at", since: "2026-01-01", until: "2026-02-01" },
      },
    ],
    retention: { max_duration: "P30D", on_expiry: "delete" },
    selection_preset: "music-profile",
    source: { id: "spotify", kind: "connector" },
    source_declaration: {
      accepted_revision_reference: "accepted-rev-1",
      digest: "sha256:sourceDigest",
      publisher_attribution: { id: "https://pdpp.dev/reference-implementation", status: "unverified" },
      resource_authority: { authority_binding: "https://spotify.example/pdpp", status: "verified" },
      version: "reference.source-declaration.v1",
    },
    subject: { id: "owner_local" },
    version: "reference.approval-review.v1",
    ...overrides,
  };
}

function consent(overrides: Partial<ConsentApprovalReview> = {}): ConsentApprovalReview {
  return {
    approval_id: "apr_review_safe",
    approval_review: artifact(),
    approval_review_revision: "reference.approval-review.v1:sha256:reviewDigest",
    batch: false,
    kind: "consent",
    object: "approval_review",
    request_uri: "urn:pdpp:pending-consent:dc_reviewed",
    ...overrides,
  };
}

function render(detail: ApprovalReview, confirm = false): string {
  return renderToStaticMarkup(ApprovalReviewView({ approveAction: noAction, confirm, denyAction: noAction, detail }));
}

test("single consent review renders PR114 artifact authority and no approval submit before confirmation", () => {
  const html = render(consent());
  for (const label of [
    "reference.approval-review.v1",
    "owner_local",
    "Concert Finder",
    "concert_finder",
    "spotify",
    "reference.source-declaration.v1 / sha256:sourceDigest",
    "accepted revision accepted-rev-1",
    "publisher https://pdpp.dev/reference-implementation (unverified)",
    "resource authority verified: https://spotify.example/pdpp",
    "Use only for concert recommendations",
    "music-profile",
    "Train a concert-ranking model.",
    "continuous",
    "true",
    "P30D",
    "cin_music_primary, cin_music_backup",
    "name, popularity",
    "artist_1, artist_2",
    "played_at: 2026-01-01 to 2026-02-01",
    "Exact reviewed artifact",
  ]) {
    assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, REVIEW_CONTINUE_RE);
  assert.doesNotMatch(html, NO_APPROVAL_BUTTON_RE);
  assert.doesNotMatch(html, NO_DEVICE_SECRET_RE);
});

test("final consent confirmation carries the exact reviewed request uri and revision", () => {
  const html = render(consent(), true);
  assert.match(html, APPROVAL_BUTTON_RE);
  assert.match(html, APPROVAL_CONFIRMATION_RE);
  assert.match(html, APPROVAL_REVISION_RE);
  assert.match(html, REQUEST_URI_RE);
  assert.doesNotMatch(html, NO_APPROVAL_ID_RE);
  assert.doesNotMatch(html, NO_MUTABLE_CONSENT_RE);
});

test("batch review is explicit and non-actionable in the console", () => {
  const html = render(
    consent({
      approval_review: {
        access_mode: null,
        approved_source_indexes: [0],
        client: artifact().client,
        expires_at: "2026-08-11T12:10:00.000Z",
        parent_package_id: "pkg_1",
        source_narrowing: { "0": { streams: ["top_artists"] } },
        sources: [
          {
            access_mode: "continuous",
            client_claims: { commitments: ["Only use this approved source for batch recommendations"] },
            index: 0,
            purpose_code: "https://pdpp.dev/purpose/ai_training",
            purpose_description: "Train a concert-ranking model.",
            resolved_streams: artifact().resolved_streams,
            retention: { max_duration: "P30D" },
            selection_preset: "music-profile",
            source: { id: "spotify", kind: "connector" },
            source_declaration: { digest: "sha256:sourceDigest", version: "reference.source-declaration.v1" },
          },
        ],
        subject: { id: "owner_local" },
        version: "reference.batch-approval-review.v1",
      },
      batch: true,
    }),
    true
  );
  assert.match(html, BATCH_ARTIFACT_VERSION_RE);
  assert.match(html, BATCH_NON_ACTIONABLE_RE);
  assert.doesNotMatch(html, NO_APPROVAL_BUTTON_RE);
});

test("owner-device review warns about owner control without inventing grant scope or purpose", () => {
  const html = render({
    approval_id: "apr_owner",
    client_id: "owner_cli",
    created_at: "2026-08-11T12:00:00.000Z",
    expires_at: "2026-08-11T12:10:00.000Z",
    kind: "owner_device",
    object: "approval_review",
  });
  assert.match(html, OWNER_DEVICE_CONTROL_RE);
  assert.match(html, OWNER_DEVICE_WARNING_RE);
  assert.doesNotMatch(html, NO_OWNER_DEVICE_SCOPE_RE);
});
