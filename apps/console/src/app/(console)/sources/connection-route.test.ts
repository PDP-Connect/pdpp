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
