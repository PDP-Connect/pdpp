/**
 * Pins the honest handling of browser-bound connector deep-links on the
 * device-exporters enrollment page.
 *
 * The records-list "Add a connection" guidance deep-links the supported
 * local-collector set (`?connector=claude_code`/`codex`) into this form. Amazon
 * is the supported manual browser_collector proof-run path, so
 * `?connector=amazon` must prefill the form and render browser-specific runbook
 * guidance. Other browser-bound connectors must still render an honest notice
 * rather than silently falling back to the blank form.
 *
 * These are source-text structural invariants, matching the rest of the console
 * test suite (server components have no JSX render harness here). They fail if the
 * page regresses to swallowing a browser-bound deep-link or stops routing through
 * the shared source of truth.
 *
 * See connection-modality.ts and the records-list AddConnectionGuidance callout.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../../../../../", import.meta.url);

function read(relPath: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relPath, ROOT)), "utf8");
}

const PAGE_PATH = "apps/console/src/app/dashboard/device-exporters/page.tsx";

const USES_CLASSIFIER = /\bisBrowserBoundConnector\b/;
const USES_BROWSER_SUPPORTED_CLASSIFIER = /\bisSupportedBrowserCollectorConnector\b/;
const USES_RUNBOOK_CONST = /\bBROWSER_BOUND_RUNBOOK_PATH\b/;
const IMPORTS_FROM_MODALITY = /from "\.\.\/lib\/connection-modality\.ts"/;
const DEFAULT_INCLUDES_BROWSER_SUPPORTED =
  /isSupportedLocalCollectorConnector\(requestedConnector\)\s*\|\|\s*isSupportedBrowserCollectorConnector\(requestedConnector\)/;
const BROWSER_COLLECTOR_REQUEST = /const browserCollectorRequest = isSupportedBrowserCollectorConnector/;
const GATE_EXCLUDES_SUPPORTED = /!defaultConnectorId\s*&&\s*isBrowserBoundConnector\(requestedConnector\)/;
const RENDERS_BROWSER_COLLECTOR_NOTICE = /browserCollectorRequest\s*\?\s*<BrowserCollectorEnrollmentNotice/;
const RENDERS_NOTICE = /browserBoundRequest\s*\?\s*<BrowserBoundEnrollmentNotice/;
const RUNBOOK_TESTID = /data-testid="browser-bound-runbook-path"/;
const RENDERS_RUNBOOK_CONST = /{BROWSER_BOUND_RUNBOOK_PATH}/;
const MANUAL_BROWSER_TITLE = /Manual browser-collector setup/;
const HONEST_NO_ONE_CLICK = /does not advertise a one-click browser flow/;

test("page classifies a browser-bound deep-link via the shared modality classifier (no scattered key checks)", async () => {
  const src = await read(PAGE_PATH);
  // Both symbols must come from the shared connection-modality module so the
  // enroll surface and the records-list guidance tell the same story.
  assert.match(src, USES_CLASSIFIER, "page must use the shared isBrowserBoundConnector classifier");
  assert.match(
    src,
    USES_BROWSER_SUPPORTED_CLASSIFIER,
    "page must use the shared supported-browser-collector classifier"
  );
  assert.match(src, USES_RUNBOOK_CONST, "page must use the shared runbook path constant");
  assert.match(src, IMPORTS_FROM_MODALITY, "browser-bound symbols must come from the shared source of truth");
});

test("amazon browser-bound deep-link is supported and prefilled, while unsupported browser links stay gated", async () => {
  const src = await read(PAGE_PATH);
  assert.match(
    src,
    DEFAULT_INCLUDES_BROWSER_SUPPORTED,
    "default connector id must include the supported manual browser-collector set"
  );
  assert.match(src, BROWSER_COLLECTOR_REQUEST, "amazon-style requests must render browser-collector guidance");
  assert.match(
    src,
    GATE_EXCLUDES_SUPPORTED,
    "unsupported browser-bound notice must only fire after supported sets are excluded"
  );
});

test("amazon browser-bound deep-link renders manual setup guidance, not a faked one-click flow", async () => {
  const src = await read(PAGE_PATH);
  assert.match(
    src,
    RENDERS_BROWSER_COLLECTOR_NOTICE,
    "page must render manual browser-collector guidance for a supported browser-bound connector"
  );
  assert.match(src, RUNBOOK_TESTID, "the notice must expose a stable hook for the runbook path");
  assert.match(src, RENDERS_RUNBOOK_CONST, "the notice must render the shared runbook path constant");
  assert.match(src, MANUAL_BROWSER_TITLE, "the notice must name the manual browser-collector setup path");
  assert.match(src, HONEST_NO_ONE_CLICK, "the notice must stay honest that this is not a one-click browser flow");
});

test("unsupported browser-bound deep-link still renders an honest notice pointing at the runbook", async () => {
  const src = await read(PAGE_PATH);
  assert.match(
    src,
    RENDERS_NOTICE,
    "page must render the browser-bound notice when a browser-bound connector is requested"
  );
  assert.match(src, RUNBOOK_TESTID, "the notice must expose a stable hook for the runbook path");
  assert.match(src, RENDERS_RUNBOOK_CONST, "the notice must render the shared runbook path constant");
});

// ─── Add-connection landing framing ───────────────────────────────────────
//
// When the owner reaches this page from the records-list "Add connection"
// picker (a validated `?connector=` deep-link), the page must frame itself as
// finishing the connector they chose — a "Connections / Add <Connector>"
// breadcrumb gated on the already-validated `defaultConnectorId` — rather than
// reading purely as a "Local device exporters" diagnostics console. The bare
// page (no deep-link) keeps its existing header, so the breadcrumb must be
// derived from `defaultConnectorId`, not rendered unconditionally.

const BREADCRUMB_GATED_ON_DEFAULT_CONNECTOR = /const addConnectionBreadcrumbs = defaultConnectorId/;
const BREADCRUMB_LINKS_BACK_TO_CONNECTIONS = /label: "Connections", href: "\/dashboard\/records"/;
const BREADCRUMB_NAMES_THE_CHOSEN_CONNECTOR = /label: `Add \$\{formatConnectorKeyForDisplay\(defaultConnectorId\)\}`/;
const PAGE_HEADER_RENDERS_BREADCRUMB = /breadcrumbs=\{addConnectionBreadcrumbs\}/;

test("a validated add-connection deep-link frames the page as 'Connections / Add <Connector>'", async () => {
  const src = await read(PAGE_PATH);
  // The breadcrumb is derived from the already-validated connector key (never an
  // arbitrary `?connector=` value) and is only present on a deep-link landing.
  assert.match(src, BREADCRUMB_GATED_ON_DEFAULT_CONNECTOR);
  assert.match(src, BREADCRUMB_LINKS_BACK_TO_CONNECTIONS);
  assert.match(src, BREADCRUMB_NAMES_THE_CHOSEN_CONNECTOR);
  // And the header actually renders it.
  assert.match(src, PAGE_HEADER_RENDERS_BREADCRUMB);
});
