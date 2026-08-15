// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorManifestLike } from "../server/connection-setup-plan.ts";
import {
  buildConnectionSetupPlan,
  classifyConnectorIntentModality,
  classifyConnectorSetupModality,
  STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS,
} from "../server/connection-setup-plan.ts";

function manifest(
  connectorId: string,
  bindings: Readonly<Record<string, unknown>>,
  extra: Partial<ConnectorManifestLike> = {}
): ConnectorManifestLike {
  return {
    connector_id: `https://registry.pdpp.dev/connectors/${connectorId}`,
    display_name: connectorId,
    runtime_requirements: { bindings },
    ...extra,
  };
}

function staticSecretManifest(connectorId: string, credentialKind = "api_key"): ConnectorManifestLike {
  return manifest(
    connectorId,
    { network: { required: true } },
    {
      setup: {
        credential_capture: {
          fields: [
            {
              env: ["TEST_PROVIDER_SECRET"],
              label: "Provider secret",
              name: "secret",
              required: true,
              secret: true,
              type: "password",
            },
          ],
          kind: credentialKind,
          label: `${connectorId} secret`,
        },
        modality: "static_secret",
      },
    }
  );
}

test("setup planner supports proven local collectors without creating active connections", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "codex",
    manifest: manifest("codex", { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorModality, "local_collector");
  assert.equal(plan.setupModality, "local_collector");
  assert.equal(plan.supportState, "supported");
  assert.equal(plan.deploymentReadiness.state, "not_applicable");
  assert.equal(plan.catalogDisposition, "local_collector_enroll");
  assert.equal(plan.nextStepKind, "enroll_local_collector");
  assert.equal(plan.ownerAgentIntent.status, "supported");
  assert.equal(plan.ownerAgentIntent.nextStepKind, "enroll_local_collector");
  assert.equal(plan.enrollmentKey, "codex");
});

test("setup planner supports URL-shaped local collector identifiers", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "https://registry.pdpp.dev/connectors/claude-code",
    manifest: manifest("claude-code", { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorKey, "claude-code");
  assert.equal(plan.supportState, "supported");
  assert.equal(plan.catalogDisposition, "local_collector_enroll");
  assert.equal(plan.enrollmentKey, "claude_code");
});

test("setup planner proof-gates filesystem connectors outside the proven enrollment set", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "slack",
    manifest: manifest("slack", { filesystem: { required: true } }),
  });
  assert.equal(plan.connectorModality, "local_collector");
  assert.equal(plan.supportState, "proof_gated");
  assert.equal(plan.catalogDisposition, "local_collector_unproven");
  assert.equal(plan.ownerAgentIntent.status, "proof_gated");
  assert.equal(plan.ownerAgentIntent.nextStepKind, "manual_runbook");
  assert.equal(plan.proofGate, "local_collector_connector_proof_missing");
  assert.equal(plan.enrollmentKey, undefined);
});

test("setup planner treats manifest-declared manual/upload connectors as import setup, not local collector", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "google-maps",
    manifest: manifest("google-maps", { filesystem: { required: true } }, { setup: { modality: "manual_or_upload" } }),
  });
  assert.equal(plan.connectorModality, "local_collector");
  assert.equal(plan.setupModality, "manual_or_upload");
  assert.equal(plan.supportState, "proof_gated");
  assert.equal(plan.catalogDisposition, "manual_upload_pending");
  assert.equal(plan.nextStepKind, "provide_import_file");
  assert.equal(plan.ownerAgentIntent.status, "proof_gated");
  assert.equal(plan.ownerAgentIntent.nextStepKind, "provide_import_file");
  assert.equal(plan.proofGate, "manual_upload_capture_missing");
  assert.equal(plan.enrollmentKey, undefined);
});

test("setup planner supports manual/upload connectors that declare an import env binding", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "google-maps",
    manifest: manifest(
      "google-maps",
      { filesystem: { required: true } },
      {
        setup: {
          manual_or_upload: {
            accepted_file_names: ["Timeline.json"],
            import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
            label: "Timeline export",
          },
          modality: "manual_or_upload",
        },
      }
    ),
  });
  assert.equal(plan.connectorModality, "local_collector");
  assert.equal(plan.setupModality, "manual_or_upload");
  assert.equal(plan.supportState, "supported");
  assert.equal(plan.catalogDisposition, "manual_upload_connect");
  assert.equal(plan.nextStepKind, "provide_import_file");
  assert.equal(plan.ownerAgentIntent.status, "supported");
  assert.equal(plan.ownerAgentIntent.method, "POST");
  assert.equal(plan.ownerAgentIntent.nextStepKind, "provide_import_file");
  assert.equal(plan.proofGate, null);
  assert.equal(plan.enrollmentKey, undefined);
});

test("setup planner keeps browser-bound connectors proof-gated before live proof", () => {
  const amazon = buildConnectionSetupPlan({
    connectorKey: "amazon",
    manifest: manifest("amazon", { browser: { required: true }, network: { required: true } }),
  });
  assert.equal(amazon.connectorModality, "browser_bound");
  assert.equal(amazon.setupModality, "browser_bound");
  assert.equal(amazon.supportState, "proof_gated");
  assert.equal(amazon.catalogDisposition, "browser_collector_manual");
  assert.equal(amazon.nextStepKind, "enroll_browser_collector");
  assert.equal(amazon.ownerAgentIntent.status, "proof_gated");
  assert.equal(amazon.ownerAgentIntent.nextStepKind, "manual_runbook");
  assert.equal(amazon.proofGate, "browser_collector_live_proof_missing");
  assert.equal(amazon.runbookPath, null);

  const chase = buildConnectionSetupPlan({
    connectorKey: "chase",
    manifest: manifest("chase", { browser: { required: true } }),
  });
  assert.equal(chase.catalogDisposition, "browser_collector_manual");
  assert.equal(chase.enrollmentKey, "chase");
});

test("setup planner marks unproven static-secret connectors with a real credential_capture as experimental, not hidden", () => {
  // 'mailbox' is synthetic and absent from STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS,
  // but its manifest declares a real credential_capture block — the same shape
  // Steam/Jellyfin/Apple Contacts declare — so the generic capture form is
  // reachable today. This must surface as an explicit opt-in, not "supported"
  // and not "not available here".
  const plan = buildConnectionSetupPlan({
    connectorKey: "mailbox",
    manifest: staticSecretManifest("mailbox", "app_password"),
  });
  assert.equal(plan.connectorModality, "api_network");
  assert.equal(plan.setupModality, "static_secret");
  assert.equal(plan.supportState, "experimental");
  assert.equal(plan.catalogDisposition, "static_secret_experimental");
  assert.equal(plan.nextStepKind, "capture_static_secret");
  assert.equal(plan.ownerAgentIntent.status, "experimental");
  assert.equal(plan.ownerAgentIntent.method, "POST");
  assert.equal(plan.ownerAgentIntent.nextStepKind, "capture_static_secret");
  assert.equal(plan.proofGate, "static_secret_live_proof_missing");
  assert.equal(plan.runbookPath, null);
});

test("setup planner keeps static-secret connectors proof-gated (hidden) when no credential_capture is declared", () => {
  // A connector manifest can declare setup.modality: "static_secret" without a
  // usable credential_capture block (e.g. missing a secret field). This must
  // stay hidden, not experimental — experimental requires a real, submittable
  // form, matching GroupMe's manual_action (no credential_capture) staying
  // unsupported rather than silently promoted.
  const plan = buildConnectionSetupPlan({
    connectorKey: "no-capture-declared",
    manifest: manifest(
      "no-capture-declared",
      { network: { required: true } },
      { setup: { modality: "static_secret" } }
    ),
  });
  assert.equal(plan.setupModality, "unsupported");
  assert.equal(plan.supportState, "unsupported");
  assert.equal(plan.catalogDisposition, "api_network_unsupported");
});

test("GroupMe-shaped manual_action connector with no credential_capture stays unsupported, never experimental", () => {
  // Regression guard for the actual GroupMe manifest shape: setup.modality is
  // "manual_action" (unrecognized) with no credential_capture block, so it
  // must fall through to unsupported and never reach the experimental branch.
  const plan = buildConnectionSetupPlan({
    connectorKey: "groupme",
    manifest: manifest("groupme", { network: { required: true } }, { setup: { modality: "manual_action" } }),
  });
  assert.equal(plan.setupModality, "unsupported");
  assert.equal(plan.supportState, "unsupported");
  assert.equal(plan.catalogDisposition, "api_network_unsupported");
  assert.notEqual(plan.catalogDisposition, "static_secret_experimental");
});

test("setup planner marks live-proven static-secret connectors as supported", () => {
  // Live proof recorded 2026-06-10T22:55Z: env-free container, store-backed runs.
  //   gmail  run_1781131328336 succeeded
  //   github run_1781131195649 succeeded + run_1781131489458 scheduled/unattended succeeded
  //   slack  run_1781131204868 succeeded
  for (const connectorKey of STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS) {
    const plan = buildConnectionSetupPlan({
      connectorKey,
      manifest: staticSecretManifest(connectorKey, "app_password"),
    });
    assert.equal(plan.connectorModality, "api_network", `${connectorKey}: connectorModality`);
    assert.equal(plan.setupModality, "static_secret", `${connectorKey}: setupModality`);
    assert.equal(plan.supportState, "supported", `${connectorKey}: supportState`);
    assert.equal(plan.catalogDisposition, "static_secret_connect", `${connectorKey}: catalogDisposition`);
    assert.equal(plan.nextStepKind, "capture_static_secret", `${connectorKey}: nextStepKind`);
    assert.equal(plan.ownerAgentIntent.status, "supported", `${connectorKey}: ownerAgentIntent.status`);
    assert.equal(plan.ownerAgentIntent.method, "POST", `${connectorKey}: ownerAgentIntent.method`);
    assert.equal(
      plan.ownerAgentIntent.nextStepKind,
      "capture_static_secret",
      `${connectorKey}: ownerAgentIntent.nextStepKind`
    );
    assert.equal(plan.proofGate, null, `${connectorKey}: proofGate`);
    assert.equal(plan.runbookPath, null, `${connectorKey}: runbookPath`);
  }
});

test("YNAB static-secret setup supports owner-session capture route", () => {
  // YNAB regression: static-secret capture form was unreachable from the
  // catalog picker when YNAB was not in the live-proven roster. Verify the fix.
  const plan = buildConnectionSetupPlan({
    connectorKey: "ynab",
    manifest: staticSecretManifest("ynab", "personal_access_token"),
  });
  assert.equal(plan.connectorModality, "api_network");
  assert.equal(plan.setupModality, "static_secret");
  assert.equal(plan.supportState, "supported");
  assert.equal(plan.catalogDisposition, "static_secret_connect");
  assert.equal(plan.nextStepKind, "capture_static_secret");
  assert.equal(plan.ownerAgentIntent.status, "supported");
  assert.equal(plan.ownerAgentIntent.method, "POST");
  assert.equal(plan.proofGate, null);
  assert.equal(plan.validationMode, "first_sync");
});

test("setup planner treats hybrid filesystem static-secret connectors as credential capture setup", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "slack",
    manifest: {
      ...staticSecretManifest("slack", "sealed_bundle"),
      runtime_requirements: { bindings: { filesystem: { required: true }, network: { required: true } } },
    },
  });
  assert.equal(plan.connectorModality, "local_collector");
  assert.equal(plan.setupModality, "static_secret");
  assert.equal(plan.supportState, "supported");
  assert.equal(plan.catalogDisposition, "static_secret_connect");
  assert.equal(plan.nextStepKind, "capture_static_secret");
  assert.equal(plan.ownerAgentIntent.status, "supported");
  assert.equal(plan.ownerAgentIntent.method, "POST");
  assert.equal(plan.enrollmentKey, undefined);
});

test("setup planner does not infer static-secret setup from connector id alone", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "gmail",
    manifest: manifest("gmail", { network: { required: true } }),
  });
  assert.equal(plan.connectorModality, "api_network");
  assert.equal(plan.setupModality, "unsupported");
  assert.equal(plan.supportState, "unsupported");
});

test("setup planner distinguishes unsupported network connectors from static-secret connectors", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "notion",
    manifest: manifest("notion", { network: { required: true } }),
  });
  assert.equal(plan.connectorModality, "api_network");
  assert.equal(plan.setupModality, "unsupported");
  assert.equal(plan.supportState, "unsupported");
  assert.equal(plan.catalogDisposition, "api_network_unsupported");
  assert.equal(plan.proofGate, null);
  assert.equal(plan.runbookPath, null);
});

test("setup planner distinguishes provider app readiness from owner authorization", () => {
  const providerManifest = {
    ...manifest("fitness-oauth", { network: { required: true } }),
    capabilities: {
      auth: {
        deployment_config: ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"],
        kind: "oauth",
      },
    },
  };
  const blocked = buildConnectionSetupPlan({
    connectorKey: "fitness-oauth",
    manifest: providerManifest,
  });
  assert.equal(blocked.connectorModality, "api_network");
  assert.equal(blocked.setupModality, "provider_authorization");
  assert.equal(blocked.supportState, "needs_deployment_config");
  assert.equal(blocked.catalogDisposition, "provider_auth_deployment_blocked");
  assert.equal(blocked.nextStepKind, "needs_deployment_config");
  assert.equal(blocked.proofGate, "provider_app_deployment_config_missing");
  assert.equal(blocked.deploymentReadiness.state, "needs_config");
  assert.deepEqual(
    blocked.deploymentReadiness.blockers.map((item) => item.key),
    ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"]
  );
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const blockedSecondBlocker = blocked.deploymentReadiness.blockers[1];
  assert.ok(blockedSecondBlocker);
  assert.equal(blockedSecondBlocker.secret, true);
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(blocked.ownerAgentIntent.reason, /provider application/i);

  // Readiness follows the manifest's declared settings against the observed
  // deployment, so a ready deployment is described by supplying them.
  const readyButUnproven = buildConnectionSetupPlan({
    configuredProviderAuthConnectorKeys: ["fitness-oauth"],
    connectorKey: "fitness-oauth",
    deploymentEnv: {
      FITNESS_OAUTH_CLIENT_ID: "test-client-id",
      FITNESS_OAUTH_CLIENT_SECRET: "test-client-secret",
    },
    manifest: providerManifest,
  });
  assert.equal(readyButUnproven.deploymentReadiness.state, "ready");
  assert.equal(readyButUnproven.supportState, "proof_gated");
  assert.equal(readyButUnproven.catalogDisposition, "provider_auth_proof_gated");
  assert.equal(readyButUnproven.nextStepKind, "manual_runbook");
  assert.equal(readyButUnproven.ownerAgentIntent.status, "proof_gated");
  assert.equal(readyButUnproven.ownerAgentIntent.nextStepKind, "manual_runbook");
  assert.equal(readyButUnproven.proofGate, "provider_authorization_lifecycle_missing");
});

test("setup planner classifies Google Maps Data Portability as deployment-blocked provider auth", async () => {
  const googleMapsManifest = (
    await import("../../packages/polyfill-connectors/manifests/google_maps_data_portability.json", {
      with: { type: "json" },
    })
  ).default;
  const plan = buildConnectionSetupPlan({
    connectorKey: "google-maps-data-portability",
    manifest: googleMapsManifest as unknown as ConnectorManifestLike,
  });

  assert.equal(plan.connectorModality, "api_network");
  assert.equal(plan.setupModality, "provider_authorization");
  assert.equal(plan.supportState, "needs_deployment_config");
  assert.equal(plan.catalogDisposition, "provider_auth_deployment_blocked");
  assert.equal(plan.nextStepKind, "needs_deployment_config");
  assert.equal(plan.ownerAgentIntent.status, "needs_deployment_config");
  assert.equal(plan.ownerAgentIntent.nextStepKind, "needs_deployment_config");
  assert.equal(plan.proofGate, "provider_app_deployment_config_missing");
  assert.equal(plan.validationMode, "first_sync");
  assert.deepEqual(
    plan.deploymentReadiness.blockers.map((item) => item.key),
    ["GOOGLE_DATAPORTABILITY_CLIENT_ID", "GOOGLE_DATAPORTABILITY_CLIENT_SECRET", "GOOGLE_DATAPORTABILITY_REDIRECT_URI"]
  );
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const secondBlocker = plan.deploymentReadiness.blockers[1];
  assert.ok(secondBlocker);
  assert.equal(secondBlocker.secret, true);
  assert.ok(googleMapsManifest.capabilities.auth.resource_groups.includes("maps.vehicle_profile"));
  assert.ok(
    googleMapsManifest.capabilities.auth.scopes.includes(
      "https://www.googleapis.com/auth/dataportability.maps.starred_places"
    )
  );
  assert.equal(
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    googleMapsManifest.capabilities.auth.scopes.some((scope) => /gmail|userinfo|timeline/i.test(scope)),
    false
  );
});

test("classifyConnectorSetupModality separates binding class from setup class", () => {
  assert.equal(classifyConnectorSetupModality("gmail", staticSecretManifest("gmail", "app_password")), "static_secret");
  assert.equal(
    classifyConnectorSetupModality(
      "google-maps",
      manifest("google-maps", { filesystem: {} }, { setup: { modality: "manual_or_upload" } })
    ),
    "manual_or_upload"
  );
  assert.equal(classifyConnectorSetupModality("gmail", manifest("gmail", { network: {} })), "unsupported");
  assert.equal(
    classifyConnectorSetupModality("oauth-source", {
      ...manifest("oauth-source", { network: {} }),
      capabilities: { auth: { kind: "oauth" } },
    }),
    "provider_authorization"
  );
  assert.equal(classifyConnectorSetupModality("notion", manifest("notion", { network: {} })), "unsupported");
});

test("setup planner returns typed unknown for missing manifests", () => {
  const plan = buildConnectionSetupPlan({ connectorKey: "bogus", manifest: null });
  assert.equal(plan.connectorKey, "bogus");
  assert.equal(plan.connectorModality, "unknown");
  assert.equal(plan.supportState, "unsupported");
  assert.equal(plan.catalogDisposition, "unknown_unsupported");
  assert.equal(plan.ownerAgentIntent.status, "unsupported");
});

const EXPERIMENTAL_WAVE_0807_MANIFEST_FIXTURES = ["steam", "jellyfin", "apple_contacts"] as const;

test("wave-0807 static-secret connectors (Steam, Jellyfin, Apple Contacts) surface as experimental opt-in, not hidden", async () => {
  for (const connectorId of EXPERIMENTAL_WAVE_0807_MANIFEST_FIXTURES) {
    const shippedManifest =
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture loads over a fixed short list read clearer than Promise.all here.
      (await import(`../../packages/polyfill-connectors/manifests/${connectorId}.json`, { with: { type: "json" } }))
        .default;
    const plan = buildConnectionSetupPlan({ connectorKey: connectorId, manifest: shippedManifest });
    assert.equal(plan.setupModality, "static_secret", `${connectorId}: setupModality`);
    assert.equal(plan.supportState, "experimental", `${connectorId}: supportState`);
    assert.equal(plan.catalogDisposition, "static_secret_experimental", `${connectorId}: catalogDisposition`);
    assert.equal(plan.ownerAgentIntent.status, "experimental", `${connectorId}: ownerAgentIntent.status`);
    assert.equal(plan.ownerAgentIntent.method, "POST", `${connectorId}: ownerAgentIntent.method — form is reachable`);
    assert.notEqual(plan.supportState, "proof_gated", `${connectorId}: must not silently hide a real setup path`);
  }
});

test("iMessage is a supported local_collector_enroll connector, not proof-gated", async () => {
  // iMessage reads chat.db via node:sqlite (no native module), so it ships in
  // the published @pdpp/local-collector bundle like Claude Code/Codex and is
  // registered in SUPPORTED_LOCAL_COLLECTOR_CONNECTORS — the enroll path
  // must reflect that, not the older filesystem-shaped-but-unproven state.
  const connectorId = "imessage";
  const shippedManifest = (
    await import(`../../packages/polyfill-connectors/manifests/${connectorId}.json`, { with: { type: "json" } })
  ).default;
  const plan = buildConnectionSetupPlan({ connectorKey: connectorId, manifest: shippedManifest });
  assert.equal(plan.connectorModality, "local_collector", `${connectorId}: connectorModality`);
  assert.equal(plan.catalogDisposition, "local_collector_enroll", `${connectorId}: catalogDisposition`);
  assert.equal(plan.nextStepKind, "enroll_local_collector", `${connectorId}: nextStepKind`);
  assert.equal(plan.supportState, "supported", `${connectorId}: supportState`);
  assert.equal(plan.proofGate, null, `${connectorId}: proofGate`);
});

test("google_takeout's committed manifest classifies as local_collector_enroll (bundled into @pdpp/local-collector)", async () => {
  // Google Takeout reads an already-extracted GOOGLE_TAKEOUT_DIR from the
  // local filesystem it runs on — exactly the local-collector shape, not a
  // browser-upload or provider-API connector. It is now bundled into
  // @pdpp/local-collector (SUPPORTED_LOCAL_COLLECTOR_CONNECTORS), so it must
  // classify as the proven, actionable disposition, not the unproven
  // `local_collector_unproven` disposition a filesystem-shaped connector
  // gets before it ships in that bundle (see the synthetic-manifest test
  // above asserting that disposition directly).
  const connectorId = "google_takeout";
  const shippedManifest = (
    await import(`../../packages/polyfill-connectors/manifests/${connectorId}.json`, { with: { type: "json" } })
  ).default;
  const plan = buildConnectionSetupPlan({ connectorKey: "google-takeout", manifest: shippedManifest });
  assert.equal(plan.connectorModality, "local_collector");
  assert.equal(plan.catalogDisposition, "local_collector_enroll");
  assert.equal(plan.supportState, "supported");
  assert.notEqual(plan.catalogDisposition, "local_collector_unproven");
});

test("Apple Photos and Google Messages are supported local_collector_enroll connectors, not proof-gated", async () => {
  // Both now ship in the published @pdpp/local-collector bundle
  // (LOCAL_COLLECTOR_DEFINITIONS + SUPPORTED_LOCAL_COLLECTOR_CONNECTORS +
  // tsconfig.build.json packaging), so Add Source must surface the guided
  // enroll path, not the proof-gated "classified but not advertised" state.
  // Real device/account proof (a macOS Photos.app export; a gmcli-paired
  // Android device) remains separately unverified — this test only asserts
  // the SETUP PATH is reachable, not that live collection has been proven.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["apple_photos", "apple-photos"],
    ["google_messages", "google-messages"],
  ];
  for (const [connectorId, connectorKey] of cases) {
    const shippedManifest =
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture loads over a fixed short list read clearer than Promise.all here.
      (await import(`../../packages/polyfill-connectors/manifests/${connectorId}.json`, { with: { type: "json" } }))
        .default;
    const plan = buildConnectionSetupPlan({ connectorKey, manifest: shippedManifest });
    assert.equal(plan.connectorModality, "local_collector", `${connectorId}: connectorModality`);
    assert.equal(plan.catalogDisposition, "local_collector_enroll", `${connectorId}: catalogDisposition`);
    assert.equal(plan.nextStepKind, "enroll_local_collector", `${connectorId}: nextStepKind`);
    assert.equal(plan.supportState, "supported", `${connectorId}: supportState`);
    assert.equal(plan.proofGate, null, `${connectorId}: proofGate`);
  }
});

test("wave-0807 GroupMe manifest is a static-secret experimental connector, not silently promoted to live-proven", async () => {
  // GroupMe's manifest now declares setup.modality: "static_secret" with a
  // real credential_capture block (access-token field), so it is eligible
  // for the experimental static-secret path — a deliberate change from the
  // earlier manual_action/no-credential_capture shape this test used to
  // assert against. Counterweight: GroupMe is not (and must not silently
  // become) a member of STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS, so it must
  // land on the unproven "experimental" branch, never the fully-supported
  // "static_secret_connect"/supported branch that live-proven connectors get.
  const groupmeManifest = (
    await import("../../packages/polyfill-connectors/manifests/groupme.json", { with: { type: "json" } })
  ).default;
  assert.equal(
    STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS.includes("groupme" as never),
    false,
    "GroupMe must not be added to the live-proven roster without a real dated live env-free run"
  );
  const plan = buildConnectionSetupPlan({ connectorKey: "groupme", manifest: groupmeManifest });
  assert.equal(plan.setupModality, "static_secret");
  assert.equal(plan.supportState, "experimental");
  assert.equal(plan.catalogDisposition, "static_secret_experimental");
  assert.equal(plan.proofGate, "static_secret_live_proof_missing");
  assert.notEqual(plan.catalogDisposition, "static_secret_connect");
  assert.notEqual(plan.supportState, "unsupported");
});

test("wave-0807 Google Calendar/Contacts keep the deployment-app vs owner-account split untouched", async () => {
  for (const connectorId of ["google_calendar", "google_contacts"]) {
    const shippedManifest =
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture loads over a fixed short list read clearer than Promise.all here.
      (await import(`../../packages/polyfill-connectors/manifests/${connectorId}.json`, { with: { type: "json" } }))
        .default;
    // Both halves state the deployment explicitly: readiness is measured
    // against the manifest's declared settings, so an empty environment is
    // what "no deployment config" means and the assertion cannot be flipped
    // by whatever the host machine happens to export.
    const blocked = buildConnectionSetupPlan({
      connectorKey: connectorId,
      deploymentEnv: {},
      manifest: shippedManifest,
    });
    assert.equal(blocked.setupModality, "provider_authorization", `${connectorId}: setupModality`);
    assert.equal(
      blocked.supportState,
      "needs_deployment_config",
      `${connectorId}: supportState without deployment config`
    );
    assert.equal(blocked.catalogDisposition, "provider_auth_deployment_blocked", `${connectorId}: catalogDisposition`);

    const configured = buildConnectionSetupPlan({
      configuredProviderAuthConnectorKeys: [connectorId],
      connectorKey: connectorId,
      deploymentEnv: {
        GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      },
      manifest: shippedManifest,
    });
    assert.equal(configured.deploymentReadiness.state, "ready", `${connectorId}: deployment app configured`);
    // Per-owner authorization is still unproven independent of deployment
    // config — the two facts stay distinct, exactly as designed.
    assert.equal(configured.supportState, "proof_gated", `${connectorId}: owner authorization still unproven`);
    assert.equal(configured.catalogDisposition, "provider_auth_proof_gated", `${connectorId}: catalogDisposition`);
  }
});

test("classifyConnectorIntentModality preserves filesystem over browser over network precedence", () => {
  assert.equal(classifyConnectorIntentModality(manifest("x", { network: {} })), "api_network");
  assert.equal(classifyConnectorIntentModality(manifest("x", { browser: {}, network: {} })), "browser_bound");
  assert.equal(classifyConnectorIntentModality(manifest("x", { browser: {}, filesystem: {} })), "local_collector");
  assert.equal(classifyConnectorIntentModality(null), "unknown");
});
