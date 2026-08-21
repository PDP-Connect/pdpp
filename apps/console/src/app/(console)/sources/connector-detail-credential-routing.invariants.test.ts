// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DETAIL_PAGE = `${HERE}[connector]/page.tsx`;

const STATIC_SECRET_CAPTURE_RESOLVED_ONCE =
  /const staticSecretCapture = staticSecretCredentialCaptureFromManifest\(manifest\)/;
// Binding-first: the connection's browser-session binding is resolved and
// checked BEFORE the connector-level static-secret capability. A browser-session
// connection reconnects its session; only a NON-session connection routes to
// static-secret capture (even when the connector supports a static secret).
const SESSION_BOUND_RESOLVED = /const sessionBound = isBrowserSessionBoundConnection\(sourceBindingKind\)/;
// The stored-credential and browser-session repair hrefs are resolved up front,
// and the compatibility `credentialUpdateHref` fallback prefers the session
// reconnect for a session-bound connection before static-secret capture.
const STORED_CREDENTIAL_HREF_RESOLVED =
  /const storedCredentialUpdateHref =\s*staticSecretCapture === null \? null : updateCredentialHref\(connectorId, repairConnectionId\)/;
const BROWSER_SESSION_HREF_RESOLVED =
  /const browserSessionRepairHref =\s*sessionBound \|\| isBrowserBoundConnector\(connectorId\)\s*\? browserSessionReconnectHref\(connectorId, repairConnectionId\)/;
const SESSION_BOUND_PRECEDES_STATIC_SECRET =
  /if \(sessionBound\) \{[\s\S]{0,120}return browserSessionRepairHref;[\s\S]{0,120}if \(storedCredentialUpdateHref !== null\) \{/;
// The static-secret update affordance is suppressed for a session-bound
// connection AND whenever the rendered action's own surface says the repair is
// stored-credential capture (so the server-owned surface, not a second guess,
// drives the button). A browser-session connection never offers a
// credential-capture button as its repair.
const STATIC_SECRET_UPDATE_CAPABILITY_GATED_ON_BINDING_AND_SURFACE =
  /hasStaticSecretCredentialUpdate=\{\s*storedCredentialUpdateHref !== null && !sessionBound && primaryActionSurface !== "stored_credential"\s*\}/;
const STATIC_SECRET_UPDATE_LINK_VISIBLE = /storedCredentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate/;
// The rendered `reauth` action routes by the server-owned owner-action surface,
// not by connector-manifest capability alone.
const PRIMARY_ACTION_SURFACE_READ = /const primaryActionSurface = connectionPrimaryAction\?\.surface\?\.kind \?\? null/;
const REAUTH_ROUTES_BY_SURFACE = /switch \(action\.surface\?\.kind\) \{/;
const REAUTH_STORED_CREDENTIAL_ROUTE =
  /case "stored_credential":[\s\S]{0,160}href: storedCredentialUpdateHref \?\? fallbackHref/;
const REAUTH_BROWSER_SESSION_ROUTE =
  /case "browser_session":[\s\S]{0,160}href: browserSessionRepairHref \?\? fallbackHref/;
// Static-secret repair copy says "Update credential", not a generic reconnect.
const STORED_CREDENTIAL_COPY_IS_UPDATE = /label: "Update credential"/;
// Compatibility: older payloads without a surface still route through the
// legacy credentialUpdateHref fallback.
const REAUTH_FALLBACK_FOR_OLD_PAYLOADS =
  /const fallbackHref = credentialUpdateHref \?\? addSourceHrefForConnector\(connectorId\)/;

test("detail-page repair routing is connection-binding-first (session repair before static-secret capture)", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, STATIC_SECRET_CAPTURE_RESOLVED_ONCE);
  assert.match(src, SESSION_BOUND_RESOLVED);
  assert.match(src, STORED_CREDENTIAL_HREF_RESOLVED);
  assert.match(src, BROWSER_SESSION_HREF_RESOLVED);
  assert.match(src, SESSION_BOUND_PRECEDES_STATIC_SECRET);
  assert.match(src, STATIC_SECRET_UPDATE_CAPABILITY_GATED_ON_BINDING_AND_SURFACE);
  assert.match(src, STATIC_SECRET_UPDATE_LINK_VISIBLE);
});

// A recovered historical-archive row (paused, never revoked) surfaces ONE
// reconnect notice, reusing the SAME `credentialUpdateHref` repair routes
// resolve above — no separate resume button/action (a recovered row typically
// has no surviving credential; resuming without one would just fail on the
// next run).
// The gate is now expressed in two steps — a general `paused` lifecycle flag
// (shared with the plain Resume action, which every OTHER paused row gets)
// narrowed by the archive binding kind. The invariant is unchanged: an
// archive row is gated on being paused, non-revoked, AND historical_archive.
const PAUSED_GATE = /const paused = !revoked && overview\.connectionStatus === "paused"/;
const PAUSED_HISTORICAL_ARCHIVE_GATE =
  /const pausedHistoricalArchive = paused && sourceBindingKind === "historical_archive"/;
const PAUSED_HISTORICAL_ARCHIVE_SECTION_RENDERED =
  /pausedHistoricalArchive \? <PausedHistoricalArchiveSection credentialUpdateHref=\{credentialUpdateHref\} \/> : null/;
const PAUSED_HISTORICAL_ARCHIVE_SECTION_HAS_NO_RESUME_ACTION =
  /function PausedHistoricalArchiveSection\(\{ credentialUpdateHref \}: \{ credentialUpdateHref: string \| null \}\) \{[\s\S]{0,400}href=\{credentialUpdateHref\}/;
// A paused row that is NOT a recovered archive gets the plain Resume action;
// an actively-collecting row gets Pause. Both post to their owner-session
// server action, so the console's pause/resume cycle is closed.
const PAUSED_RESUMABLE_GATE = /const pausedResumable = paused && !pausedHistoricalArchive/;
const PAUSED_CONNECTION_SECTION_RENDERED =
  /pausedResumable \? <PausedConnectionSection connectionId=\{renameSelector\} \/> : null/;
const PAUSED_CONNECTION_SECTION_POSTS_RESUME =
  /function PausedConnectionSection\([\s\S]{0,600}<form action=\{resumeConnectionAction\}>/;
const PAUSABLE_GATE = /const pausable = !\(revoked \|\| paused\) && overview\.connectionStatus === "active"/;
const PAUSE_CONNECTION_SECTION_POSTS_PAUSE =
  /function PauseConnectionSection\([\s\S]{0,600}<form action=\{pauseConnectionAction\}>/;

test("detail-page rendered reauth routes and labels by the server-owned action surface", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, PRIMARY_ACTION_SURFACE_READ);
  assert.match(src, REAUTH_ROUTES_BY_SURFACE);
  assert.match(src, REAUTH_STORED_CREDENTIAL_ROUTE);
  assert.match(src, REAUTH_BROWSER_SESSION_ROUTE);
  assert.match(src, STORED_CREDENTIAL_COPY_IS_UPDATE);
  assert.match(src, REAUTH_FALLBACK_FOR_OLD_PAYLOADS);
});

test("a recovered historical-archive row surfaces one reconnect notice, no separate resume action", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, PAUSED_GATE);
  assert.match(src, PAUSED_HISTORICAL_ARCHIVE_GATE);
  assert.match(src, PAUSED_HISTORICAL_ARCHIVE_SECTION_RENDERED);
  // Still the archive journey's ONLY action: repair the credential. A bare
  // resume would flip the row to active and then fail on the next run,
  // because a recovered archive typically carries no surviving credential.
  assert.match(src, PAUSED_HISTORICAL_ARCHIVE_SECTION_HAS_NO_RESUME_ACTION);
});

// The complement of the archive case: every OTHER paused row — notably one
// the owner paused deliberately — must get a real Resume action, or pausing
// from the console would be a one-way door.
test("a non-archive paused row surfaces a real resume action, and an active row a pause action", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, PAUSED_RESUMABLE_GATE);
  assert.match(src, PAUSED_CONNECTION_SECTION_RENDERED);
  assert.match(src, PAUSED_CONNECTION_SECTION_POSTS_RESUME);
  assert.match(src, PAUSABLE_GATE);
  assert.match(src, PAUSE_CONNECTION_SECTION_POSTS_PAUSE);
});
