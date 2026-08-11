// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PAGE_FILE = fileURLToPath(new URL("./static-secret/[connectorId]/page.tsx", import.meta.url));
const ACTION_FILE = fileURLToPath(new URL("./static-secret/[connectorId]/actions.ts", import.meta.url));
const STATUS_PAGE_FILE = fileURLToPath(new URL("./status/[connectionId]/page.tsx", import.meta.url));
const STATUS_LINKS_FILE = fileURLToPath(new URL("./status/[connectionId]/connect-status-links.ts", import.meta.url));
const LEGACY_STATUS_PAGE_FILE = fileURLToPath(
  new URL("./static-secret/[connectorId]/status/[connectionId]/page.tsx", import.meta.url)
);

// Hoisted to satisfy useTopLevelRegex; grouped by the surface they assert.
const GET_SETUP = /getStaticSecretSetup\(connectorId\)/;
// The form action is now mode-aware: createStaticSecretConnectionAction for new
// connections, replaceStaticSecretCredentialAction for credential-replace mode.
// Assert both are imported and referenced — the selector pattern is the invariant.
const FORM_ACTION_CREATE = /createStaticSecretConnectionAction/;
const FORM_ACTION_REPLACE = /replaceStaticSecretCredentialAction/;
const EXISTING_TARGET_ACTION = /action=\{hasExistingTarget \? replaceStaticSecretCredentialAction/;
const RETRY_CONNECTION_ID = /hasExistingTarget && pageParams\.connectionId/;
const DRAFT_RETRY_MODE = /draftRetry/;
const FIELDS_MAP = /formContract\.credentialFields\.map/;
// F2: native HTML `required` must not be hardcoded to the field's own flag —
// it must also fall back to false whenever the BLOCK-level
// credential_capture.required is false (BOTH-OR-NONE's blank-optional
// case), so the browser's own validation cannot block a submission the
// server-side buildStaticSecretPayload/validateBundledSecret contract
// already accepts.
const REQUIRED_HONORS_BLOCK_LEVEL_FACT =
  /required=\{setup\.credential_capture\.required !== false && field\.required\}/;
const NO_FIELD_ONLY_REQUIRED_ATTRIBUTE = /required=\{field\.required\}/;
const CONNECTION_NAME_FIELD = /name=\{formContract\.connectionName\.name\}/;
const CONNECTION_NAME_MAX_LENGTH = /maxLength=\{formContract\.connectionName\.maxLength\}/;
const HELP_URL = /field\.help_url/;
const NEW_TAB = /target="_blank"/;
const NOREFERRER = /rel="noreferrer"/;
const OPEN_HELP_COPY = /Open provider setup page in a new tab/;
const SECRET_BOUNDARY_COPY = /formContract\.credentialSectionDescription/;
const STORAGE_NOT_READY_COPY = /Credential storage is not ready/;
const RECONNECT_REPAIR_TITLE = /title: `Reconnect \$\{displayName\}`/;
const RECONNECT_REPAIR_SUBMIT = /formContract\.primaryActionLabel/;
const RETRY_COPY = /Retrying the same connection/;
const STALE_REPAIR_TITLE = /Update \$\{setup\.display_name\} credential/;
const STALE_REPAIR_SUBMIT = /Update credential and run sync/;
const NO_CONNECTOR_BRANCH = /connectorId\s*===/;
const NO_PROVIDER_COPY = /\bGmail\b|\bGitHub\b|app password|personal access token/i;
const NO_INGEST_COPY = /hidden until ingest accepts records/i;
const NO_ENV_VAR_COPY = /No deployment env var per account/;
const NO_TRANSIENT_NOTICE = /first_sync_started/;

const ACTION_USE_SERVER = /^"use server";/;
const REQUIRE_ACCESS = /await requireDashboardAccess\(/;
const CREATE_DRAFT = /createStaticSecretDraftConnection\(connectorId, setupFields, \{ displayName \}\)/;
const CAPTURE_SECRET = /captureStaticSecretCredential\(\{/;
const START_HELPER_IMPORT = /static-secret-start\.ts/;
const RUN_ID_AFTER_CAPTURE = /runIdAfterCapture\(/;
const RUN_START_HELPER = /runIdAfterCapture\([\s\S]{0,180}runConnectionNow/;
const CAPTURED_CONNECTION_ID = /const capturedConnectionId = captured\.connection_id/;
const CAPTURE_SETUP_FIELDS = /setupFields/;
const NO_AUTO_RESUME_FIELD_SUPPRESSION = /"auto_resume"\s+in\s+capture[\s\S]{0,120}return null/;
const TERMINAL_RETRY =
  /formRetryHrefWithConnectionId\(connectorId, draftConnectionId, errorMessage\(err\), setupFields/;
const STATUS_SURFACE_PATH = /\/connect\/status\//;
const STATUS_HREF_CALL = /statusHref\(/;
const NO_NOTICE_REDIRECT = /notice:\s*"first_sync_started"/;
const NO_LEGACY_BRANCH = /isStaticSecretConnector/;
const NO_SECRET_LOG = /console\.(log|error|warn)\([\s\S]*secret/;
const NO_BEARER = /Authorization:\s*`Bearer/;

const STATUS_FETCH = /getConnectionSetupStatus\(/;
const STATUS_SETUP_STATE = /setup_state/;
const STATUS_SETUP_MATERIAL = /setup_material/;
const STATUS_FAILED_STATE = /first_sync_failed/;
const STATUS_ZERO_YIELD_STATE = /first_sync_zero_yield/;
const STATUS_LAST_ERROR = /last_error/;
const STATUS_CONNECTION_ID = /connection_id/;
const STATUS_NOT_FOUND = /notFound\(\)/;
const STATUS_LIVE_POLLER = /<LivePoller enabled=\{status\.pending\} \/>/;
const STATUS_NO_PASSWORD_INPUT = /type="password"/;
const STATUS_NO_SECRET_INPUT = /name="secret"/;
const ROTATED_AT = /rotated_at/;
const CREDENTIAL_VERIFICATION_COPY = /A sync is running now to verify the updated credential/;
const NO_UNPROVEN_FIRST_SYNC_COPY = /The first sync accepted records/;
const LEGACY_REDIRECT = /\/connect\/status\/\$\{encodeURIComponent/;

// Browser-session (SSO/browser-only login, e.g. ChatGPT) setup-status branch:
// binding-first classification must reach both the copy and the CTA, never
// the generic static-secret "Setup material needed" / "Re-enter credential"
// path (see reference-implementation's setupKindForConnection).
const BROWSER_SESSION_KIND_CHECK = /setup_kind\s*===\s*"browser_session"/;
const AWAITING_BROWSER_LOGIN_STATE = /"awaiting_browser_login"/;
const BROWSER_SIGN_IN_HEADLINE = /Sign-in needed/;
const BROWSER_LAUNCH_HREF_PATH = /\/connect\/browser-session\/\$\{encoded\}\/launch/;
const BROWSER_LAUNCH_CONNECTION_ID_PARAM = /connection_id:\s*status\.connection_id/;
const BROWSER_LAUNCH_DRAFT_PARAM = /draft:\s*status\.status\s*===\s*"draft"\s*\?\s*"1"\s*:\s*"0"/;
const BROWSER_RETRY_LABEL_COPY = /Start browser setup again/;
const NO_GENERIC_BROWSER_COPY = /Setup material needed|Re-enter credential and retry|provider credential/i;
const NO_BROWSER_STATIC_SECRET_ROUTE = /\/connect\/static-secret\//;
const BROWSER_STATUS_START = "function describeBrowserSessionState";
const BROWSER_STATUS_END = "function describeState";
const SETUP_HREF_START = "export function setupHref";
const SETUP_HREF_END = "export function sourceDetailHref";
const BROWSER_HREF_START = 'if (status.setup_kind === "browser_session")';
const BROWSER_HREF_END =
  "const params = new URLSearchParams({ connection_id: status.connection_id });\n  return `/connect/static-secret/";
const RETRY_LABEL_START = "function retryLabel";
const RETRY_LABEL_END = "function displayValue";
// The static-secret branch (the default fallthrough of setupHref) MUST carry
// connection_id, or retry lands on createStaticSecretConnectionAction and
// mints an orphaned second draft instead of repairing the stuck one — the
// draft-deadlock regression this file exists to prevent.
const STATIC_SECRET_HREF_CONNECTION_ID_PARAM = /connection_id:\s*status\.connection_id/;
const STATIC_SECRET_HREF_RETURN = /return `\/connect\/static-secret\/\$\{encoded\}\?\$\{params\.toString\(\)\}`/;

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("static-secret page is an owner-session capture form, not an agent secret prompt", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, GET_SETUP);
  // Mode-aware form actions: both create (new connection) and replace (repair/edit) must be wired.
  assert.match(src, FORM_ACTION_CREATE);
  assert.match(src, FORM_ACTION_REPLACE);
  assert.match(src, EXISTING_TARGET_ACTION);
  assert.match(src, RETRY_CONNECTION_ID);
  assert.match(src, DRAFT_RETRY_MODE);
  assert.match(src, RETRY_COPY);
  assert.match(src, FIELDS_MAP);
  // F2: the native `required` attribute must be gated by the block-level
  // credential_capture.required fact, never the field's own `required`
  // alone — otherwise the browser silently blocks a blank submission the
  // server-side contract already accepts (Venmo's exact failure mode).
  assert.match(src, REQUIRED_HONORS_BLOCK_LEVEL_FACT);
  assert.doesNotMatch(src, NO_FIELD_ONLY_REQUIRED_ATTRIBUTE);
  assert.match(src, CONNECTION_NAME_FIELD);
  assert.match(src, CONNECTION_NAME_MAX_LENGTH);
  assert.match(src, HELP_URL);
  assert.match(src, NEW_TAB);
  assert.match(src, NOREFERRER);
  assert.match(src, OPEN_HELP_COPY);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.match(src, SECRET_BOUNDARY_COPY);
  assert.match(src, STORAGE_NOT_READY_COPY);
  assert.match(src, RECONNECT_REPAIR_TITLE);
  assert.match(src, RECONNECT_REPAIR_SUBMIT);
  assert.doesNotMatch(src, STALE_REPAIR_TITLE);
  assert.doesNotMatch(src, STALE_REPAIR_SUBMIT);
  assert.doesNotMatch(src, NO_INGEST_COPY);
  assert.doesNotMatch(src, NO_ENV_VAR_COPY);
  // The page must no longer carry a transient post-submit notice as the only
  // owner-visible state; that lifecycle now lives on the durable status page.
  assert.doesNotMatch(src, NO_TRANSIENT_NOTICE);
});

test("static-secret action redirects to the durable setup-status surface, not a transient notice", async () => {
  const src = await readFile(ACTION_FILE, "utf8");
  assert.match(src, ACTION_USE_SERVER);
  assert.match(src, REQUIRE_ACCESS);
  assert.match(src, GET_SETUP);
  assert.match(src, CREATE_DRAFT);
  assert.match(src, CAPTURE_SECRET);
  assert.match(src, START_HELPER_IMPORT);
  assert.match(src, RUN_ID_AFTER_CAPTURE);
  assert.match(src, RUN_START_HELPER);
  assert.match(src, CAPTURED_CONNECTION_ID);
  assert.match(src, CAPTURE_SETUP_FIELDS);
  assert.doesNotMatch(src, NO_AUTO_RESUME_FIELD_SUPPRESSION);
  // Success lands on the durable per-connection status surface, keyed on the
  // real connection id. A draft-created start failure returns to the repair
  // form instead of fabricating first_sync_pending with no run id.
  assert.match(src, STATUS_SURFACE_PATH);
  assert.match(src, STATUS_HREF_CALL);
  assert.match(src, TERMINAL_RETRY);
  assert.doesNotMatch(src, NO_NOTICE_REDIRECT);
  assert.doesNotMatch(src, NO_LEGACY_BRANCH);
  assert.doesNotMatch(src, NO_CONNECTOR_BRANCH);
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.doesNotMatch(src, NO_SECRET_LOG);
  assert.doesNotMatch(src, NO_BEARER);
});

test("durable setup-status page reads the connection-scoped status route and surfaces lifecycle + failure", async () => {
  const src = await readFile(STATUS_PAGE_FILE, "utf8");
  // Reads the durable, connection-scoped setup-status route.
  assert.match(src, STATUS_FETCH);
  // Surfaces the projected lifecycle (running/pending/failed/active) and the
  // identifiers the owner needs, with no provider-specific branches.
  assert.match(src, STATUS_SETUP_STATE);
  assert.match(src, STATUS_SETUP_MATERIAL);
  assert.match(src, STATUS_FAILED_STATE);
  assert.match(src, STATUS_ZERO_YIELD_STATE);
  assert.match(src, STATUS_LAST_ERROR);
  assert.match(src, STATUS_CONNECTION_ID);
  assert.match(src, ROTATED_AT);
  assert.match(src, CREDENTIAL_VERIFICATION_COPY);
  assert.doesNotMatch(src, NO_UNPROVEN_FIRST_SYNC_COPY);
  // 404s a missing connection rather than fabricating a status.
  assert.match(src, STATUS_NOT_FOUND);
  // Transitional setup status refreshes automatically while it remains pending.
  assert.match(src, STATUS_LIVE_POLLER);
  // No provider-specific copy and no secret-bearing input on a read-only
  // status surface (the status page never captures a credential).
  assert.doesNotMatch(src, NO_PROVIDER_COPY);
  assert.doesNotMatch(src, STATUS_NO_PASSWORD_INPUT);
  assert.doesNotMatch(src, STATUS_NO_SECRET_INPUT);
});

test("durable setup-status page carries a browser-session branch with secure-browser copy and a launch-path retry CTA", async () => {
  const src = await readFile(STATUS_PAGE_FILE, "utf8");
  const linksSrc = await readFile(STATUS_LINKS_FILE, "utf8");
  const browserStatus = sourceBlock(src, BROWSER_STATUS_START, BROWSER_STATUS_END);
  const setupHref = sourceBlock(linksSrc, SETUP_HREF_START, SETUP_HREF_END);
  const browserHref = sourceBlock(setupHref, BROWSER_HREF_START, BROWSER_HREF_END);
  const retryLabel = sourceBlock(src, RETRY_LABEL_START, RETRY_LABEL_END);
  assert.match(src, BROWSER_SESSION_KIND_CHECK);
  assert.match(src, AWAITING_BROWSER_LOGIN_STATE);
  assert.match(browserStatus, BROWSER_SIGN_IN_HEADLINE);
  // The retry CTA returns to the existing browser-session launch route with
  // connection_id + draft query, not the static-secret credential form.
  assert.match(browserHref, BROWSER_LAUNCH_HREF_PATH);
  assert.match(browserHref, BROWSER_LAUNCH_CONNECTION_ID_PARAM);
  assert.match(browserHref, BROWSER_LAUNCH_DRAFT_PARAM);
  assert.match(retryLabel, BROWSER_RETRY_LABEL_COPY);
  // The browser-specific blocks must never fall through to generic
  // credential-shaped copy or a static-secret route.
  assert.doesNotMatch(browserStatus, NO_GENERIC_BROWSER_COPY);
  assert.doesNotMatch(browserHref, NO_BROWSER_STATIC_SECRET_ROUTE);
  assert.match(setupHref, STATIC_SECRET_HREF_CONNECTION_ID_PARAM);
  assert.match(setupHref, STATIC_SECRET_HREF_RETURN);
});

test("legacy static-secret setup-status URL redirects to the generic setup-status surface", async () => {
  const src = await readFile(LEGACY_STATUS_PAGE_FILE, "utf8");
  assert.match(src, LEGACY_REDIRECT);
  assert.doesNotMatch(src, STATUS_FETCH);
});
