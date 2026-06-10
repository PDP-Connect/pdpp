/**
 * Source-IA acceptance invariants for the Sources / Connections first screen.
 *
 * These pin the owner's reported confusion so it cannot regress:
 *
 *   1. A blank/partial dashboard has an obvious Add-source path (not a grant
 *      CTA, not a dead end).
 *   2. The Sources first screen differentiates EXISTING data from ADD-NEW
 *      account support, and surfaces a repair/reconnect path — as separate
 *      facts, so a working source never reads as inert.
 *   3. The normal Sources UI shows no developer-only strings (monorepo paths,
 *      unpublished CLI, per-account env-var jargon, internal id placeholders).
 *   4. "Connect AI apps" is a clearly separate read-access surface, not
 *      confused with adding a data source.
 *
 * Source-regex over the shipped components, mirroring the existing
 * records-list-view / connect-page invariant style: these files are JSX/React
 * server components and cannot be imported under node:test without a full
 * resolver, so we assert their critical structural copy from source. Behavioral
 * grouping/support logic is covered by source-groups.test.ts and
 * source-add-support.test.ts.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VIEW_FILE = `${HERE}records-list-view.tsx`;
const RECORDS_PAGE_FILE = `${HERE}../../records/page.tsx`;
const SHELL_FILE = `${HERE}../shell.tsx`;
const CONNECT_PAGE_FILE = `${HERE}../../connect/page.tsx`;
const ADD_SUPPORT_FILE = `${HERE}../../lib/source-add-support.ts`;
const SOURCE_GROUPS_FILE = `${HERE}../../lib/source-groups.ts`;
const HERO_FILE = fileURLToPath(
  new URL("../../../../../../../packages/operator-ui/src/components/overview-hero.tsx", import.meta.url)
);

const ADD_CONNECTION_ACTION_RE = /data-testid="add-connection-action"/;
const ADD_SOURCE_LABEL_RE = /Add source/;
const ADD_CONNECTION_GATED_RE = /\{interactive \? \(\s*<Link[\s\S]*?data-testid="add-connection-action"/;
const SOURCE_SUMMARY_TESTID_RE = /data-testid="source-accounts-summary"/;
const YOUR_SOURCES_TITLE_RE = /title="Your sources"/;
const GROUP_SOURCES_CALL_RE = /groupSourcesByConnector\(/;
const SOURCE_EXISTING_STATE_RE = /data-testid="source-existing-state"/;
const ADD_ACCOUNT_SUPPORT_RE = /data-testid="add-account-support"/;
const SOURCE_ADD_ACCOUNT_ACTION_RE = /data-testid="source-add-account-action"/;
const SOURCE_RECONNECT_ACTION_RE = /data-testid="source-reconnect-action"/;
const SUPPORT_LABEL_BINDING_RE = /support\?\.supportLabel/;
const EXISTING_DATA_COPY_RE = /with data|no records yet/;
const TRACK_ONLY_RE = /Track only/;
const BUILD_ADD_SUPPORT_RE = /buildSourceAddSupport/;
const ADD_SUPPORT_PROP_RE = /addSupportByConnectorId/;
const CONNECTION_CATALOG_IMPORT_RE = /connection-catalog/;
const ADD_CONNECTION_GUIDANCE_RE = /AddConnectionGuidance/;
const FORBIDDEN_DEV_STRINGS_RE =
  /pnpm --dir|packages\/[a-z]|PDPP monorepo checkout|env var per account|pdpp owner-agent connectors|connector_instance_id|source_instance_id|device_token/;
const NAV_SOURCES_RE = /label: "Sources", match: \(a\) => a === "records"/;
const NAV_CONNECT_AI_APPS_RE = /label: "Connect AI apps", match: \(a\) => a === "connect"/;
const CONNECT_PAGE_TITLE_RE = /title="Connect AI apps"/;
const CONNECT_PAGE_DESCRIPTION_RE = /grant-scoped read access[\s\S]*?go to Sources/;

// ── 1. Blank/partial dashboard has an obvious Add-source path ───────────────

test("blank overview offers an Add-source CTA, not a grant CTA", async () => {
  const src = await readFile(HERO_FILE, "utf8");
  assert.ok(src.includes("addSourceHref"), "empty overview must accept an add-source target");
  assert.ok(src.includes("Add a data source"), "empty overview must name source setup");
  assert.ok(!src.includes("Start a grant to begin ingesting"), "a grant must not be the ingestion CTA");
});

test("Sources page header keeps a persistent interactive Add-source action", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, ADD_CONNECTION_ACTION_RE);
  assert.match(src, ADD_SOURCE_LABEL_RE);
  // Gated on interactive so the sandbox never shows a dead button.
  assert.match(src, ADD_CONNECTION_GATED_RE);
});

// ── 2. Existing data vs add-new support vs repair are distinct facts ────────

test("Sources page renders a per-source 'Your sources' summary", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  assert.match(src, SOURCE_SUMMARY_TESTID_RE);
  assert.match(src, YOUR_SOURCES_TITLE_RE);
  // Driven by the pure grouping + add-support projection, not an inline catalog.
  assert.match(src, GROUP_SOURCES_CALL_RE);
});

test("each source card keeps existing-data, add-account support, and repair as separate facts", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // (a) existing data/health state
  assert.match(src, SOURCE_EXISTING_STATE_RE);
  // (b) add-account support — a fact about adding ANOTHER account, separate chip
  assert.match(src, ADD_ACCOUNT_SUPPORT_RE);
  // (c) one primary action: add another account when self-service…
  assert.match(src, SOURCE_ADD_ACCOUNT_ACTION_RE);
  // …and a reconnect/repair path when a connection needs attention.
  assert.match(src, SOURCE_RECONNECT_ACTION_RE);
});

test("a working source is never labelled inert just because add-new is not self-service", async () => {
  const src = await readFile(VIEW_FILE, "utf8");
  // The add-account support label is rendered from the projection's
  // supportLabel, decoupled from the existing-state line — so a source with
  // data and a not-self-service add state shows both, never collapsing to a
  // single "unsupported" verdict.
  assert.match(src, SUPPORT_LABEL_BINDING_RE);
  // The existing-state line names the data it has independently of add support.
  assert.match(src, EXISTING_DATA_COPY_RE);
  // No inert "Track only"-style primary status anywhere in the view.
  assert.doesNotMatch(src, TRACK_ONLY_RE);
});

test("Sources page loads the add-account support projection, not the catalog picker", async () => {
  const src = await readFile(RECORDS_PAGE_FILE, "utf8");
  assert.match(src, BUILD_ADD_SUPPORT_RE);
  assert.match(src, ADD_SUPPORT_PROP_RE);
  // The Sources surface must not import the full Connect catalog picker — that
  // is the records-list-view guardrail; here we pin the page side too.
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
});
