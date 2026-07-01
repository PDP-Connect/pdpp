import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DETAIL_PAGE = `${HERE}[connector]/page.tsx`;

const STATIC_SECRET_CAPTURE_RESOLVED_ONCE =
  /const staticSecretCapture = staticSecretCredentialCaptureFromManifest\(manifest\)/;
const STATIC_SECRET_UPDATE_PRECEDES_BROWSER_SESSION =
  /if \(staticSecretCapture !== null\) \{[\s\S]{0,180}return updateCredentialHref\(connectorId, connectorInstanceId \?\? connectionId\);[\s\S]{0,180}if \(isBrowserBoundConnector\(connectorId\)\) \{/;
const STATIC_SECRET_UPDATE_CAPABILITY_PASSED = /hasStaticSecretCredentialUpdate=\{staticSecretCapture !== null\}/;
const STATIC_SECRET_UPDATE_LINK_VISIBLE = /credentialUpdateHref && !revoked && hasStaticSecretCredentialUpdate/;
const REAUTH_USES_CREDENTIAL_UPDATE_HREF =
  /href=\{credentialUpdateHref \?\? addSourceHrefForConnector\(connectorId\)\}/;

test("detail-page reauth prefers stored-credential repair before browser-session fallback", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, STATIC_SECRET_CAPTURE_RESOLVED_ONCE);
  assert.match(src, STATIC_SECRET_UPDATE_PRECEDES_BROWSER_SESSION);
  assert.match(src, STATIC_SECRET_UPDATE_CAPABILITY_PASSED);
  assert.match(src, STATIC_SECRET_UPDATE_LINK_VISIBLE);
  assert.match(src, REAUTH_USES_CREDENTIAL_UPDATE_HREF);
});
