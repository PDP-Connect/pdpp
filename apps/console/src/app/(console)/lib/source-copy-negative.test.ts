// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import { buildSourceAddSupport, type SourceAddSupport } from "./source-add-support.ts";
import {
  sourceSetupAction,
  sourceSetupAvailability,
  sourceSetupGuidance,
  sourceSetupStatus,
} from "./source-setup-presentation.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ADD_SUPPORT_FILE = `${HERE}source-add-support.ts`;
const SETUP_PRESENTATION_FILE = `${HERE}source-setup-presentation.ts`;

// The three exact overruled phrases, hoisted to module scope (project lint:
// useTopLevelRegex). These must never survive in a comment-stripped label.
const OVERRULED_DEMOTION_SENTENCE_RE = /is not self-service yet/i;
const OVERRULED_STATUS_LABEL_RE = /Not self-service yet/;
const CONTRADICTORY_CHIP_RE = /moves into the dashboard soon/i;
const RUNBOOK_COPY_RE = /runbook/i;
const BROWSER_COLLECTOR_ACTION_HREF_RE = /\/connect\/browser-session\/stub-browser_collector_manual/;
const PREVIEW_GUIDANCE_RE = /^Preview:/;
const LIVE_VALIDATION_CAVEAT_RE = /not completed live validation/;

/**
 * Forbidden owner-facing copy. Each entry is a human-readable class + the regex
 * that must NEVER match an owner-facing Sources label. Sourced from the
 * realignment plan's negative acceptance checks (§2.4 of the SLVP plan).
 */
const FORBIDDEN_COPY: readonly { class: string; re: RegExp }[] = [
  { class: "overruled-demotion", re: /not self-service/i },
  { class: "inert-tracking", re: /\bTrack only\b/i },
  { class: "rejected-deployment-jargon", re: /\bdeployment needed\b/i },
  { class: "rejected-setup-jargon", re: /\bneeds setup\b|\bneeds local setup\b|\bsetup path pending\b/i },
  { class: "dead-end-action", re: /\bNo setup action yet\b/i },
  { class: "ambiguous-existing-data", re: /\bExisting data only\b/i },
  { class: "monorepo-package-path", re: /packages\//i },
  { class: "operator-runbook-path", re: /Tracking runbook|docs\/operator/i },
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
  const supported = new Set<ConnectorCatalogEntry["disposition"]>([
    "local_collector_enroll",
    "static_secret_connect",
    "manual_upload_connect",
    "browser_collector_manual",
    "provider_auth_connect",
  ]).has(disposition);
  const proofGated = new Set<ConnectorCatalogEntry["disposition"]>([
    "local_collector_unproven",
    "provider_auth_proof_gated",
    "browser_bound_runbook",
    "manual_upload_pending",
  ]).has(disposition);
  const providerDeploymentBlocked = disposition === "provider_auth_deployment_blocked";
  let setupModality = "unsupported";
  if (disposition === "static_secret_connect") {
    setupModality = "static_secret";
  } else if (disposition === "manual_upload_connect" || disposition === "manual_upload_pending") {
    setupModality = "manual_or_upload";
  } else if (
    disposition === "provider_auth_connect" ||
    providerDeploymentBlocked ||
    disposition === "provider_auth_proof_gated"
  ) {
    setupModality = "provider_authorization";
  } else if (disposition === "browser_collector_manual" || disposition === "browser_bound_runbook") {
    setupModality = "browser_bound";
  } else if (disposition === "local_collector_enroll" || disposition === "local_collector_unproven") {
    setupModality = "local_collector";
  }

  let nextStepKind = "unsupported";
  if (disposition === "local_collector_enroll") {
    nextStepKind = "enroll_local_collector";
  } else if (disposition === "browser_collector_manual") {
    nextStepKind = "enroll_browser_collector";
  } else if (disposition === "static_secret_connect") {
    nextStepKind = "capture_static_secret";
  } else if (disposition === "provider_auth_connect") {
    nextStepKind = "open_provider_auth";
  } else if (providerDeploymentBlocked) {
    nextStepKind = "needs_deployment_config";
  } else if (disposition === "manual_upload_connect" || disposition === "manual_upload_pending") {
    nextStepKind = "provide_import_file";
  } else if (disposition === "browser_bound_runbook" || disposition === "provider_auth_proof_gated") {
    nextStepKind = "manual_runbook";
  }
  let supportState = "unsupported";
  if (providerDeploymentBlocked) {
    supportState = "needs_deployment_config";
  } else if (supported) {
    supportState = "supported";
  } else if (disposition === "static_secret_experimental") {
    supportState = "experimental";
  } else if (proofGated) {
    supportState = "proof_gated";
  }
  return {
    connectorKey: `stub-${disposition}`,
    deploymentReadiness: {
      blockers: [],
      guidance: null,
      state: providerDeploymentBlocked ? "needs_config" : "ready",
    },
    disposition,
    nextStepKind,
    ownerActionMethod: supported ? "POST" : null,
    ownerActionUrl: supported ? "/v1/owner/connections/intents" : null,
    proofGate: proofGated ? "setup_proof_missing" : null,
    setupModality,
    supportState,
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
  "provider_auth_connect",
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

// ── Layer 1: behavioral — rendered labels carry no forbidden copy ────────────

test("every first-account setup status label is free of forbidden copy", () => {
  for (const disposition of ALL_DISPOSITIONS) {
    const status = sourceSetupStatus(entryForDisposition(disposition));
    assertCleanCopy(status.label, `sourceSetupStatus(${disposition})`);
  }
});

test("only self-service and server-setup dispositions expose primary actions", () => {
  const expectedActionDispositions = new Set<ConnectorCatalogEntry["disposition"]>([
    "local_collector_enroll",
    "static_secret_connect",
    "manual_upload_connect",
    "browser_collector_manual",
    "provider_auth_connect",
  ]);
  const serverSetupDisposition = "provider_auth_deployment_blocked" as const;
  for (const disposition of ALL_DISPOSITIONS) {
    const entry = entryForDisposition(disposition);
    const action = sourceSetupAction(entry);
    const availability = sourceSetupAvailability(entry);
    if (expectedActionDispositions.has(disposition)) {
      assert.ok(action, `${disposition} should expose a real in-product next action`);
      assert.notEqual(availability, "not_available_here");
      continue;
    }
    if (disposition === serverSetupDisposition) {
      assert.equal(action, null, "blocked provider authorization must not render a dead action");
      assert.equal(availability, "requires_server_setup");
      continue;
    }
    assert.equal(action, null, `${disposition} must not render a fake primary setup action`);
    assert.equal(availability, "not_available_here", `${disposition} must be separated from available setup`);
  }
});

test("browser_collector_manual is an explicit Connect account route", () => {
  const entry = entryForDisposition("browser_collector_manual");
  const status = sourceSetupStatus(entry);
  const action = sourceSetupAction(entry);

  assert.equal(status.label, "Supported");
  assert.equal(sourceSetupAvailability(entry), "available_now");
  assert.ok(action);
  assert.equal(action.label, "Connect account");
  assert.match(action.href, BROWSER_COLLECTOR_ACTION_HREF_RE);
});

test("public setup tiers are Supported or Preview, while actions retain their verbs", () => {
  const supported = entryForDisposition("static_secret_connect");
  const preview = entryForDisposition("static_secret_experimental");

  assert.equal(sourceSetupStatus(supported).label, "Supported");
  assert.deepEqual(sourceSetupAction(supported), {
    href: "/connect/static-secret/stub-static_secret_connect",
    label: "Add account",
  });
  assert.equal(sourceSetupStatus(preview).label, "Preview");
  assert.match(sourceSetupGuidance(preview), PREVIEW_GUIDANCE_RE);
  assert.match(sourceSetupGuidance(preview), LIVE_VALIDATION_CAVEAT_RE);
  assert.deepEqual(sourceSetupAction(preview), {
    href: "/connect/static-secret/stub-static_secret_experimental",
    label: "Add account",
  });
});

test("every first-account setup guidance line is free of forbidden copy", () => {
  for (const disposition of ALL_DISPOSITIONS) {
    const guidance = sourceSetupGuidance(entryForDisposition(disposition));
    assertCleanCopy(guidance, `sourceSetupGuidance(${disposition})`);
    assert.doesNotMatch(guidance, RUNBOOK_COPY_RE, `sourceSetupGuidance(${disposition}) must not expose runbook copy`);
  }
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
        credential_capture: {
          credential_kind: "api_token",
          fields: [{ env: ["YNAB_PERSONAL_ACCESS_TOKEN"], label: "T", name: "t", secret: true }],
        },
        modality: "static_secret",
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
    "Adding another account is not available yet",
    "Server setup required to add another account",
    "Adding another account is not available here",
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
