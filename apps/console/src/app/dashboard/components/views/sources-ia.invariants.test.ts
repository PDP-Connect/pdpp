/**
 * Source-IA acceptance invariants for the Sources / Connections first screen.
 *
 * These pin the owner's reported confusion so it cannot regress:
 *
 *   1. A blank/partial dashboard has an obvious Add-source path (not a grant
 *      CTA, not a dead end).
 *   2. The Sources first screen shows per-source health and surfaces Sync,
 *      Reauthorize, and Revoke as separate, clearly-labeled actions.
 *   3. The normal Sources UI shows no developer-only strings (monorepo paths,
 *      unpublished CLI, per-account env-var jargon, internal id placeholders).
 *   4. "Connect AI apps" is a clearly separate read-access surface, not
 *      confused with adding a data source.
 *
 * Source-regex over the shipped components (sources-view.tsx + surrounding
 * pages/shell): these files are JSX/React components and cannot be imported
 * under node:test without a full resolver, so we assert their critical
 * structural copy from source.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// VIEW_FILE is now the live Ink Carbon sources view (replaced records-list-view.tsx).
const VIEW_FILE = fileURLToPath(new URL("../../records/sources-view.tsx", import.meta.url));
const RECORDS_PAGE_FILE = `${HERE}../../records/page.tsx`;
const RECORDS_ADD_PAGE_FILE = `${HERE}../../records/add/page.tsx`;
const ROUTES_FILE = fileURLToPath(
  new URL("../../../../../../../packages/operator-ui/src/components/views/routes.ts", import.meta.url)
);
const SHELL_FILE = `${HERE}../shell.tsx`;
const CONNECT_PAGE_FILE = `${HERE}../../connect/page.tsx`;
const SOURCE_SETUP_CATALOG_FILE = `${HERE}../source-setup-catalog.tsx`;
const ADD_SUPPORT_FILE = `${HERE}../../lib/source-add-support.ts`;
const SOURCE_SETUP_PRESENTATION_FILE = `${HERE}../../lib/source-setup-presentation.ts`;
const SOURCE_GROUPS_FILE = `${HERE}../../lib/source-groups.ts`;
const HERO_FILE = fileURLToPath(
  new URL("../../../../../../../packages/operator-ui/src/components/overview-hero.tsx", import.meta.url)
);

const ROUTES_ADD_SOURCE_RE = /addSource: `\$\{basePath\}\/records\/add`/;
// sources-view.tsx add-source path (the empty-state and footer links both point here)
const ADD_SOURCE_HREF_CONST_RE = /ADD_SOURCE_HREF = "\/dashboard\/records\/add"/;
const ADD_SOURCE_LINK_RE = /href=\{ADD_SOURCE_HREF\}/;
const ADD_SOURCE_EMPTY_STATE_RE = /data-testid="sources-empty"/;
// Health status is rendered as a status dot + sr-only label from the projection
const SOURCE_STATUS_DOT_RE = /data-tone=\{instance\.status\.tone\}/;
const SOURCE_STATUS_LABEL_SR_RE = /instance\.status\.label/;
const RENDERED_VERDICT_STATUS_RE = /deriveRenderedSourceStatus\(summary\.rendered_verdict/;
const RENDERED_VERDICT_ACTION_RE = /formatRenderedRequiredAction\(summary\.rendered_verdict\)/;
const INSPECTION_LAYER_FIELDS_RE = /detail_gap_backlog|next_attempt_at|collection_rate|suppressed/;
// Sync, Reauthorize, and Revoke are three separate actions in the passport foot
const SYNC_ACTION_RE = /Sync now/;
const REAUTHORIZE_ACTION_RE = /Reauthorize/;
const MANUAL_UPLOAD_ADD_EXPORT_RE = /Add another export/;
const MANUAL_UPLOAD_REPROCESS_RE = /Reprocess all exports/;
const MANUAL_UPLOAD_DETAILS_RE = /Source details/;
const MANUAL_UPLOAD_CONNECTION_ID_PARAM_RE = /connection_id/;
const REVOKE_ACTION_RE = /data-testid="sources-revoke-ceremony"/;
// The view does not render the raw action_target spine field — it routes via detailHref
const RAW_ACTION_TARGET_RE = /href=\{.*action_target/;
// No inline source-catalog picker in the view — that belongs to /records/add
const CONNECTION_CATALOG_IMPORT_RE = /connection-catalog/;
const ADD_CONNECTION_GUIDANCE_RE = /AddConnectionGuidance/;
// The sources page must load toSourcesView, not a raw catalog
const TO_SOURCES_VIEW_RE = /toSourcesView/;
const SOURCES_VIEW_COMPONENT_RE = /<SourcesView/;
const LIST_CONNECTOR_MANIFESTS_RE = /listConnectorManifests\(\)/;
const BUILD_CONNECTOR_CATALOG_RE = /buildConnectorCatalog\(manifests\)/;
const SOURCE_SETUP_CATALOG_RE = /<SourceSetupCatalog/;
const SOURCE_SETUP_SECTION_RE = /title="Add data sources"/;
const SOURCE_SEARCH_RE = /name="source_q"[\s\S]*?Search source name or connector key/;
const SOURCE_CARD_RE = /data-testid=\{`source-setup-\$\{entry\.connectorKey\}`\}/;
const SOURCE_ACQUISITION_PATHS_RE = /data-testid="source-acquisition-paths"/;
const SOURCE_ACQUISITION_PATH_RE = /data-testid="source-acquisition-path"/;
const OTHER_COVERAGE_PATHS_RE = /Other ways to add coverage/;
const SOURCE_PROVIDER_SPECIFIC_COPY_RE =
  /\b(Amazon|Gmail|GitHub|Slack|ChatGPT|Chase|Notion|Spotify)\b|app password|personal access token/i;
const FORBIDDEN_DEV_STRINGS_RE =
  /pnpm --dir|packages\/[a-z]|PDPP monorepo checkout|env var per account|pdpp owner-agent connectors|connector_instance_id|source_instance_id|device_token/;
const NAV_SOURCES_RE = /label: "Sources", match: \(a\) => a === "records"/;
const NAV_CONNECT_AI_APPS_RE = /label: "Connect AI apps", match: \(a\) => a === "connect"/;
const CONNECT_PAGE_TITLE_RE = /title="Connect AI apps"/;
const CONNECT_PAGE_DESCRIPTION_RE = /grant-scoped read access[\s\S]*?go to Sources/;

// ── 1. Blank/partial dashboard has an obvious Add-source path ───────────────

test("blank overview offers an Add-source CTA, not a grant CTA", async () => {
  const src = await readFile(HERO_FILE, "utf8");
  const routes = await readFile(ROUTES_FILE, "utf8");
  assert.ok(src.includes("addSourceHref"), "empty overview must accept an add-source target");
  assert.ok(src.includes("Add a data source"), "empty overview must name source setup");
  assert.ok(!src.includes("Start a grant to begin ingesting"), "a grant must not be the ingestion CTA");
  assert.match(routes, ROUTES_ADD_SOURCE_RE);
});

test("Sources view always links to the add-source route, including when empty", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The add-source href is a module-level constant — not baked into routes.section
  // (sources-view is a client component that can't import server-side routes helpers).
  assert.match(src, ADD_SOURCE_HREF_CONST_RE);
  // Both the empty-state link and the footer link use it.
  assert.match(src, ADD_SOURCE_LINK_RE);
  // The empty state is clearly identified so tests + E2E can target it.
  assert.match(src, ADD_SOURCE_EMPTY_STATE_RE);
});

test("Sources owns the add-source catalog route", async () => {
  const page = await readFile(RECORDS_ADD_PAGE_FILE, "utf8");
  const catalog = await readFile(SOURCE_SETUP_CATALOG_FILE, "utf8");
  assert.match(page, LIST_CONNECTOR_MANIFESTS_RE);
  assert.match(page, BUILD_CONNECTOR_CATALOG_RE);
  assert.match(page, SOURCE_SETUP_CATALOG_RE);
  assert.match(catalog, SOURCE_SETUP_SECTION_RE);
  assert.match(catalog, SOURCE_SEARCH_RE);
  assert.match(catalog, SOURCE_CARD_RE);
  assert.match(catalog, SOURCE_ACQUISITION_PATHS_RE);
  assert.match(catalog, SOURCE_ACQUISITION_PATH_RE);
  assert.match(catalog, OTHER_COVERAGE_PATHS_RE);
});

// ── 2. Per-source health and actions are clearly separate ───────────────────

test("each source row renders a health status dot and sr-only label from the projection", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // Health comes from the projection (status.tone, status.label) — not hard-coded strings.
  assert.match(src, SOURCE_STATUS_DOT_RE);
  assert.match(src, SOURCE_STATUS_LABEL_SR_RE);
});

test("Sources projection reads rendered verdict status/action and keeps inspection fields off the dashboard", async () => {
  const model = await readFile(`${HERE}../../records/sources-view-model.ts`, "utf8");
  const view = await readFile(VIEW_FILE, "utf8");
  assert.match(model, RENDERED_VERDICT_STATUS_RE);
  assert.match(model, RENDERED_VERDICT_ACTION_RE);
  assert.doesNotMatch(view, INSPECTION_LAYER_FIELDS_RE);
});

test("the sources passport foot has three distinct actions: Sync, Reauthorize, and Revoke", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // (a) Sync — remotely trigger a collection run
  assert.match(src, SYNC_ACTION_RE);
  // (b) Reauthorize — link to connection detail (never a stub mutation at the index level)
  assert.match(src, REAUTHORIZE_ACTION_RE);
  // (c) Revoke — destructive, behind a confirm ceremony
  assert.match(src, REVOKE_ACTION_RE);
  // The next_action CTA never links to the raw action_target spine field —
  // it always routes via the in-app detailHref.
  assert.doesNotMatch(src, RAW_ACTION_TARGET_RE);
});

test("manual/upload sources present import actions, not generic sync or reauthorize copy", async () => {
  const view = await readFile(VIEW_FILE, "utf8");
  const model = await readFile(`${HERE}../../records/sources-view-model.ts`, "utf8");
  assert.match(view, MANUAL_UPLOAD_ADD_EXPORT_RE);
  assert.match(view, MANUAL_UPLOAD_REPROCESS_RE);
  assert.match(view, MANUAL_UPLOAD_DETAILS_RE);
  assert.match(model, MANUAL_UPLOAD_CONNECTION_ID_PARAM_RE);
});

test("Sources page projects through toSourcesView, not the full catalog picker", async () => {
  const records = await readFile(RECORDS_PAGE_FILE, "utf8");
  // page.tsx drives the view through toSourcesView (pure projection, no catalog).
  assert.match(records, TO_SOURCES_VIEW_RE);
  assert.match(records, SOURCES_VIEW_COMPONENT_RE);
  // The first screen must not import the full add-source catalog picker — that
  // belongs to /dashboard/records/add so existing-source monitoring stays light.
  const view = await readFile(VIEW_FILE, "utf8");
  assert.doesNotMatch(view, CONNECTION_CATALOG_IMPORT_RE);
  assert.doesNotMatch(view, ADD_CONNECTION_GUIDANCE_RE);
});

// ── 3. No developer-only strings in the normal Sources UI ───────────────────

test("the Sources view contains no developer-only command or id strings", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.doesNotMatch(src, FORBIDDEN_DEV_STRINGS_RE);
});

test("the add-account support projection contains no developer-only strings", async () => {
  const helper = await readFile(ADD_SUPPORT_FILE, "utf8");
  const groups = await readFile(SOURCE_GROUPS_FILE, "utf8");
  assert.doesNotMatch(helper, FORBIDDEN_DEV_STRINGS_RE);
  assert.doesNotMatch(groups, FORBIDDEN_DEV_STRINGS_RE);
});

test("source setup presentation has no connector-specific copy or examples", async () => {
  const src = await readFile(SOURCE_SETUP_PRESENTATION_FILE, "utf8");
  assert.doesNotMatch(src, SOURCE_PROVIDER_SPECIFIC_COPY_RE);
  assert.doesNotMatch(src, FORBIDDEN_DEV_STRINGS_RE);
});

// ── 4. "Connect AI apps" is a separate read-access surface ──────────────────

test("the nav names the inbound client surface 'Connect AI apps', distinct from Sources", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  // The data on-ramp nav item is "Sources" (→ records).
  assert.match(src, NAV_SOURCES_RE);
  // The inbound-client nav item is unambiguously named, never bare "Connect".
  assert.match(src, NAV_CONNECT_AI_APPS_RE);
});

test("the Connect page is identified as AI-app read access, pointing data setup at Sources", async () => {
  const src = await readFile(CONNECT_PAGE_FILE, "utf8");
  assert.match(src, CONNECT_PAGE_TITLE_RE);
  // Its description leads with read access and explicitly redirects source
  // setup to Sources, so the two "connect" meanings never collide.
  assert.match(src, CONNECT_PAGE_DESCRIPTION_RE);
  assert.doesNotMatch(src, LIST_CONNECTOR_MANIFESTS_RE);
  assert.doesNotMatch(src, SOURCE_SETUP_SECTION_RE);
});
