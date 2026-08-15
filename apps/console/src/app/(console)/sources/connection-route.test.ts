// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROUTE_FILE = `${HERE}connection-route.ts`;

// `resolveConnectionForRecordsRoute` is the single chokepoint every record
// subpage uses to turn a route param into one connection. Before scoping, it
// fetched the all-connector summary projection and filtered in the browser, so
// opening one connection's records page ran the per-connection fan-out for every
// configured connection. These guards pin the two properties the scoping fix
// depends on: (1) it asks the reference for ONLY the requested connection, and
// (2) it keeps exact connection identity ahead of the legacy connector-id
// fallback. Current references decide whether connector-id fallback is
// unambiguous server-side; the console fallback is defensive for older builds.

// The resolver must pass the route id through so the reference projects ONLY
// that connection (a 0-or-1 list)...
const SCOPED_SUMMARY_FETCH = /listConnectorSummaries\(\s*\{\s*connectionRouteId:\s*routeId\s*\}\s*\)/;
// ...and must NOT call the unscoped, all-connector form.
const UNSCOPED_SUMMARY_FETCH = /listConnectorSummaries\(\s*\)/;
// Exact match on connection / instance identity is preferred...
const IDENTITY_MATCH = /summary\.connection_id === routeId \|\| summary\.connector_instance_id === routeId/;
// ...then a connector_id fallback only for the single row the reference returned.
const CONNECTOR_ID_MATCH = /summary\.connector_id === routeId/;

function resolverBody(src: string): string {
  const start = src.indexOf("export async function resolveConnectionForRecordsRoute");
  assert.ok(start >= 0, "resolveConnectionForRecordsRoute must exist");
  const end = src.indexOf("export function connectorInstanceIdForConnection", start);
  assert.ok(end > start, "connectorInstanceIdForConnection must follow the resolver");
  return src.slice(start, end);
}

test("resolver scopes the summary fetch to the requested route id (no all-connector hydration)", async () => {
  const src = await readFile(ROUTE_FILE, "utf8");
  const body = resolverBody(src);
  assert.match(body, SCOPED_SUMMARY_FETCH);
  assert.doesNotMatch(body, UNSCOPED_SUMMARY_FETCH);
});

test("resolver preserves stable-identity-first precedence before legacy connector_id fallback", async () => {
  const src = await readFile(ROUTE_FILE, "utf8");
  const body = resolverBody(src);
  assert.match(body, IDENTITY_MATCH);
  assert.match(body, CONNECTOR_ID_MATCH);
  // The identity match must be written before the connector_id fallback so the
  // precedence is preserved (a `??` chain in source order).
  const identityIdx = body.indexOf("summary.connector_instance_id === routeId");
  const connectorIdIdx = body.indexOf("summary.connector_id === routeId");
  assert.ok(
    identityIdx >= 0 && connectorIdIdx > identityIdx,
    "stable-identity match must precede the connector_id fallback"
  );
});

// Regression: /sources/claude-test returned HTTP 200 rendering a Next.js 404
// (docs/inbox/redteam-slvp-findings.md P3 #6). Root cause: neither identity
// nor connector_id ever matched "claude-test" — its real connector_id is
// "claude-code", "claude-test" is only its display_name — so the resolver
// had no path to it at all. `/sources/gmail` etc. only ever worked by
// coincidence (connector_id === display slug).
const DISPLAY_NAME_FALLBACK_CALL = /return resolveByDisplayNameInFirstPage\(routeId\)/;
const DISPLAY_NAME_HELPER_SIGNATURE =
  /async function resolveByDisplayNameInFirstPage\(routeId: string\): Promise<RefConnectorSummary \| null>/;
const DISPLAY_NAME_CASE_INSENSITIVE = /\.toLowerCase\(\)/;
const DISPLAY_NAME_AMBIGUITY_GUARD = /matches\.length === 1/;
const DISPLAY_NAME_BOUNDED_PAGE = /listConnectorSummaries\(\s*\{\s*limit:\s*CONNECTOR_SUMMARY_PAGE_SIZE\s*\}\s*\)/;
const DISPLAY_NAME_GATED_FIRST_PICK = /matches\.length === 1 \? \(matches\[0\] \?\? null\) : null/;

test("resolver falls back to a display_name match when identity and connector_id both miss", async () => {
  const src = await readFile(ROUTE_FILE, "utf8");
  const body = resolverBody(src);
  assert.match(body, DISPLAY_NAME_FALLBACK_CALL);
  // The display_name fallback must be the LAST resort, after the identity
  // and connector_id chain, not a competing first guess.
  const connectorIdIdx = body.indexOf("summary.connector_id === routeId");
  const fallbackIdx = body.search(DISPLAY_NAME_FALLBACK_CALL);
  assert.ok(connectorIdIdx >= 0 && fallbackIdx > connectorIdIdx, "display_name fallback must come after connector_id");
});

test("display_name fallback matches case-insensitively within one bounded page, never an unbounded fan-out", async () => {
  const src = await readFile(ROUTE_FILE, "utf8");
  assert.match(src, DISPLAY_NAME_HELPER_SIGNATURE);
  assert.match(src, DISPLAY_NAME_CASE_INSENSITIVE);
  assert.match(src, DISPLAY_NAME_BOUNDED_PAGE);
});

test("display_name fallback resolves to null (not an arbitrary first pick) when two connections share a display name", async () => {
  const src = await readFile(ROUTE_FILE, "utf8");
  const start = src.indexOf("async function resolveByDisplayNameInFirstPage");
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf("export async function resolveConnectionForRecordsRoute"));
  assert.match(body, DISPLAY_NAME_AMBIGUITY_GUARD);
  // The only reference to `matches[0]` must be gated behind the length === 1
  // check on the same return line — never an unconditional first pick.
  assert.match(body, DISPLAY_NAME_GATED_FIRST_PICK);
});
