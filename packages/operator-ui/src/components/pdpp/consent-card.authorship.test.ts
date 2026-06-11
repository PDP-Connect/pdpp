/**
 * Authorship-classification guard for the consent card — the surface where the
 * three-class TRUST MODEL is made visible (design-direction decision 1).
 *
 * Every content element on the card must classify into exactly one authorship,
 * rendered with that authorship's temperature:
 *   protocol — cool blue  (--authorship-protocol-*): enforced, verifiable facts
 *   manifest — warm copper (--authorship-manifest-*): owner/manifest-authored
 *   client   — neutral + DASHED (--authorship-client-*): claimed, never trusted
 *
 * The package's component tests are source-regex guards (these components import
 * `next/image` and client-only deps that don't resolve under the bare
 * `node --test` runner), so this guard pins the authorship wiring at the source:
 * the right element class carries the right `data-authorship` value and the
 * right tier token, and the multi-connection scope list still renders. That is
 * the contract a standards reviewer relies on.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CARD_FILE = `${HERE}consent-card.tsx`;

const src = await readFile(CARD_FILE, "utf8");

// ─── Hoisted regex constants (biome useTopLevelRegex) ─────────────────────────

const CLIENT_NAME_RE = /border-dashed[\s\S]*?font-semibold text-foreground[\s\S]*?data-authorship="client"/;
const CLIENT_APP_CHIP_RE = /border border-authorship-client-border border-dashed[\s\S]*?text-authorship-client-fg[\s\S]*?data-authorship="client"/;
const DASHED_RE = /border-dashed/;

const COMMITMENTS_FN_RE = /function Commitments\(/;
const COMMITMENTS_CLIENT_RULE_RE = /data-authorship="client"[\s\S]*?border-authorship-client-border border-l border-dashed/;
const NOT_ENFORCED_RE = /not enforced by your server/;
const PURPOSE_CLIENT_RE = /they say they want[\s\S]*?\{purpose\}/;

const REQUIRED_ROW_MANIFEST_RE = /function RequiredStreamRow\([\s\S]*?data-authorship="manifest"[\s\S]*?bg-authorship-manifest-accent/;
const OPTIONAL_ROW_MANIFEST_RE = /function OptionalStreamRow\([\s\S]*?data-authorship="manifest"[\s\S]*?bg-authorship-manifest-accent/;
const MANIFEST_EYEBROW_RE = /<AuthorshipEyebrow authorship="manifest">your server will share<\/AuthorshipEyebrow>/;

const ACCESS_DURATION_PROTOCOL_RE = /function AccessDuration\([\s\S]*?data-authorship="protocol"[\s\S]*?<AuthorshipEyebrow authorship="protocol">enforced<\/AuthorshipEyebrow>/;
const TECHNICAL_PROTOCOL_RULE_RE = /function TechnicalDetails\([\s\S]*?border-authorship-protocol-border[\s\S]*?data-authorship="protocol"/;
const VERIFICATION_FN_RE = /function VerificationBadge\([\s\S]*?data-authorship="protocol"/;

const LEGEND_FN_RE = /function AuthorshipLegend\(/;
const LEGEND_SLOT_RE = /data-slot="authorship-legend"/;
const LEGEND_PROTOCOL_RE = /bg-authorship-protocol-accent/;
const LEGEND_MANIFEST_RE = /bg-authorship-manifest-accent/;
const LEGEND_CLIENT_RE = /border-authorship-client-border border-dashed/;
const LEGEND_RENDERED_RE = /<AuthorshipLegend \/>/;

const INLINE_STYLE_RE = /\bstyle=\{/;
const RAW_OKLCH_RE = /oklch\(/;

const SCOPE_LIST_FN_RE = /function ConnectionScopeList\(\{ connections \}: \{ connections: ConsentCardConnection\[\] \}\)/;
const SCOPE_LIST_PROTOCOL_RE = /aria-label="Connections covered by this stream"[\s\S]*?data-authorship="protocol"[\s\S]*?connections\.map\(\(connection\)[\s\S]*?\{connection\.displayName\}/;
const HAS_MULTI_RE = /const hasMultipleConnections = Array\.isArray\(connections\) && connections\.length > 1/;
const SCOPE_LIST_RENDERED_RE = /\{hasMultipleConnections && <ConnectionScopeList connections=\{connections\} \/>\}/;

const ACCESS_MODE_COPY_RE = /accessMode === "continuous"\s*\?\s*"Ongoing access, active until you revoke it\. Your server enforces this\."\s*:\s*"One-time access\. Your server will not allow further queries\."/;

const TOGGLE_FN_RE = /function OptionalToggle\(/;
const TOGGLE_ROLE_RE = /role="switch"/;
const TOGGLE_CHECKED_RE = /aria-checked=\{enabled\}/;
const TOGGLE_HANDLER_RE = /onToggleEnabled/;

const EXPORT_FN_RE = /export function ConsentCard\(/;
const EXPORT_CONNECTION_RE = /export interface ConsentCardConnection/;
const EXPORT_STREAM_RE = /export interface ConsentCardStream/;
const EXPORT_OPTIONAL_RE = /export interface ConsentCardOptional/;
const EXPORT_PROPS_RE = /export interface ConsentCardProps/;

const AUTHORSHIP_TIERS = ["protocol", "manifest", "client"] as const;
const TIER_RE = {
  client: /data-authorship="client"/,
  manifest: /data-authorship="manifest"/,
  protocol: /data-authorship="protocol"/,
} as const;

const CONTRACT_PROPS = [
  "accessMode",
  "commitments",
  "onAllow",
  "onDeny",
  "optional",
  "purpose",
  "requester",
  "streams",
  "technical",
] as const;
const CONTRACT_PROP_RE = {
  accessMode: /\baccessMode\b/,
  commitments: /\bcommitments\b/,
  onAllow: /\bonAllow\b/,
  onDeny: /\bonDeny\b/,
  optional: /\boptional\b/,
  purpose: /\bpurpose\b/,
  requester: /\brequester\b/,
  streams: /\bstreams\b/,
  technical: /\btechnical\b/,
} as const;

// ─── Each authorship class is present and bound to its tier tokens ────────────

test("client-authored elements carry client authorship + a dashed affordance", () => {
  // The client_display name is dashed-underlined and marked client-authored.
  assert.match(src, CLIENT_NAME_RE, "client_display name must be the dashed, client-authored requester name");
  // The "client app" chip is dashed + client-tinted.
  assert.match(src, CLIENT_APP_CHIP_RE);
  // The dashed style is the non-color affordance for "claimed, not enforced".
  assert.match(src, DASHED_RE);
});

test("the client_claims commitments are client-authored and disclaimed as not enforced", () => {
  assert.match(src, COMMITMENTS_FN_RE);
  // Commitments block is client-classed with a dashed left rule.
  assert.match(src, COMMITMENTS_CLIENT_RULE_RE);
  // The "not enforced by your server" disclaimer is preserved.
  assert.match(src, NOT_ENFORCED_RE);
});

test("the purpose_description is client-authored", () => {
  assert.match(src, PURPOSE_CLIENT_RE);
});

test("manifest-authored stream rows carry manifest authorship + copper accent", () => {
  assert.match(src, REQUIRED_ROW_MANIFEST_RE);
  assert.match(src, OPTIONAL_ROW_MANIFEST_RE);
  assert.match(src, MANIFEST_EYEBROW_RE);
});

test("protocol facts carry protocol authorship + cool-blue tokens", () => {
  // Access duration (grant.access_mode) is an enforced protocol fact.
  assert.match(src, ACCESS_DURATION_PROTOCOL_RE);
  // Technical grant identifiers are protocol facts with the protocol left rule.
  assert.match(src, TECHNICAL_PROTOCOL_RULE_RE);
  // The verification verdict is the SERVER's, not a client claim → protocol,
  // and it must NOT borrow the client dashed affordance.
  assert.match(src, VERIFICATION_FN_RE);
  const verificationBadge = src.slice(
    src.indexOf("function VerificationBadge("),
    src.indexOf("function RequesterHeader(")
  );
  assert.doesNotMatch(
    verificationBadge,
    DASHED_RE,
    "the verification verdict is server-authored, never client-dashed"
  );
});

// ─── The authorship coding is rendered, not just commented ────────────────────

test("the card teaches its trust coding with a three-swatch legend", () => {
  assert.match(src, LEGEND_FN_RE);
  assert.match(src, LEGEND_SLOT_RE);
  assert.match(src, LEGEND_PROTOCOL_RE);
  assert.match(src, LEGEND_MANIFEST_RE);
  assert.match(src, LEGEND_CLIENT_RE);
  assert.match(src, LEGEND_RENDERED_RE);
});

test("all three authorship tiers are present (the boundary a reviewer points at)", () => {
  for (const tier of AUTHORSHIP_TIERS) {
    assert.match(src, TIER_RE[tier], `missing authorship tier: ${tier}`);
  }
});

// ─── No regression to inline styles or non-token color (the rebuild's point) ──

test("the consent card carries no inline style props (token-clean)", () => {
  assert.doesNotMatch(src, INLINE_STYLE_RE, "consent card must be inline-style-free; use tokens/utilities");
  // No raw oklch() literals left in the component — color lives in tokens.
  assert.doesNotMatch(src, RAW_OKLCH_RE, "no raw oklch literals; reference brand tokens instead");
});

// ─── Behavior preserved: multi-connection, the toggle, and all props ──────────

test("multi-connection grants still render one scope sub-row per connection", () => {
  assert.match(src, SCOPE_LIST_FN_RE);
  // The scope list is protocol-authored (server-resolved grant scope) and maps
  // every connection's owner-meaningful displayName.
  assert.match(src, SCOPE_LIST_PROTOCOL_RE);
  // It only appears when a stream covers more than one connection.
  assert.match(src, HAS_MULTI_RE);
  assert.match(src, SCOPE_LIST_RENDERED_RE);
});

test("the continuous/single_use access mode still drives the enforced-duration copy", () => {
  assert.match(src, ACCESS_MODE_COPY_RE);
});

test("the optional-stream toggle (switch) is preserved", () => {
  assert.match(src, TOGGLE_FN_RE);
  assert.match(src, TOGGLE_ROLE_RE);
  assert.match(src, TOGGLE_CHECKED_RE);
  assert.match(src, TOGGLE_HANDLER_RE);
});

test("the full ConsentCardProps contract is preserved (both apps consume unchanged)", () => {
  for (const prop of CONTRACT_PROPS) {
    assert.match(src, CONTRACT_PROP_RE[prop], `missing prop in destructure/contract: ${prop}`);
  }
  // The exported surface and superset connection type are intact.
  assert.match(src, EXPORT_FN_RE);
  assert.match(src, EXPORT_CONNECTION_RE);
  assert.match(src, EXPORT_STREAM_RE);
  assert.match(src, EXPORT_OPTIONAL_RE);
  assert.match(src, EXPORT_PROPS_RE);
});
