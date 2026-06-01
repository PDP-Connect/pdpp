/**
 * Unit + consistency tests for the console add-connection modality taxonomy.
 *
 * The module is pure TS (no JSX), so it imports directly in node --test. These
 * tests pin three things:
 *   1. the supported local-collector set matches the enrollment form's
 *      test-pinned `COLLECTOR_RUN_CONNECTORS` literal (no silent drift),
 *   2. the supported-connector type guard behaves,
 *   3. the unsupported modalities stay honest: every entry names its missing
 *      primitive, with Amazon excluded from the unsupported browser-bound bucket
 *      because it has a generated manual setup path.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_BOUND_CONNECTORS,
  BROWSER_BOUND_RUNBOOK_PATH,
  browserCollectorConnectorLabel,
  isBrowserBoundConnector,
  isSupportedBrowserCollectorConnector,
  isSupportedLocalCollectorConnector,
  localCollectorConnectorLabel,
  SUPPORTED_BROWSER_COLLECTOR_CONNECTORS,
  SUPPORTED_LOCAL_COLLECTOR_CONNECTORS,
  UNSUPPORTED_ADD_MODALITIES,
} from "./connection-modality.ts";

const COLLECTOR_RUN_CONNECTORS_LITERAL_RE = /COLLECTOR_RUN_CONNECTORS\s*=\s*\[([^\]]*)\]/;
const SURROUNDING_QUOTES_RE = /^["']|["']$/g;
const BROWSER_COLLECTOR_PRIMITIVE_RE = /browser-collector/;
const API_NETWORK_PRIMITIVE_RE = /implicitly on first ingest|API-connect/;
const AMAZON_RUNNER_PROFILE_RE = /Amazon is the current manual proof-run path/;
const GENERATED_SETUP_RE = /generate setup|generated setup/i;
const RUNBOOK_DOC_HEADING_RE = /Browser-Collector Proof Runbook/;

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

test("every supported connector has an owner-meaningful label", () => {
  for (const connectorId of SUPPORTED_LOCAL_COLLECTOR_CONNECTORS) {
    const label = localCollectorConnectorLabel(connectorId);
    assert.ok(label && label !== connectorId, `expected a friendly label for ${connectorId}, got ${label}`);
  }
  assert.equal(localCollectorConnectorLabel("claude_code"), "Claude Code");
  assert.equal(localCollectorConnectorLabel("codex"), "Codex");
  assert.equal(browserCollectorConnectorLabel("amazon"), "Amazon");
});

test("unsupported modalities are honest: each names a missing primitive", () => {
  assert.ok(UNSUPPORTED_ADD_MODALITIES.length >= 2);
  for (const entry of UNSUPPORTED_ADD_MODALITIES) {
    assert.ok(entry.missingPrimitive.trim().length > 0, `${entry.modality} must name its missing primitive`);
    assert.ok(entry.ownerFacingReason.trim().length > 0, `${entry.modality} must explain the gap to owners`);
    assert.notEqual(
      entry.ownerFacingReason,
      entry.missingPrimitive,
      `${entry.modality} must keep dashboard copy distinct from the technical primitive`
    );
    assert.ok(entry.examples.length > 0, `${entry.modality} must list recognizable examples`);
    // The supported local-collector path must never be listed as unsupported.
    assert.notEqual(entry.modality, "local_collector");
  }
});

test("browser-bound unsupported modality excludes Amazon because it has a manual console path", () => {
  const browserBound = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "browser_bound");
  assert.ok(browserBound, "a browser_bound unsupported modality must exist");
  assert.equal(browserBound.examples.includes("Amazon"), false);
  assert.match(browserBound.missingPrimitive, BROWSER_COLLECTOR_PRIMITIVE_RE);
});

test("browser-bound unsupported copy is scoped to connectors without generated setup steps", () => {
  // Amazon has a generated manual proof-run path. The remaining browser-bound
  // bucket is for connectors whose manifest classifies as browser-bound but for
  // which the console cannot yet generate connector-specific setup commands.
  const browserBound = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "browser_bound");
  assert.ok(browserBound);
  assert.match(browserBound.missingPrimitive, GENERATED_SETUP_RE);
  assert.match(browserBound.missingPrimitive, AMAZON_RUNNER_PROFILE_RE);
});

test("browser-bound modality points at the owner-run runbook that works today", () => {
  // The intent route and the console used to send the owner in a loop
  // ("add from the dashboard" <-> "not supported from the console"). The console
  // must point at the documented manual path that actually works today instead.
  const browserBound = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "browser_bound");
  assert.ok(browserBound);
  assert.equal(browserBound.runbookPath, "docs/operator/browser-collector-proof-runbook.md");
});

test("the browser-bound runbook path resolves to a committed doc", async () => {
  const browserBound = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "browser_bound");
  assert.ok(browserBound?.runbookPath, "browser_bound must carry a runbookPath");
  // This test file lives at apps/console/src/app/dashboard/lib/; the repo root is
  // six segments up (lib → dashboard → app → src → console → apps → root).
  // Resolve the runbook path against it and confirm the doc the copy points at is
  // real, not a dangling reference.
  const repoRoot = new URL("../../../../../../", import.meta.url);
  const runbookUrl = new URL(browserBound.runbookPath, repoRoot);
  const contents = await readFile(fileURLToPath(runbookUrl), "utf8");
  assert.match(contents, RUNBOOK_DOC_HEADING_RE);
});

test("api/network modality stays flatly unsupported with no runbook path", () => {
  // API/network sources have no owner connect route at all, so they must NOT
  // carry a runbookPath — only modalities whose primitive ships but whose
  // one-click flow is proof-gated get one.
  const apiNetwork = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "api_network");
  assert.ok(apiNetwork);
  assert.equal(apiNetwork.runbookPath, undefined);
});

test("api/network modality names the implicit-on-ingest gap", () => {
  const apiNetwork = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "api_network");
  assert.ok(apiNetwork, "an api_network unsupported modality must exist");
  assert.match(apiNetwork.missingPrimitive, API_NETWORK_PRIMITIVE_RE);
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

test("isBrowserBoundConnector also accepts the registry-URL fallback form", () => {
  // The RS summary canonicalizes first-party ids, but falls back to the raw
  // value when canonicalization fails. A URL-shaped id must still classify as
  // browser-bound so it cannot resurrect a dead Sync now.
  assert.equal(isBrowserBoundConnector("https://registry.pdpp.org/connectors/amazon"), true);
  assert.equal(isBrowserBoundConnector("https://registry.pdpp.org/connectors/chase/"), true);
  assert.equal(isBrowserBoundConnector("https://registry.pdpp.org/connectors/gmail"), false);
});

test("a browser-bound connector is never in the supported local-collector set", () => {
  for (const connectorId of BROWSER_BOUND_CONNECTORS) {
    assert.equal(isSupportedLocalCollectorConnector(connectorId), false);
  }
});

test("BROWSER_BOUND_RUNBOOK_PATH is the path the browser-bound modality surfaces", () => {
  const browserBound = UNSUPPORTED_ADD_MODALITIES.find((entry) => entry.modality === "browser_bound");
  assert.ok(browserBound);
  assert.equal(BROWSER_BOUND_RUNBOOK_PATH, "docs/operator/browser-collector-proof-runbook.md");
  assert.equal(browserBound.runbookPath, BROWSER_BOUND_RUNBOOK_PATH);
});
