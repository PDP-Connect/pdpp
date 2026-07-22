// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { GrantSummary, ListResponse, PendingApproval } from "../lib/ref-client.ts";

export function buildGrantsDemoData(): {
  approvals: ListResponse<PendingApproval>;
  grants: ListResponse<GrantSummary>;
} {
  return {
    approvals: {
      data: [
        {
          approval_id: "apr_demo_agent_review",
          client_id: "https://agent.example.test/oauth/client",
          created_at: "2026-07-01T12:04:00.000Z",
          grant_preview: {
            source: {
              connection_id: "cin_demo_chatgpt_work",
              connector_id: "chatgpt",
              id: "chatgpt",
              kind: "connector",
            },
            streams: [{ name: "conversations" }, { name: "messages" }],
          },
          kind: "consent",
          object: "approval",
          user_code: "DEMO-42",
        },
      ],
      has_more: false,
      object: "list",
    },
    grants: {
      data: [
        {
          client: {
            client_id: "https://claude.example.test/oauth/client",
            client_name: "Claude Desktop",
            registration_mode: "dynamic",
          },
          client_id: "https://claude.example.test/oauth/client",
          connector_id: "chatgpt",
          event_count: 18,
          failure: null,
          first_at: "2026-06-28T10:30:00.000Z",
          grant_id: "grt_demo_claude_chatgpt",
          kinds: ["chatgpt.conversations.read", "chatgpt.messages.read"],
          last_at: "2026-07-01T11:51:00.000Z",
          object: "grant_summary",
          source: {
            connection_id: "cin_demo_chatgpt_work",
            connector_id: "chatgpt",
            id: "chatgpt",
            kind: "connector",
          },
          status: "issued",
        },
        {
          client: {
            client_id: "https://research.example.test/oauth/client",
            client_name: "Research notebook",
            registration_mode: "dynamic",
          },
          client_id: "https://research.example.test/oauth/client",
          connector_id: "amazon",
          event_count: 9,
          failure: { event_type: "grant.revoked", reason: "owner revoked access" },
          first_at: "2026-06-10T08:00:00.000Z",
          grant_id: "grt_demo_revoked_orders",
          kinds: ["amazon.orders.read"],
          last_at: "2026-06-21T14:45:00.000Z",
          object: "grant_summary",
          source: {
            connection_id: "cin_demo_amazon_home",
            connector_id: "amazon",
            id: "amazon",
            kind: "connector",
          },
          status: "revoked",
        },
      ],
      has_more: false,
      object: "list",
    },
  };
}
