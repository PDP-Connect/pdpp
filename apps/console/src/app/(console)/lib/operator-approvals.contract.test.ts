// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SOURCE_FILE = `${HERE}operator-approvals.ts`;

const FINAL_APPROVAL_POST_RE =
  /fetchAs\("\/consent\/approve"[\s\S]*?body: JSON\.stringify\(\{\s*approval_review_revision: input\.approvalReviewRevision,\s*request_uri: input\.requestUri,\s*\}\)/;
const FINAL_APPROVAL_BODY_RE =
  /fetchAs\("\/consent\/approve"[\s\S]*?body: JSON\.stringify\(\{([\s\S]*?)\}\),[\s\S]*?method: "POST"/g;
const MUTABLE_FINAL_APPROVAL_FACT_RE =
  /\b(?:subject_id|ai_training_consented|approved_source_indexes|source_narrowing|confirm_reviewed_decision)\b/;
const NO_REVIEW_DURING_PENDING_APPROVAL_RE =
  /export async function approvePendingApproval[\s\S]*?fetchAs\("\/consent\/review"/;

test("console consent approval binds final issuance to PR114 immutable review revision only", async () => {
  const src = await readFile(SOURCE_FILE, "utf8");

  assert.match(src, FINAL_APPROVAL_POST_RE);
  const finalApprovalBodies = Array.from(src.matchAll(FINAL_APPROVAL_BODY_RE), (match) => match[1] ?? "");
  assert.equal(finalApprovalBodies.length, 2);
  for (const body of finalApprovalBodies) {
    assert.doesNotMatch(body, MUTABLE_FINAL_APPROVAL_FACT_RE);
  }
  assert.doesNotMatch(src, NO_REVIEW_DURING_PENDING_APPROVAL_RE);
});
