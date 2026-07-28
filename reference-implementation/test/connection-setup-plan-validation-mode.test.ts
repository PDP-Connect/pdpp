// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The setup planner advertises a per-connector credential `validationMode`
// (`synchronous` | `first_sync`) projected from the reference-only probe
// registry. Console, owner-agent intent, and CLI all read this single field; no
// surface invents its own. This proves the planner projection and that the
// mode carries no secret.

import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialValidationMode,
  hasCredentialProbe,
} from "../../packages/polyfill-connectors/src/credential-probe.ts";
import type { ConnectorManifestLike } from "../server/connection-setup-plan.ts";
import { buildConnectionSetupPlan } from "../server/connection-setup-plan.ts";

function manifest(connectorId: string, extra: Partial<ConnectorManifestLike> = {}): ConnectorManifestLike {
  return {
    connector_id: `https://registry.pdpp.org/connectors/${connectorId}`,
    connector_key: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { network: { required: true } } },
    ...extra,
  };
}

function staticSecretManifest(connectorId: string, credentialKind: string): ConnectorManifestLike {
  return manifest(connectorId, {
    setup: {
      credential_capture: {
        fields: [{ label: "Provider secret", name: "secret", required: true, secret: true, type: "password" }],
        kind: credentialKind,
        label: `${connectorId} secret`,
      },
      modality: "static_secret",
    },
  });
}

test("gmail and github advertise synchronous validation; an unknown static-secret connector advertises first_sync", () => {
  assert.equal(hasCredentialProbe("gmail"), true);
  assert.equal(hasCredentialProbe("github"), true);
  assert.equal(hasCredentialProbe("ynab"), false);
  assert.equal(credentialValidationMode("gmail"), "synchronous");
  assert.equal(credentialValidationMode("ynab"), "first_sync");
});

test("the setup plan carries validationMode for static-secret connectors", () => {
  const gmail = buildConnectionSetupPlan({
    connectorKey: "gmail",
    manifest: staticSecretManifest("gmail", "app_password"),
  });
  assert.equal(gmail.setupModality, "static_secret");
  assert.equal(gmail.validationMode, "synchronous");

  const github = buildConnectionSetupPlan({
    connectorKey: "github",
    manifest: staticSecretManifest("github", "personal_access_token"),
  });
  assert.equal(github.validationMode, "synchronous");

  // A static-secret connector with no registered probe takes the first-sync path.
  const ynab = buildConnectionSetupPlan({ connectorKey: "ynab", manifest: staticSecretManifest("ynab", "api_key") });
  assert.equal(ynab.setupModality, "static_secret");
  assert.equal(ynab.validationMode, "first_sync");
});

test("non-static-secret modalities always advertise first_sync", () => {
  const localCollector = buildConnectionSetupPlan({
    connectorKey: "claude_code",
    manifest: manifest("claude_code", { runtime_requirements: { bindings: { filesystem: { required: true } } } }),
  });
  assert.equal(localCollector.setupModality, "local_collector");
  assert.equal(localCollector.validationMode, "first_sync");

  const browser = buildConnectionSetupPlan({
    connectorKey: "amazon",
    manifest: manifest("amazon", { runtime_requirements: { bindings: { browser: { required: true } } } }),
  });
  assert.equal(browser.setupModality, "browser_bound");
  assert.equal(browser.validationMode, "first_sync");
});

test("validationMode is a bare enum and never carries credential material", () => {
  const plan = buildConnectionSetupPlan({
    connectorKey: "gmail",
    manifest: staticSecretManifest("gmail", "app_password"),
  });
  assert.ok(["synchronous", "first_sync"].includes(plan.validationMode));
  // The whole plan is non-secret; the validation field is just a mode string.
  assert.ok(!JSON.stringify(plan).toLowerCase().includes("password "));
});
