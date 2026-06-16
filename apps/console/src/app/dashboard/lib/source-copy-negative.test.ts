/**
 * Negative-copy regression harness for owner-facing Sources strings.
 *
 * This is the test that would have caught Defect 1 before it shipped: the
 * overruled "not self-service yet" demotion copy. It pins the agreed label set
 * (`owner-journey-slvp-realignment-plan-2026-06-10.md` §"Source card
 * projection") so a regression can never reintroduce a dead/contradictory
 * string into an owner-facing Sources label.
 *
 * Two layers, both over the REAL shipped modules (not a fixture):
 *
 *   1. Behavioral — render every add-account support label and every
 *      first-account setup status label and assert none contains a forbidden
 *      string. This catches the case where a new disposition silently maps to
 *      old copy.
 *   2. Source-literal — strip comments from the two copy modules and assert no
 *      forbidden literal survives in a quoted string. This catches a dead label
 *      that is wired but not reachable by the fixtures above. Comments are
 *      stripped first so a JSDoc that *describes* an enum (e.g. the
 *      `not_self_service` doc) is not a false positive — only owner-facing
 *      string literals are scanned.
 *
 * The forbidden set is the realignment plan's §"Negative acceptance checks":
 * the overruled demotion copy, inert-tracking copy, monorepo paths, package
 * runner invocations, an unpublished `pdpp ` CLI command, and env-var jargon.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildConnectorCatalog, type CatalogManifestLike, type ConnectorCatalogEntry } from "./connection-catalog.ts";
import { buildSourceAddSupport, type SourceAddSupport } from "./source-add-support.ts";
import { sourceSetupAction, sourceSetupStatus } from "./source-setup-presentation.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADD_SUPPORT_FILE = `${HERE}source-add-support.ts`;
const SETUP_PRESENTATION_FILE = `${HERE}source-setup-presentation.ts`;
const REPO_ROOT = new URL("../../../../../../", import.meta.url);
const MANIFESTS_DIR = new URL("packages/polyfill-connectors/manifests/", REPO_ROOT);

// The three exact overruled phrases, hoisted to module scope (project lint:
// useTopLevelRegex). These must never survive in a comment-stripped label.
const OVERRULED_DEMOTION_SENTENCE_RE = /is not self-service yet/i;
const OVERRULED_STATUS_LABEL_RE = /Not self-service yet/;
const CONTRADICTORY_CHIP_RE = /moves into the dashboard soon/i;

/**
 * Forbidden owner-facing copy. Each entry is a human-readable class + the regex
 * that must NEVER match an owner-facing Sources label. Sourced from the
 * realignment plan's negative acceptance checks (§2.4 of the SLVP plan).
 */
const FORBIDDEN_COPY: readonly { class: string; re: RegExp }[] = [
  { class: "overruled-demotion", re: /not self-service/i },
  { class: "inert-tracking", re: /\bTrack only\b/i },
  { class: "dead-action", re: /No setup action/i },
  { class: "coming-soon", re: /coming soon|not yet|not available yet|not implemented/i },
  { class: "pending-copy", re: /\bpending\b/i },
  { class: "monorepo-package-path", re: /packages\//i },
  { class: "package-runner", re: /pnpm --dir/i },
  { class: "unpublished-cli", re: /\bpdpp \w/i },
  { class: "env-var-jargon", re: /PDPP_[A-Z_]+|connector_instance_id|source_instance_id|[A-Z]+_ENV_VAR|_DIR=/ },
];

/**
 * Strip line and block comments so only string literals (the owner-facing
 * surface) remain. Deliberately conservative: it removes line comments and
 * block-comment runs. The enum JSDoc that legitimately describes
 * `not_self_service` must not trip the source-literal scan.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** A minimal catalog entry stub for a given disposition. */
function entryForDisposition(disposition: ConnectorCatalogEntry["disposition"]): ConnectorCatalogEntry {
  return {
    connectorKey: `stub-${disposition}`,
    disposition,
    deploymentReadiness: { ready: true, blockers: [] },
  } as unknown as ConnectorCatalogEntry;
}

/** Every disposition the setup presentation switches over. */
const ALL_DISPOSITIONS: readonly ConnectorCatalogEntry["disposition"][] = [
  "local_collector_enroll",
  "static_secret_connect",
  "browser_collector_manual",
  "manual_upload_connect",
  "manual_upload_pending",
  "provider_auth_deployment_blocked",
  "browser_bound_runbook",
  "local_collector_unproven",
  "provider_auth_proof_gated",
  "api_network_unsupported",
  "unknown_unsupported",
];

function assertCleanCopy(label: string, where: string): void {
  for (const { class: klass, re } of FORBIDDEN_COPY) {
    assert.doesNotMatch(label, re, `${where} renders forbidden ${klass} copy: ${JSON.stringify(label)}`);
  }
}

async function loadCommittedManifests(): Promise<CatalogManifestLike[]> {
  const files = await readdir(fileURLToPath(MANIFESTS_DIR));
  const manifests: CatalogManifestLike[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const raw = await readFile(fileURLToPath(new URL(file, MANIFESTS_DIR)), "utf8");
    manifests.push(JSON.parse(raw) as CatalogManifestLike);
  }
  return manifests;
}

// ── Layer 1: behavioral — rendered labels carry no forbidden copy ────────────

test("every first-account setup status label is free of forbidden copy", () => {
  for (const disposition of ALL_DISPOSITIONS) {
    const status = sourceSetupStatus(entryForDisposition(disposition));
    assertCleanCopy(status.label, `sourceSetupStatus(${disposition})`);
  }
});

test("every committed add-source catalog card has a forward action or acquisition path", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const deadEnds = catalog.filter((entry) => !sourceSetupAction(entry) && entry.acquisitionPaths.length === 0);

  assert.deepEqual(
    deadEnds.map((entry) => `${entry.connectorKey}:${entry.disposition}`),
    [],
    "add-source cards must never render a dead status label with no forward action"
  );
});

test("formerly dead add-source cards resolve to concrete setup actions", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const actions = new Map(catalog.map((entry) => [entry.connectorKey, sourceSetupAction(entry)?.label ?? null]));

  assert.equal(actions.get("apple-health"), "Import an export");
  assert.equal(actions.get("ical"), "Import an export");
  assert.equal(actions.get("google-takeout"), "Import an export");
  assert.equal(actions.get("imessage"), "Import an export");
  assert.equal(actions.get("pocket"), "Import an export");
  assert.equal(actions.get("twitter-archive"), "Import an export");
  assert.equal(actions.get("slack"), "Set up source");
  assert.equal(actions.get("spotify"), "Set up source");
  assert.equal(actions.get("strava"), "Set up source");
});

test("the agreed add-account labels are exactly the realignment-plan vocabulary", () => {
  // Drive the real projection with representative manifests, then assert every
  // produced label is in the agreed set and free of forbidden copy.
  const map = buildSourceAddSupport([
    {
      connector_id: "ynab",
      display_name: "ynab",
      runtime_requirements: { bindings: { network: {} } },
      setup: {
        modality: "static_secret",
        credential_capture: { credential_kind: "api_token", fields: [{ name: "t", label: "T", secret: true }] },
      },
    } as never,
    {
      connector_id: "browser_src",
      display_name: "browser_src",
      runtime_requirements: { bindings: { browser: {} } },
    } as never,
  ]);
  const labels = [...map.values()].map((s: SourceAddSupport) => s.supportLabel);
  assert.ok(labels.length > 0, "projection must produce at least one label");
  const AGREED = new Set([
    "Add another account",
    "Needs packaged path",
    "Adding another account needs deployment setup",
    "Needs setup proof",
  ]);
  for (const label of labels) {
    assertCleanCopy(label, "addAccountSupport label");
    assert.ok(AGREED.has(label), `label ${JSON.stringify(label)} is not in the agreed add-account vocabulary`);
  }
});

// ── Layer 2: source-literal — dead strings cannot survive in a quoted label ──

test("source-add-support.ts contains no forbidden owner-facing literal", async () => {
  const src = stripComments(await readFile(ADD_SUPPORT_FILE, "utf8"));
  for (const { class: klass, re } of FORBIDDEN_COPY) {
    assert.doesNotMatch(src, re, `source-add-support.ts contains forbidden ${klass} copy`);
  }
});

test("source-setup-presentation.ts contains no forbidden owner-facing literal", async () => {
  const src = stripComments(await readFile(SETUP_PRESENTATION_FILE, "utf8"));
  for (const { class: klass, re } of FORBIDDEN_COPY) {
    // `provider_auth_deployment_blocked` guidance interpolates a blocker key; that
    // is a deployment-config label, not env-var jargon, and uses no forbidden token.
    assert.doesNotMatch(src, re, `source-setup-presentation.ts contains forbidden ${klass} copy`);
  }
});

test("the specific overruled strings never reappear anywhere in the copy modules", async () => {
  const addSupport = await readFile(ADD_SUPPORT_FILE, "utf8");
  const presentation = await readFile(SETUP_PRESENTATION_FILE, "utf8");
  // These exact phrases were the overruled copy. They must not exist even in a
  // label literal. (Comments are allowed to reference history; these assertions
  // scan the comment-stripped quoted-string surface.)
  const stripped = `${stripComments(addSupport)}\n${stripComments(presentation)}`;
  assert.doesNotMatch(
    stripped,
    OVERRULED_DEMOTION_SENTENCE_RE,
    "overruled 'is not self-service yet' demotion copy reappeared"
  );
  assert.doesNotMatch(stripped, OVERRULED_STATUS_LABEL_RE, "overruled 'Not self-service yet' status label reappeared");
  assert.doesNotMatch(
    stripped,
    CONTRADICTORY_CHIP_RE,
    "the contradictory 'moves into the dashboard soon' chip copy reappeared"
  );
});
