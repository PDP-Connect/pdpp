/**
 * Unit + consistency tests for the console add-connection modality taxonomy.
 *
 * The module is pure TS (no JSX), so it imports directly in node --test. These
 * tests pin three things:
 *   1. the supported local-collector set matches the enrollment form's
 *      test-pinned `COLLECTOR_RUN_CONNECTORS` literal (no silent drift),
 *   2. the supported-connector type guard behaves,
 *   3. the browser-bound key set stays pinned to manifest bindings while source
 *      display/copy stays manifest-driven outside this module.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_BOUND_CONNECTORS,
  isBrowserBoundConnector,
  isBrowserSessionBoundConnection,
  isSupportedBrowserCollectorConnector,
  isSupportedLocalCollectorConnector,
  SUPPORTED_BROWSER_COLLECTOR_CONNECTORS,
  SUPPORTED_LOCAL_COLLECTOR_CONNECTORS,
} from "./connection-modality.ts";

const COLLECTOR_RUN_CONNECTORS_LITERAL_RE = /COLLECTOR_RUN_CONNECTORS\s*=\s*\[([^\]]*)\]/;
const SURROUNDING_QUOTES_RE = /^["']|["']$/g;

test("supported local-collector set is exactly claude_code and codex", () => {
  assert.deepEqual([...SUPPORTED_LOCAL_COLLECTOR_CONNECTORS], ["claude_code", "codex"]);
});

test("supported manual browser-collector set is exactly amazon", () => {
  assert.deepEqual([...SUPPORTED_BROWSER_COLLECTOR_CONNECTORS], ["amazon"]);
});

test("supported set matches the enrollment form's pinned COLLECTOR_RUN_CONNECTORS literal", async () => {
  // The enrollment form keeps a literal `COLLECTOR_RUN_CONNECTORS` array that
  // `enrollment-form.consistency.test.ts` pins. This module must stay in sync so
  // the records-list picker never offers a connector the enroll surface doesn't.
  const formSrc = await readFile(
    fileURLToPath(new URL("../device-exporters/enrollment-form.tsx", import.meta.url)),
    "utf8"
  );
  const match = formSrc.match(COLLECTOR_RUN_CONNECTORS_LITERAL_RE);
  assert.ok(match, "enrollment form must declare COLLECTOR_RUN_CONNECTORS");
  const formConnectors = (match[1] ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(SURROUNDING_QUOTES_RE, ""))
    .filter(Boolean);
  assert.deepEqual(formConnectors, [...SUPPORTED_LOCAL_COLLECTOR_CONNECTORS]);
});

test("isSupportedLocalCollectorConnector narrows only the supported keys", () => {
  assert.equal(isSupportedLocalCollectorConnector("claude_code"), true);
  assert.equal(isSupportedLocalCollectorConnector("codex"), true);
  assert.equal(isSupportedLocalCollectorConnector("amazon"), false);
  assert.equal(isSupportedLocalCollectorConnector("gmail"), false);
  assert.equal(isSupportedLocalCollectorConnector(""), false);
  assert.equal(isSupportedLocalCollectorConnector(null), false);
  assert.equal(isSupportedLocalCollectorConnector(undefined), false);
});

test("isSupportedBrowserCollectorConnector narrows only the generated manual browser path", () => {
  assert.equal(isSupportedBrowserCollectorConnector("amazon"), true);
  assert.equal(isSupportedBrowserCollectorConnector("https://registry.pdpp.org/connectors/amazon"), true);
  assert.equal(isSupportedBrowserCollectorConnector("chase"), false);
  assert.equal(isSupportedBrowserCollectorConnector("chatgpt"), false);
  assert.equal(isSupportedBrowserCollectorConnector("claude_code"), false);
  assert.equal(isSupportedBrowserCollectorConnector(""), false);
  assert.equal(isSupportedBrowserCollectorConnector(null), false);
  assert.equal(isSupportedBrowserCollectorConnector(undefined), false);
});

// ─── browser-bound connector classification ───────────────────────────────
//
// The records row cannot owner-sync a browser-bound connector (the run would
// fail), so the row classifies the class by connector key. The console has no
// manifest bindings at the records list, so it enumerates the key set — pinned
// against the committed manifests so it cannot drift from the real bindings.

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.org/connectors/";
const TRAILING_SLASH_RE = /\/$/;

/**
 * Canonical connector key for a manifest's URL-shaped `connector_id`, matching
 * `reference-implementation/server/connector-key.js` (registry prefix → bare
 * hyphenated slug). The records row receives this canonical key from the RS
 * connector summary (`canonicalizeConnectorId`), so the console's browser-bound
 * key set must equal the canonical keys of the browser-binding manifests.
 */
function canonicalKeyFromManifestId(connectorId: string): string {
  if (connectorId.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorId.slice(FIRST_PARTY_REGISTRY_PREFIX.length).replace(TRAILING_SLASH_RE, "");
  }
  return connectorId;
}

test("BROWSER_BOUND_CONNECTORS exactly matches the canonical keys of browser-binding manifests", async () => {
  // The backend intent route classifies `browser_bound` from a `browser`
  // binding (browser wins over a co-present network binding). The console key
  // set must equal the canonical keys of the connectors whose committed
  // manifest declares that binding — no more (a falsely-suppressed Sync now),
  // no less (a dead button that returns). Pinning against the manifests keeps
  // this from drifting from the real connector bindings.
  const repoRoot = new URL("../../../../../../", import.meta.url);
  const manifestsDir = new URL("packages/polyfill-connectors/manifests/", repoRoot);
  const files = await readdir(fileURLToPath(manifestsDir));
  const browserBoundFromManifests: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const raw = await readFile(fileURLToPath(new URL(file, manifestsDir)), "utf8");
    const manifest = JSON.parse(raw) as {
      connector_id?: string;
      runtime_requirements?: { bindings?: Record<string, unknown> | null } | null;
    };
    const bindings = manifest.runtime_requirements?.bindings;
    if (manifest.connector_id && bindings && Object.hasOwn(bindings, "browser")) {
      browserBoundFromManifests.push(canonicalKeyFromManifestId(manifest.connector_id));
    }
  }
  assert.deepEqual([...BROWSER_BOUND_CONNECTORS].sort(), browserBoundFromManifests.sort());
});

test("isBrowserBoundConnector narrows only the browser-bound keys", () => {
  assert.equal(isBrowserBoundConnector("amazon"), true);
  assert.equal(isBrowserBoundConnector("chase"), true);
  assert.equal(isBrowserBoundConnector("chatgpt"), true);
  assert.equal(isBrowserBoundConnector("claude_code"), false);
  assert.equal(isBrowserBoundConnector("gmail"), false);
  assert.equal(isBrowserBoundConnector(""), false);
  assert.equal(isBrowserBoundConnector(null), false);
  assert.equal(isBrowserBoundConnector(undefined), false);
});

test("isBrowserSessionBoundConnection classifies a connection by its source-binding kind, not the connector", () => {
  // Browser-session bindings repair by session repair, NOT static-secret capture,
  // even for a connector (like chatgpt) that also supports a username_password.
  assert.equal(isBrowserSessionBoundConnection("browser_collector"), true);
  assert.equal(isBrowserSessionBoundConnection("browser_enrollment_shell"), true);
  // Static-secret / account bindings are NOT session-bound → credential capture.
  assert.equal(isBrowserSessionBoundConnection("static_secret_draft"), false);
  assert.equal(isBrowserSessionBoundConnection("account"), false);
  assert.equal(isBrowserSessionBoundConnection("default_account"), false);
  assert.equal(isBrowserSessionBoundConnection(null), false);
  assert.equal(isBrowserSessionBoundConnection(undefined), false);
});

test("isBrowserBoundConnector also accepts the registry-URL fallback form", () => {
  // The RS summary canonicalizes first-party ids, but falls back to the raw
  // value when canonicalization fails. A URL-shaped id must still classify as
  // browser-bound for setup/enrollment guidance.
  assert.equal(isBrowserBoundConnector("https://registry.pdpp.org/connectors/amazon"), true);
  assert.equal(isBrowserBoundConnector("https://registry.pdpp.org/connectors/chase/"), true);
  assert.equal(isBrowserBoundConnector("https://registry.pdpp.org/connectors/gmail"), false);
});

test("a browser-bound connector is never in the supported local-collector set", () => {
  for (const connectorId of BROWSER_BOUND_CONNECTORS) {
    assert.equal(isSupportedLocalCollectorConnector(connectorId), false);
  }
});
