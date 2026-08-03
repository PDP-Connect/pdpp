// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the owner-token issuance page.
 *
 * The boundary this page describes is load-bearing: tokens issued here are
 * full owner bearers for `/v1/*`, the right shape for the operator or a
 * trusted local agent that runs on the operator's behalf, and the explicit
 * wrong shape for ordinary MCP clients (Claude, ChatGPT, third-party
 * agents). The hosted MCP endpoint at `/mcp` rejects owner bearers on
 * purpose. If that framing regresses to generic "issue a token" copy, the
 * dashboard quietly trains operators to paste owner credentials into MCP
 * clients — undoing the scoped-grant story.
 *
 * Spec: openspec/specs/mcp-adapter/spec.md (Hosted MCP rejects owner bearers)
 *       openspec/specs/reference-agent-access-workflow/spec.md (agents SHALL
 *       use scoped client grants instead of owner tokens)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { OwnerIssuedClient } from "../../lib/ref-client.ts";
import { byCleanupPriority } from "./token-cleanup-priority.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const BOUNDARY_HEADING_RE = /operator and trusted-agent access only/i;
const TRUSTED_AGENT_FRAMING_RE = /trusted local agents?/i;
const OWNER_AGENT_COMMAND_RE = /pdpp owner-agent onboard/;
const DAISY_CREDENTIAL_PATH_RE = /pdpp-owner-agent\.json/;
const NO_BEARER_CHAT_RE = /No bearer needs to be\s+.*pasted into chat/i;
const MANUAL_DEBUG_RE = /Manual\/debug bearer/i;
const MCP_SCOPED_FLOW_HINT_RE = /\/mcp/;
const ORDINARY_MCP_CLIENTS_RE = /ordinary MCP clients/i;
const MCP_REJECTS_OWNER_RE = /rejects owner bearers/i;

const STALE_GENERIC_DESCRIPTION_RE = /Issue an owner bearer for the reference RS\.$/m;
const STALE_PRIMARY_ISSUE_BUTTON_RE = />\s*Issue token\s*</;

test("tokens page calls out the operator/trusted-agent boundary in copy", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, BOUNDARY_HEADING_RE);
  assert.match(src, TRUSTED_AGENT_FRAMING_RE);
});

test("tokens page leads with the owner-agent onboarding path instead of bearer copy", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, OWNER_AGENT_COMMAND_RE);
  assert.match(src, DAISY_CREDENTIAL_PATH_RE);
  assert.match(src, NO_BEARER_CHAT_RE);
  assert.match(src, MANUAL_DEBUG_RE);
});

test("tokens page names the ordinary-MCP-client path and that /mcp refuses owner bearers", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, ORDINARY_MCP_CLIENTS_RE);
  assert.match(src, MCP_SCOPED_FLOW_HINT_RE);
  assert.match(src, MCP_REJECTS_OWNER_RE);
});

test("tokens page does not regress to the prior generic description", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The earlier copy ("Issue an owner bearer for the reference RS.") didn't
  // tell a fresh operator who this surface is for. Lock the sharper framing
  // in so a future polish pass doesn't quietly revert it.
  assert.doesNotMatch(src, STALE_GENERIC_DESCRIPTION_RE);
  assert.doesNotMatch(src, STALE_PRIMARY_ISSUE_BUTTON_RE);
});

// ─── owner-access reference contracts wiring (10.C) ───────────────────────

const RENAME_ACTION_RE = /action=\{renameOwnerTokenAction\}/;
const RENAME_INPUT_RE = /name="client_name"/;
const PER_TOKEN_REVOKE_ACTION_RE = /action=\{revokeOwnerClientTokenAction\}/;
const PER_TOKEN_HANDLE_RE = /name="token_id_public"/;
const RAW_TOKEN_ID_FIELD_RE = /name="token_id"[^_]/;
const TOKEN_ACCESS_TOKEN_RE = /token\.access_token/;
const TOKEN_ID_FIELD_RE = /\.token_id\b(?!_public)/;
// The drilldown must be gated on active_token_count > 1 so a single-token
// client is fully described by its row (no needless expansion).
const DRILLDOWN_GATE_RE = /active_token_count\s*>\s*1/;

test("tokens page wires the in-place rename action with a client_name field (10.C.1)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RENAME_ACTION_RE);
  assert.match(src, RENAME_INPUT_RE);
});

test("tokens page wires the per-token drilldown revoke by public id, gated on >1 active token (10.C.2/10.C.3)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PER_TOKEN_REVOKE_ACTION_RE);
  // The per-token revoke addresses a NON-bearer public id, never a raw token_id.
  assert.match(src, PER_TOKEN_HANDLE_RE);
  assert.doesNotMatch(src, RAW_TOKEN_ID_FIELD_RE);
  assert.match(src, DRILLDOWN_GATE_RE);
});

test("tokens page renders no raw bearer from the token drilldown (no-leak guard)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The per-client token type exposes only a public id + issued/expiry facts;
  // there is no `.access_token` / raw bearer field to render for listed tokens.
  assert.doesNotMatch(src, TOKEN_ACCESS_TOKEN_RE);
  assert.doesNotMatch(src, TOKEN_ID_FIELD_RE);
});

// ─── Last-used / never-used cleanup affordance ─────────────────────────────
//
// "Last used" is derived from `disclosure.served` spine events, not from a
// stored column — there is no `tokens.last_used_at` in either backend. The
// load-bearing part is the NULL case: a credential that has never read
// anything still holds its full grant, and on a live deployment there are
// real examples of exactly that. If `null` ever renders as an empty cell,
// the credentials most worth revoking become the least visible ones on the
// page, which inverts the purpose of this surface.
//
// These guards deliberately strip comments and attribute values before
// matching. An earlier version of this test matched the whole file and so
// passed against a build where the rendered copy had been deleted but a
// comment still said "never used" — a guard that cannot fail is worse than
// no guard, because it certifies a regression as safe.
function renderedText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\stitle=\{?"[^"]*"\}?/g, "");
}

const NEVER_USED_COPY_RE = /never used/i;
const LAST_USED_COPY_RE = /last used/i;
const CLEANUP_ORDER_RE = /\[\.\.\.tokens\]\.sort\(byCleanupPriority\)/;

test("tokens page renders an explicit never-used state, not a blank cell", async () => {
  const body = renderedText(await readFile(PAGE_FILE, "utf8"));
  assert.match(body, NEVER_USED_COPY_RE);
  assert.match(body, LAST_USED_COPY_RE);
});

test("tokens page orders credentials for cleanup (never-used first, then least-recently-used)", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CLEANUP_ORDER_RE);
  // The list must render the SORTED collection, not the raw server order.
  assert.match(src, /ordered\.map\(/);
});

function client(overrides: Partial<OwnerIssuedClient>): OwnerIssuedClient {
  return {
    active_token_count: 1,
    client_id: "cli_default",
    client_name: "Client",
    created_at: "2031-01-01T00:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}

// Behavioral proof: a source-regex match on `[...tokens].sort(byCleanupPriority)`
// (above) proves the sort is CALLED, but not that the comparator actually
// orders never-used first — that claim is only provable by exercising the
// real comparator against real inputs it must discriminate.
test("byCleanupPriority sorts never-used credentials before any used credential, regardless of issuance order", () => {
  const recentlyUsed = client({
    client_id: "cli_recent",
    created_at: "2031-01-01T00:00:00.000Z",
    last_used_at: "2031-06-01T00:00:00.000Z",
  });
  const staleUsed = client({
    client_id: "cli_stale",
    created_at: "2031-01-02T00:00:00.000Z",
    last_used_at: "2031-02-01T00:00:00.000Z",
  });
  // Issued LAST (newest created_at) but NEVER used — must still sort FIRST.
  const neverUsed = client({
    client_id: "cli_never",
    created_at: "2031-12-31T00:00:00.000Z",
    last_used_at: null,
  });

  const ordered = [recentlyUsed, staleUsed, neverUsed].sort(byCleanupPriority);
  assert.deepEqual(
    ordered.map((c) => c.client_id),
    ["cli_never", "cli_stale", "cli_recent"],
    "never-used sorts first despite being issued most recently; used credentials then order least-recently-used first"
  );
});

test("byCleanupPriority breaks ties among multiple never-used credentials by issuance order (oldest first)", () => {
  const neverUsedNewer = client({ client_id: "cli_never_newer", created_at: "2031-06-01T00:00:00.000Z", last_used_at: null });
  const neverUsedOlder = client({ client_id: "cli_never_older", created_at: "2031-01-01T00:00:00.000Z", last_used_at: null });

  const ordered = [neverUsedNewer, neverUsedOlder].sort(byCleanupPriority);
  assert.deepEqual(
    ordered.map((c) => c.client_id),
    ["cli_never_older", "cli_never_newer"],
    "among never-used credentials, the older issuance sorts first"
  );
});

// ─── Truthful credential copy (BUG 3) ──────────────────────────────────────
//
// This listing selects by WHO REGISTERED the client (issuer_subject_id), not
// by token kind, so a row can hold `owner` bearers (full /v1/* access), scoped
// `client` tokens, or `mcp_package` tokens bound to a single consent ceremony.
// A real deployment showed a row reading "4 active tokens" under an "Owner
// credentials" heading whose tokens were 2 mcp_package + 2 client and ZERO
// owner bearers — copy that overstates blast radius on a security surface.
//
// Comments and attribute values are stripped before matching: an earlier guard
// on this page passed against a build whose rendered copy had been deleted
// because a comment still carried the phrase.
function renderedCopy(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\stitle=\{?"[^"]*"\}?/g, "");
}

test("tokens page does not claim every listed row is an owner credential", async () => {
  const body = renderedCopy(await readFile(PAGE_FILE, "utf8"));
  assert.doesNotMatch(
    body,
    /One row per approved owner-agent or manual credential/,
    "the old heading asserted every row is an owner credential, which is false for client/mcp_package rows"
  );
  // It must say so explicitly rather than merely omitting the claim.
  assert.match(body, /Not every row is an owner bearer/i);
});

test("tokens page derives the per-row label from the actual token kinds", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /describeTokenKinds\(token\.active_token_kinds\)/);
  // A bare "active tokens" literal would be the un-derived form this replaces.
  assert.doesNotMatch(renderedCopy(src), /active token\{token\.active_token_count === 1/);
});
