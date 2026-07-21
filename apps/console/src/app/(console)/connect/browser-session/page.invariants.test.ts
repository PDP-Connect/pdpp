/**
 * Source-regex guard for the owner-facing browser-session setup page.
 *
 * This page is for a normal owner trying to connect a browser-backed source.
 * Operator runbooks, internal browser service names, and repository paths belong
 * in diagnostics/operator surfaces, not in the primary setup journey.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}[connectorId]/page.tsx`;
const START_ROUTE_FILE = `${HERE}[connectorId]/start/route.ts`;
const LAUNCH_PANEL_FILE = `${HERE}[connectorId]/launch/launch-panel.tsx`;
const LAUNCH_START_ROUTE_FILE = `${HERE}[connectorId]/launch/start/route.ts`;

const SECURE_BROWSER_COPY_RE = /secure browser/;
const OPERATOR_ARTIFACT_RE = /browser-collector runbook|\bneko\b|n\.eko|hosted Chromium/;
const SERVER_ACTION_TRANSPORT_RE = /startBrowserEnrollmentAction|from "\.\/actions\.ts"|<form action=\{[^}]+Action/;
const POST_ROUTE_TRANSPORT_RE =
  /<form action=\{`\/connect\/browser-session\/\$\{encodeURIComponent\(connectorId\)\}\/start`\} method="post">/;
const PAGE_SETUP_DESCRIPTION_RE =
  /Create a new account here\. If you need to reconnect an existing source, go back to Sources and open that source's reconnect flow\./;
const PAGE_NEW_ACCOUNT_COPY_RE = /Create a new account/;
const PAGE_OPTIONAL_LABEL_RE = /Source label \(optional\)/;
const PAGE_DISPLAY_NAME_FIELD_RE = /name="display_name"/;
const PAGE_EXISTING_SOURCE_LINK_RE = /Choose an existing source/;
const START_ROUTE_POST_RE = /export async function POST/;
const START_ROUTE_AUTH_RE = /await requireDashboardAccess\(pagePath\(connectorId\)\)/;
const START_ROUTE_ORIGIN_RE = /if \(!originMatchesHost\(request\)\)/;
const START_ROUTE_CONNECTION_FIELD_RE = /readConnectionIdField\(formData\)/;
const START_ROUTE_DISPLAY_NAME_FIELD_RE = /readOptionalDisplayNameField\(formData\)/;
const START_ROUTE_SUPPORTED_BROWSER_RE = /isSupportedBrowserCollectorConnector\(connectorId\)/;
const START_ROUTE_CREATE_SHELL_RE = /createBrowserEnrollmentShell\(connectorId, \{ displayName \}\)/;
const START_ROUTE_DRAFT_ONE_RE = /draft: "1"/;
const START_ROUTE_UNSUPPORTED_REDIRECT_RE = /This browser-backed source is not available for self-service setup/;
const START_ROUTE_LAUNCH_REDIRECT_RE = /\$\{pagePath\(connectorId\)\}\/launch\?\$\{params\.toString\(\)\}/;
const START_ROUTE_FORBIDS_SLOW_RUN_RE = /runConnectionNow|abandonBrowserEnrollmentShell/;
const START_ROUTE_PUBLIC_ORIGIN_RE = /x-forwarded-host/;
const START_ROUTE_REDIRECT_RE = /NextResponse\.redirect\(new URL\(path, publicOrigin\(request\)\), 303\)/;
const PAGE_CONNECTION_ID_FIELD_RE = /browser-session-connection-id/;
const LAUNCH_PANEL_FETCH_RE =
  /fetch\(`\/connect\/browser-session\/\$\{encodeURIComponent\(connectorId\)\}\/launch\/start`/;
const LAUNCH_PANEL_RECOVER_RE =
  /fetch\(\s*`\/connect\/browser-session\/\$\{encodeURIComponent\(connectorId\)\}\/launch\/recover\?/;
const LAUNCH_PANEL_LOST_TRANSPORT_RECOVERY_RE = /recoverStartedBrowserRun\(connectorId, connectionId, 6\)/;
const LAUNCH_PANEL_INLINE_FAILURE_RE = /Browser session did not finish starting/;
const LAUNCH_PANEL_RUNS_FALLBACK_RE = /href="\/syncs"/;
const LAUNCH_START_ROUTE_RUN_RE = /runConnectionNow\(connectionId\)/;
const LAUNCH_START_ROUTE_CLEANUP_RE = /abandonBrowserEnrollmentShell\(connectionId\)/;
const LAUNCH_START_ROUTE_JSON_RE = /NextResponse\.json/;
const LAUNCH_RECOVER_ROUTE_FILE = `${HERE}[connectorId]/launch/recover/route.ts`;
const LAUNCH_RECOVER_ROUTE_LIST_RE = /listRuns\(\{ connector_id: connectorId, limit: 50 \}\)/;
const LAUNCH_RECOVER_ROUTE_CONNECTION_MATCH_RE = /run\.connector_instance_id === connectionId/;
const LAUNCH_RECOVER_ROUTE_STREAM_HREF_RE = /\/syncs\/\$\{encodeURIComponent\(run\.run_id\)\}\/stream/;

test("browser-session page does not send owners to operator/browser-service artifacts", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, SECURE_BROWSER_COPY_RE);
  assert.doesNotMatch(src, OPERATOR_ARTIFACT_RE);
});

test("browser-session setup page keeps the new-account form and reconnect escape hatch explicit", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, PAGE_SETUP_DESCRIPTION_RE);
  assert.match(src, PAGE_NEW_ACCOUNT_COPY_RE);
  assert.match(src, PAGE_EXISTING_SOURCE_LINK_RE);
  assert.match(src, PAGE_OPTIONAL_LABEL_RE);
  assert.match(src, PAGE_DISPLAY_NAME_FIELD_RE);
  assert.doesNotMatch(src, PAGE_CONNECTION_ID_FIELD_RE);
});

test("browser-session start uses a normal POST route, not Server Action fetch transport", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const route = await readFile(START_ROUTE_FILE, "utf8");

  assert.doesNotMatch(src, SERVER_ACTION_TRANSPORT_RE);
  assert.match(src, POST_ROUTE_TRANSPORT_RE);
  assert.match(route, START_ROUTE_POST_RE);
});

test("browser-session start route preserves auth and repair handoff semantics", async () => {
  const route = await readFile(START_ROUTE_FILE, "utf8");

  assert.match(route, START_ROUTE_AUTH_RE);
  assert.match(route, START_ROUTE_ORIGIN_RE);
  assert.match(route, START_ROUTE_CONNECTION_FIELD_RE);
  assert.match(route, START_ROUTE_DISPLAY_NAME_FIELD_RE);
  assert.match(route, START_ROUTE_SUPPORTED_BROWSER_RE);
  assert.match(route, START_ROUTE_CREATE_SHELL_RE);
  assert.match(route, START_ROUTE_DRAFT_ONE_RE);
  assert.match(route, START_ROUTE_UNSUPPORTED_REDIRECT_RE);
  assert.match(route, START_ROUTE_LAUNCH_REDIRECT_RE);
  assert.doesNotMatch(route, START_ROUTE_FORBIDS_SLOW_RUN_RE);
  assert.match(route, START_ROUTE_PUBLIC_ORIGIN_RE);
  assert.match(route, START_ROUTE_REDIRECT_RE);
});

test("browser-session launch page owns slow run-start and renders inline failure", async () => {
  const panel = await readFile(LAUNCH_PANEL_FILE, "utf8");
  const route = await readFile(LAUNCH_START_ROUTE_FILE, "utf8");

  assert.match(panel, LAUNCH_PANEL_FETCH_RE);
  assert.match(panel, LAUNCH_PANEL_INLINE_FAILURE_RE);
  assert.match(panel, LAUNCH_PANEL_RUNS_FALLBACK_RE);
  assert.match(route, START_ROUTE_AUTH_RE);
  assert.match(route, START_ROUTE_ORIGIN_RE);
  assert.match(route, LAUNCH_START_ROUTE_RUN_RE);
  assert.match(route, LAUNCH_START_ROUTE_CLEANUP_RE);
  assert.match(route, LAUNCH_START_ROUTE_JSON_RE);
});

test("browser-session launch recovers an already-started run after transport loss", async () => {
  const panel = await readFile(LAUNCH_PANEL_FILE, "utf8");
  const route = await readFile(LAUNCH_RECOVER_ROUTE_FILE, "utf8");

  assert.match(panel, LAUNCH_PANEL_RECOVER_RE);
  assert.match(panel, LAUNCH_PANEL_LOST_TRANSPORT_RECOVERY_RE);
  assert.match(route, LAUNCH_RECOVER_ROUTE_LIST_RE);
  assert.match(route, LAUNCH_RECOVER_ROUTE_CONNECTION_MATCH_RE);
  assert.match(route, LAUNCH_RECOVER_ROUTE_STREAM_HREF_RE);
});
