// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { getOwnerConnectionDetailGapPage } from "../server/owner-detail-gap-projection.ts";

test("owner detail-gap diagnostics only expose the persisted terminal policy disposition", async () => {
  const page = await getOwnerConnectionDetailGapPage({
    connectionId: "cin_owner_policy",
    connectorId: "gmail",
    connectorInstanceId: "cin_owner_policy",
    store: {
      listGapsForConnectorInstance: () => [
        {
          attempt_count: 1,
          created_at: "2026-08-02T12:00:00.000Z",
          gap_id: "terminal-with-proof",
          last_error: { class: "too_large" },
          policy_disposition: {
            configured_limit_bytes: 25,
            kind: "gmail_attachment_too_large",
            observed_size_bytes: 26,
          },
          reason: "too_large",
          status: "terminal",
          stream: "attachments",
        },
        {
          attempt_count: 1,
          created_at: "2026-08-02T12:00:01.000Z",
          gap_id: "not-found-status-mutated",
          last_error: { class: "not_found" },
          reason: "too_large",
          status: "terminal",
          stream: "attachments",
        },
      ],
    },
  });
  assert.deepEqual(
    page.data.map((row) => [row.gap_id, row.disposition.policy_class]),
    [
      ["terminal-with-proof", "gmail_attachment_too_large"],
      ["not-found-status-mutated", null],
    ]
  );
});
