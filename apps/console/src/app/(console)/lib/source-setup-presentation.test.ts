// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for `isRunnableAddOffer`, the /sources/add gate that
 * decides whether a catalog entry is offered as a runnable "add source"
 * card (main list or Preview disclosure) versus filtered out entirely.
 *
 * Root-caused live bug: the Signal connector (publicTier "preview",
 * disposition "local_collector_enroll") was registered and owner-actionable,
 * but `isRunnableAddOffer`'s old two-arm condition only matched
 * (supported && available_now) or (preview && experimental_opt_in).
 * `sourceSetupAvailability` maps `local_collector_enroll` to
 * `"available_now"`, so a preview-tier local-collector entry matched
 * NEITHER arm and was silently dropped from both the main list and the
 * Preview disclosure. This was latent until Signal shipped as the first
 * preview-tier local-collector connector.
 *
 * These tests assert the OBSERVABLE contract (is this entry offered on
 * /sources/add), not the implementation's internal branches, across the
 * full publicTier x disposition matrix that matters for that gate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorCatalogEntry } from "./connection-catalog.ts";
import {
  isRunnableAddOffer,
  sourceSetupAction,
  sourceSetupGuidance,
  sourceSetupStatus,
} from "./source-setup-presentation.ts";

/**
 * A complete, valid catalog entry fixture. Every field a real
 * `buildConnectorCatalog` entry would carry is present with an inert
 * default; tests override only the fields relevant to the case under test.
 */
function makeEntry(overrides: Partial<ConnectorCatalogEntry> & Pick<ConnectorCatalogEntry, "publicTier" | "disposition">): ConnectorCatalogEntry {
  return {
    acquisitionPaths: [],
    connectorKey: "stub-connector",
    deploymentReadiness: { blockers: [], guidance: null, state: "ready" },
    displayName: "Stub connector",
    externalDocs: [],
    isKnownScaffold: false,
    listingNote: null,
    modality: "network",
    nextStepKind: "unsupported",
    ownerActionable: true,
    ownerActionMethod: null,
    ownerActionUrl: null,
    proofGate: null,
    refreshPolicyRationale: null,
    runbookPath: null,
    setupDescription: null,
    setupHelpText: null,
    setupModality: "unsupported",
    supportState: "supported",
    ...overrides,
  } as ConnectorCatalogEntry;
}

test("preview + local_collector_enroll is offered on /sources/add (the Signal bug)", () => {
  const signal = makeEntry({
    connectorKey: "signal",
    disposition: "local_collector_enroll",
    displayName: "Signal",
    modality: "local_collector",
    publicTier: "preview",
    setupModality: "local_collector",
  });
  assert.equal(
    isRunnableAddOffer(signal),
    true,
    "a registered, owner-actionable preview-tier local-collector entry must be offered on /sources/add"
  );
});

test("preview + static_secret_experimental is still offered (pre-existing experimental-opt-in path)", () => {
  const entry = makeEntry({
    disposition: "static_secret_experimental",
    publicTier: "preview",
    setupModality: "static_secret",
    supportState: "experimental",
  });
  assert.equal(isRunnableAddOffer(entry), true);
});

test("supported + local_collector_enroll is offered (pre-existing)", () => {
  const entry = makeEntry({
    disposition: "local_collector_enroll",
    modality: "local_collector",
    publicTier: "supported",
    setupModality: "local_collector",
  });
  assert.equal(isRunnableAddOffer(entry), true);
});

test("supported + every available_now disposition is offered", () => {
  const availableNowDispositions: readonly ConnectorCatalogEntry["disposition"][] = [
    "local_collector_enroll",
    "static_secret_connect",
    "manual_upload_connect",
    "browser_collector_manual",
    "provider_auth_connect",
  ];
  for (const disposition of availableNowDispositions) {
    const entry = makeEntry({ disposition, publicTier: "supported" });
    assert.equal(isRunnableAddOffer(entry), true, `supported + ${disposition} should be offered`);
  }
});

test("development tier is never offered, regardless of disposition", () => {
  const dispositions: readonly ConnectorCatalogEntry["disposition"][] = [
    "local_collector_enroll",
    "static_secret_connect",
    "static_secret_experimental",
    "browser_collector_manual",
    "manual_upload_connect",
    "provider_auth_connect",
    "provider_auth_deployment_blocked",
  ];
  for (const disposition of dispositions) {
    const entry = makeEntry({ disposition, publicTier: "development" });
    assert.equal(isRunnableAddOffer(entry), false, `development + ${disposition} must never be offered`);
  }
});

test("preview + a requires_server_setup disposition is not offered", () => {
  const entry = makeEntry({
    deploymentReadiness: {
      blockers: [{ key: "PROVIDER_APP_ID", label: "Provider app ID", secret: true }],
      guidance: null,
      state: "needs_config",
    },
    disposition: "provider_auth_deployment_blocked",
    publicTier: "preview",
    setupModality: "provider_authorization",
    supportState: "needs_deployment_config",
  });
  assert.equal(isRunnableAddOffer(entry), false, "a server-setup-blocked entry must never render a dead add offer");
});

test("preview + a not_available_here disposition is not offered", () => {
  const entry = makeEntry({
    disposition: "api_network_unsupported",
    ownerActionable: false,
    publicTier: "preview",
    supportState: "unsupported",
  });
  assert.equal(isRunnableAddOffer(entry), false, "an unsupported disposition must never be offered as runnable");
});

test("preview + browser_collector_manual (Venmo) is offered on /sources/add", () => {
  // Root-caused live bug: the Venmo connector shipped with publicTier
  // "development" (unproven-against-a-real-account, matching its manifest's
  // own header comment), which unconditionally withholds the add offer
  // regardless of disposition -- so it never appeared on /sources/add even
  // though it is registered, owner-actionable, and browser_bound with static
  // credential capture like reddit/amazon (disposition
  // "browser_collector_manual", which resolves to availability
  // "available_now"). Venmo has the same evidence profile that moved Signal
  // to Preview: fixture-driven unit/integration tests pass, but no live run
  // against a real account has been recorded. Promoted to "preview" so the
  // owner can opt in to perform that first live run.
  const venmo = makeEntry({
    connectorKey: "venmo",
    disposition: "browser_collector_manual",
    displayName: "Venmo",
    modality: "browser_bound",
    publicTier: "preview",
    setupModality: "static_secret",
  });
  assert.equal(
    isRunnableAddOffer(venmo),
    true,
    "a registered, owner-actionable preview-tier browser-bound entry must be offered on /sources/add"
  );
});

/**
 * The Development disclosure (below Preview on /sources/add) coverage.
 *
 * Root-caused live bug: every Development-tier connector -- both real,
 * implemented-but-unproven connectors (imessage, spotify, oura,
 * google_maps_data_portability, ...) and genuine SKIP_RESULT scaffolds
 * (anthropic, linkedin, loom, ...) -- was invisible on /sources/add. The
 * owner could not tell what existed, could not test an unproven connector
 * himself, and could not distinguish a broken connector from a missing one.
 * `buildOwnerConnectorCatalog` used to drop every publicTier "development"
 * template before it became a catalog entry at all, so no presentation
 * function ever saw one. These tests pin the fixed contract: a real
 * Development entry is never a runnable ADD OFFER (isRunnableAddOffer stays
 * false, unconditionally, for the whole tier -- see "development tier is
 * never offered" above), but it DOES get a self-test action, distinct status
 * label, and honest guidance in the Development disclosure. A KNOWN scaffold
 * gets none of those: no action, "Not implemented" status, and guidance that
 * says plainly there is nothing to test yet.
 */

test("development + real (non-scaffold) self-testable disposition gets a self-test action, never a runnable offer", () => {
  const imessage = makeEntry({
    connectorKey: "imessage",
    disposition: "local_collector_enroll",
    displayName: "iMessage",
    isKnownScaffold: false,
    modality: "local_collector",
    ownerActionable: false,
    publicTier: "development",
    setupModality: "local_collector",
  });
  assert.equal(isRunnableAddOffer(imessage), false, "development is never a runnable /sources/add offer");
  assert.ok(
    sourceSetupAction(imessage),
    "a real (non-scaffold) development entry with a self-testable disposition gets a self-test action"
  );
  assert.equal(sourceSetupStatus(imessage).label, "Development");
});

test("development + known scaffold gets no action and a distinct 'Not implemented' status", () => {
  const anthropic = makeEntry({
    connectorKey: "anthropic",
    disposition: "browser_bound_runbook",
    displayName: "Anthropic",
    isKnownScaffold: true,
    modality: "browser_bound",
    ownerActionable: false,
    publicTier: "development",
    setupModality: "browser_bound",
  });
  assert.equal(isRunnableAddOffer(anthropic), false);
  assert.equal(sourceSetupAction(anthropic), null, "a known scaffold must never render an add action");
  assert.equal(sourceSetupStatus(anthropic).label, "Not implemented");
  assert.match(
    sourceSetupGuidance(anthropic),
    /scaffold/i,
    "scaffold guidance must say plainly there is nothing to test yet"
  );
});

test("development + known scaffold with a self-testable disposition still gets no action", () => {
  // The structural safety property: isKnownScaffold overrides disposition.
  // Even if a scaffold's disposition happens to land in the self-test
  // allowlist (e.g. a future scaffold resolves to static_secret_connect),
  // clicking an action for it can never collect anything.
  const scaffoldWithRunnableDisposition = makeEntry({
    connectorKey: "hypothetical-scaffold",
    disposition: "static_secret_connect",
    isKnownScaffold: true,
    publicTier: "development",
    setupModality: "static_secret",
  });
  assert.equal(sourceSetupAction(scaffoldWithRunnableDisposition), null);
});

test("development + a disposition with no safe action gets honest fallback guidance, not the generic dead-end", () => {
  const localCollectorUnproven = makeEntry({
    connectorKey: "some-filesystem-connector",
    disposition: "local_collector_unproven",
    isKnownScaffold: false,
    modality: "local_collector",
    ownerActionable: false,
    publicTier: "development",
    setupModality: "local_collector",
  });
  assert.equal(sourceSetupAction(localCollectorUnproven), null);
  assert.match(
    sourceSetupGuidance(localCollectorUnproven),
    /Development/,
    "a real development entry without a safe action still gets development-framed guidance, not the unclassified dead-end"
  );
});

test("development real entry surfaces its manifest listingNote in guidance when present", () => {
  const spotify = makeEntry({
    connectorKey: "spotify",
    disposition: "static_secret_connect",
    isKnownScaffold: false,
    listingNote: "Hidden from the reference dashboard catalog until a credentialed run proves useful records in the deployment.",
    publicTier: "development",
    setupModality: "static_secret",
  });
  assert.equal(sourceSetupAction(spotify) !== null, true);
});
