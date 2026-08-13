// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE_FILE = `${HERE}ref-client.ts`;
const PAGE_FILE = `${HERE}../grants/approvals/[approvalId]/page.tsx`;
const CONSENT_REVIEW_FETCH_RE = /refFetch\("\/consent\/review"[\s\S]*?approval_id: approvalId/;
const ARTIFACT_BINDING_RE = /approval_review: body\.approval_review as ConsentApprovalArtifact/;
const REVISION_BINDING_RE = /approval_review_revision: body\.approval_review_revision/;
const REQUEST_URI_BINDING_RE = /request_uri: body\.request_uri/;
const NO_DETAIL_RECONSTRUCTION_RE = /buildConsentApprovalDetail/;
const ERROR_CLEARS_CONFIRM_RE = /confirm=\{!query\.approval_error && query\.confirm === "1"\}/;

test("approval review page source materializes PR114 consent review artifact before rendering", async () => {
  const src = await readFile(SOURCE_FILE, "utf8");
  assert.match(src, CONSENT_REVIEW_FETCH_RE);
  assert.match(src, ARTIFACT_BINDING_RE);
  assert.match(src, REVISION_BINDING_RE);
  assert.match(src, REQUEST_URI_BINDING_RE);
  assert.doesNotMatch(src, NO_DETAIL_RECONSTRUCTION_RE);
});

test("approval error clears confirmation before rerendering the materialized review", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, ERROR_CLEARS_CONFIRM_RE);
});
