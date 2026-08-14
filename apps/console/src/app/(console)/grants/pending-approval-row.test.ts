// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval } from "../lib/ref-client.ts";
import { PendingApprovalRow } from "./pending-approval-row.tsx";

(globalThis as { React?: typeof React }).React = React;

const DENY_LABEL_RE = /Deny request/;
const DENY_TARGET_RE = /Deny data-access request apr_queue_only/;
const NO_APPROVAL_RE = /Approve|issue grant/;
const REVIEW_LABEL_RE = /Review request/;

function noAction(): void {
  // Rendering proof only.
}

test("pending approval queue renders review and request-specific denial, never approval", () => {
  const approval: PendingApproval = {
    approval_id: "apr_queue_only",
    batch: false,
    client_id: "concert_finder",
    created_at: "2026-08-11T12:00:00.000Z",
    grant_preview: { source: { id: "spotify", kind: "connector" }, streams: [{ name: "top_artists" }] },
    kind: "consent",
    object: "approval",
  };
  const html = renderToStaticMarkup(PendingApprovalRow({ approval, denyAction: noAction }));
  assert.match(html, REVIEW_LABEL_RE);
  assert.match(html, DENY_LABEL_RE);
  assert.match(html, DENY_TARGET_RE);
  assert.doesNotMatch(html, NO_APPROVAL_RE);
});
