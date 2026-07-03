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
const SESSION_BOUND_PRECEDES_STATIC_SECRET =
  /if \(sessionBound\) \{[\s\S]{0,220}return browserSessionReconnectHref\(connectorId, connectorInstanceId \?\? connectionId\);[\s\S]{0,220}if \(staticSecretCapture !== null\) \{/;
// The static-secret update affordance is suppressed for a session-bound
// connection so a browser-session connection never offers a credential-capture
// button as its repair.
const STATIC_SECRET_UPDATE_CAPABILITY_GATED_ON_BINDING =
  /hasStaticSecretCredentialUpdate=\{staticSecretCapture !== null && !sessionBound\}/;
const STATIC_SECRET_UPDATE_LINK_VISIBLE = /credentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate/;
const REAUTH_USES_CREDENTIAL_UPDATE_HREF =
  /href=\{credentialUpdateHref \?\? addSourceHrefForConnector\(connectorId\)\}/;

test("detail-page repair routing is connection-binding-first (session repair before static-secret capture)", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, STATIC_SECRET_CAPTURE_RESOLVED_ONCE);
  assert.match(src, SESSION_BOUND_RESOLVED);
  assert.match(src, SESSION_BOUND_PRECEDES_STATIC_SECRET);
  assert.match(src, STATIC_SECRET_UPDATE_CAPABILITY_GATED_ON_BINDING);
  assert.match(src, STATIC_SECRET_UPDATE_LINK_VISIBLE);
  assert.match(src, REAUTH_USES_CREDENTIAL_UPDATE_HREF);
});
