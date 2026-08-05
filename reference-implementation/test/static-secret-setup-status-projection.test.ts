// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { projectConnectionSetupStatus, projectStaticSecretSetupStatus } from "../runtime/static-secret-setup-status.ts";

// Pure-projection coverage for the static-secret setup-status view. No I/O — the
// route collects the durable evidence and passes it in. These lock the mapping
// of draft/active lifecycle onto the canonical ConnectionHealthState vocabulary.

const baseInstance = {
  connectorId: "gmail",
  connectorInstanceId: "cin_test",
  createdAt: "2026-06-10T00:00:00.000Z",
  displayName: "Gmail - owner@example.com",
  setupFields: { account_email: "owner@example.com" },
  status: "draft",
  updatedAt: "2026-06-10T00:00:00.000Z",
};

const NO_BROWSER_CREDENTIAL_REMEDIATION = /provider credential/i;
const NO_BROWSER_REENTER_REMEDIATION = /re-enter/i;
const SECURE_BROWSER_REMEDIATION = /secure browser/i;

test("draft without a credential projects awaiting_credential -> idle", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: null,
    credential: null,
    identityFieldName: "account_email",
    instance: baseInstance,
    lastRun: null,
  });
  assert.equal(status.setup_state, "awaiting_credential");
  assert.equal(status.health_state, "idle");
  assert.equal(status.pending, true);
  assert.equal(status.running, false);
  assert.equal(status.account_identity, "owner@example.com");
  assert.equal(status.object, "connection_setup_status");
  assert.equal(status.setup_kind, "static_secret");
  assert.equal(status.setup_material.label, "Provider credential");
  assert.equal(status.setup_material.present, false);
  assert.equal(status.credential.present, false);
  assert.equal(status.import_receipt, null);
  assert.equal(status.last_error, null);
});

test("draft with a credential and an in-flight run projects first_sync_running", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: { runId: "run_1", startedAt: "2026-06-10T00:01:00.000Z", status: "in_progress" },
    credential: { capturedAt: "2026-06-10T00:01:00.000Z", credentialKind: "app_password", present: true },
    identityFieldName: "account_email",
    instance: baseInstance,
    lastRun: null,
  });
  assert.equal(status.setup_state, "first_sync_running");
  assert.equal(status.health_state, "idle");
  assert.equal(status.running, true);
  assert.equal(status.setup_material.present, true);
  assert.ok(status.run, "expected a run projection");
  assert.equal(status.run.run_id, "run_1");
});

test("draft with a credential and no run projects first_sync_pending", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: null,
    credential: { capturedAt: null, credentialKind: "app_password", present: true },
    identityFieldName: "account_email",
    instance: baseInstance,
    lastRun: null,
  });
  assert.equal(status.setup_state, "first_sync_pending");
  assert.equal(status.pending, true);
  assert.equal(status.running, false);
});

test("draft with a failed last run projects first_sync_failed -> needs_attention with remediation", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: null,
    credential: { capturedAt: null, credentialKind: "app_password", present: true },
    identityFieldName: "account_email",
    instance: baseInstance,
    lastRun: { failureReason: "authentication_failed", runId: "run_1", status: "failed" },
  });
  assert.equal(status.setup_state, "first_sync_failed");
  assert.equal(status.health_state, "needs_attention");
  assert.ok(status.last_error);
  assert.equal(status.last_error.reason, "authentication_failed");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(status.last_error.remediation, /credential/i);
});

test("active instance projects active -> healthy and not pending", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: null,
    credential: { capturedAt: null, credentialKind: "app_password", present: true },
    identityFieldName: "account_email",
    instance: { ...baseInstance, status: "active" },
    lastRun: null,
  });
  assert.equal(status.setup_state, "active");
  assert.equal(status.health_state, "healthy");
  assert.equal(status.pending, false);
});

test("credential rotation metadata stays visible on setup status", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: null,
    credential: {
      capturedAt: "2026-06-10T00:01:00.000Z",
      credentialKind: "app_password",
      present: true,
      rotatedAt: "2026-06-11T00:01:00.000Z",
    },
    identityFieldName: "account_email",
    instance: { ...baseInstance, status: "active" },
    lastRun: null,
  });
  assert.equal(status.credential.captured_at, "2026-06-10T00:01:00.000Z");
  assert.equal(status.credential.rotated_at, "2026-06-11T00:01:00.000Z");
  assert.equal(status.setup_material.captured_at, "2026-06-11T00:01:00.000Z");
});

test("paused and revoked instances reflect their status and stay idle", () => {
  for (const instanceStatus of ["paused", "revoked"]) {
    const status = projectStaticSecretSetupStatus({
      activeRun: null,
      credential: { present: true },
      identityFieldName: "account_email",
      instance: { ...baseInstance, status: instanceStatus },
      lastRun: null,
    });
    assert.equal(status.setup_state, instanceStatus);
    assert.equal(status.health_state, "idle");
    assert.equal(status.pending, false);
  }
});

test("missing identity field name yields a null account_identity, never a throw", () => {
  const status = projectStaticSecretSetupStatus({
    activeRun: null,
    credential: null,
    identityFieldName: null,
    instance: { ...baseInstance, setupFields: null },
    lastRun: null,
  });
  assert.equal(status.account_identity, null);
  assert.equal(status.setup_state, "awaiting_credential");
});

const browserInstance = {
  connectorId: "chatgpt",
  connectorInstanceId: "cin_browser_test",
  createdAt: "2026-08-05T00:00:00.000Z",
  displayName: "ChatGPT",
  setupFields: null,
  status: "draft",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

test("browser-session draft with no run or credential projects awaiting_browser_login, never awaiting_credential", () => {
  const status = projectConnectionSetupStatus({
    activeRun: null,
    credential: null,
    identityFieldName: null,
    instance: browserInstance,
    lastRun: null,
    setupKind: "browser_session",
  });
  assert.equal(status.setup_kind, "browser_session");
  assert.equal(status.setup_state, "awaiting_browser_login");
  assert.notEqual(status.setup_state, "awaiting_credential");
  assert.equal(status.health_state, "idle");
  assert.equal(status.pending, true);
  assert.equal(status.setup_material.kind, "browser_session");
  assert.equal(status.setup_material.label, "Browser login");
  assert.equal(status.setup_material.present, false);
  assert.equal(status.credential.present, false);
});

test("browser-session draft with an active run projects first_sync_running even without stored credential", () => {
  const status = projectConnectionSetupStatus({
    activeRun: { runId: "run_browser_1", startedAt: "2026-08-05T00:01:00.000Z", status: "in_progress" },
    credential: null,
    identityFieldName: null,
    instance: browserInstance,
    lastRun: null,
    setupKind: "browser_session",
  });
  assert.equal(status.setup_state, "first_sync_running");
  assert.equal(status.running, true);
  assert.equal(status.credential.present, false);
  assert.equal(status.setup_material.present, false);
});

test("browser-session draft with a completed last run (no active run) projects first_sync_pending, not awaiting_browser_login", () => {
  const status = projectConnectionSetupStatus({
    activeRun: null,
    credential: null,
    identityFieldName: null,
    instance: browserInstance,
    lastRun: { failureReason: null, runId: "run_browser_2", status: "completed" },
    setupKind: "browser_session",
  });
  assert.equal(status.setup_state, "first_sync_pending");
});

test("browser-session draft with a failed last run projects first_sync_failed with browser-safe remediation", () => {
  const status = projectConnectionSetupStatus({
    activeRun: null,
    credential: null,
    identityFieldName: null,
    instance: browserInstance,
    lastRun: { failureReason: "login_challenge_timeout", runId: "run_browser_3", status: "failed" },
    setupKind: "browser_session",
  });
  assert.equal(status.setup_state, "first_sync_failed");
  assert.equal(status.health_state, "needs_attention");
  assert.ok(status.last_error);
  assert.equal(status.last_error.reason, "login_challenge_timeout");
  assert.doesNotMatch(status.last_error.remediation, NO_BROWSER_CREDENTIAL_REMEDIATION);
  assert.doesNotMatch(status.last_error.remediation, NO_BROWSER_REENTER_REMEDIATION);
  assert.match(status.last_error.remediation, SECURE_BROWSER_REMEDIATION);
});

test("browser-session active instance projects active -> healthy regardless of stored credential", () => {
  const status = projectConnectionSetupStatus({
    activeRun: null,
    credential: null,
    identityFieldName: null,
    instance: { ...browserInstance, status: "active" },
    lastRun: null,
    setupKind: "browser_session",
  });
  assert.equal(status.setup_state, "active");
  assert.equal(status.health_state, "healthy");
  assert.equal(status.pending, false);
});

test("manual/upload draft projects captured import file without credential semantics", () => {
  const status = projectConnectionSetupStatus({
    activeRun: { runId: "run_import", startedAt: "2026-06-10T00:02:00.000Z", status: "in_progress" },
    credential: null,
    importReceipt: {
      acceptedCount: 0,
      acquisitionMethod: "owner_artifact",
      batchId: "ab_test",
      dateRange: { end: "2024-06-05T13:45:22.000Z", start: "2024-06-05T13:45:22.000Z" },
      detectedFormat: "legacy_records",
      duplicateCount: 0,
      estimatedPoints: 1,
      estimatedSegments: 0,
      failedCount: 0,
      parsedCount: 1,
      skippedCount: 0,
      status: "valid",
      uploadedFileName: "Timeline.json",
    },
    instance: {
      ...baseInstance,
      connectorId: "google-maps",
      displayName: "Google Maps Timeline Import",
      setupFields: null,
    },
    lastRun: null,
    setupKind: "manual_upload",
    setupMaterial: {
      capturedAt: null,
      kind: "manual_upload",
      label: "Import file (Timeline.json)",
      present: true,
    },
  });
  assert.equal(status.object, "connection_setup_status");
  assert.equal(status.setup_kind, "manual_upload");
  assert.equal(status.setup_state, "first_sync_running");
  assert.equal(status.setup_material.label, "Import file (Timeline.json)");
  assert.equal(status.setup_material.present, true);
  assert.equal(status.credential.present, false);
  assert.ok(status.import_receipt, "expected an import receipt projection");
  assert.equal(status.import_receipt.batch_id, "ab_test");
  assert.equal(status.import_receipt.status, "valid");
  assert.equal(status.import_receipt.detected_format, "legacy_records");
  assert.equal(status.import_receipt.parsed_count, 1);
  assert.equal(status.import_receipt.accepted_count, 0);
  assert.equal(status.import_receipt.estimated_points, 1);
  assert.equal(status.import_receipt.estimated_segments, 0);
  assert.ok(status.import_receipt.date_range, "expected a date_range projection");
  assert.equal(status.import_receipt.date_range.start, "2024-06-05T13:45:22.000Z");
  assert.equal(status.import_receipt.uploaded_file_name, "Timeline.json");
  assert.equal(status.import_receipt.acquisition_method, "owner_artifact");
});
