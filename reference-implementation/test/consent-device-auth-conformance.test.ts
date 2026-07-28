// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Consent + owner-device-auth conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/consent-device-auth-conformance.js` against the current
 * SQLite-backed reference auth helpers (`initiateGrant`, `approveGrant`,
 * `denyGrant`, `getPendingConsent`, `getPendingConsentRowByApprovalId`,
 * `initiateOwnerDeviceAuthorization`, `approveOwnerDeviceAuthorization`,
 * `denyOwnerDeviceAuthorization`, `exchangeOwnerDeviceCode`,
 * `getOwnerDeviceAuthorizationByUserCode`, `getOwnerDeviceAuthRowByApprovalId`).
 *
 * Replaces nothing on its own; the focused route-level auth/security suites
 * (`owner-auth.test.js`, `owner-csrf.test.js`,
 * `security-device-code-exposure.test.js`,
 * `security-consent-token-handoff.test.js`) remain as direct evidence
 * alongside this conformance run. See worker report for rationale.
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";

import { runConsentDeviceAuthConformance } from "./helpers/consent-device-auth-conformance.ts";
import { createSqliteConsentDeviceAuthDriver } from "./helpers/sqlite-consent-device-auth-driver.ts";

function stringProperty(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberProperty(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordArrayProperty(input: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const value = input[key];
  if (!Array.isArray(value)) {
    return;
  }
  return value.filter(isRecord);
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected a result object");
  return value;
}

function approvalResult(value: unknown): { access_token?: string; grant?: { grant_id: string }; token?: string } {
  const result = recordValue(value);
  const { access_token: accessToken, grant, token } = result;
  const grantRecord = isRecord(grant) ? grant : null;
  const grantId = grantRecord?.grant_id;
  return {
    ...(typeof grantId === "string" ? { grant: { grant_id: grantId } } : {}),
    ...(typeof token === "string" ? { token } : {}),
    ...(typeof accessToken === "string" ? { access_token: accessToken } : {}),
  };
}

runConsentDeviceAuthConformance({
  label: "sqlite-reference",
  makeDriver: () => {
    const driver = createSqliteConsentDeviceAuthDriver();
    return {
      ...driver,
      async approveOwnerDeviceAuth(code: string) {
        return approvalResult(await driver.approveOwnerDeviceAuth(code));
      },
      async approvePendingConsent(uri: string) {
        return approvalResult(await driver.approvePendingConsent(uri));
      },
      async exchangeOwnerDeviceCode(input: Record<string, string>) {
        return approvalResult(
          await driver.exchangeOwnerDeviceCode({
            ...(input.client_id ? { client_id: input.client_id } : {}),
            ...(input.device_code ? { device_code: input.device_code } : {}),
          })
        );
      },
      async lookupOwnerDeviceAuthByApprovalId(id: string) {
        const view = await driver.lookupOwnerDeviceAuthByApprovalId(id);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.status === "string" ? { status: view.status } : {}),
          ...(typeof view.approval_id === "string" ? { approval_id: view.approval_id } : {}),
          ...(typeof view.client_id === "string" ? { client_id: view.client_id } : {}),
          ...(typeof view.subject_id === "string" || view.subject_id === null ? { subject_id: view.subject_id } : {}),
        };
      },
      async lookupOwnerDeviceAuthByUserCode(code: string) {
        const view = await driver.lookupOwnerDeviceAuthByUserCode(code);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.client_id === "string" ? { client_id: view.client_id } : {}),
          ...(typeof view.interval === "number" ? { interval: view.interval } : {}),
          ...(typeof view.created_at === "string" || view.created_at === null ? { created_at: view.created_at } : {}),
          ...(typeof view.expires_at === "string" || view.expires_at === null ? { expires_at: view.expires_at } : {}),
        };
      },
      async lookupPendingConsentByApprovalId(id: string) {
        const view = await driver.lookupPendingConsentByApprovalId(id);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.status === "string" ? { status: view.status } : {}),
          ...(typeof view.approval_id === "string" ? { approval_id: view.approval_id } : {}),
          ...(typeof view.grant_id === "string" || view.grant_id === null ? { grant_id: view.grant_id } : {}),
          ...(typeof view.subject_id === "string" || view.subject_id === null ? { subject_id: view.subject_id } : {}),
        };
      },
      async lookupPendingConsentByRequestUri(uri: string) {
        const view = await driver.lookupPendingConsentByRequestUri(uri);
        if (view === null) {
          return null;
        }
        return {
          ...(typeof view.user_code === "string" ? { user_code: view.user_code } : {}),
          ...(typeof view.created_at === "string" || view.created_at === null ? { created_at: view.created_at } : {}),
          ...(typeof view.expires_at === "string" || view.expires_at === null ? { expires_at: view.expires_at } : {}),
        };
      },
      async startOwnerDeviceAuth(input: Record<string, unknown>) {
        const clientId = stringProperty(input, "client_id");
        const interval = numberProperty(input, "interval");
        const expiresIn = numberProperty(input, "expires_in");
        const result = await driver.startOwnerDeviceAuth({
          ...(clientId === undefined ? {} : { client_id: clientId }),
          ...(interval === undefined ? {} : { interval }),
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        });
        assert.ok(typeof result.device_code === "string", "owner device start returns a device code");
        assert.ok(typeof result.user_code === "string", "owner device start returns a user code");
        assert.ok(typeof result.approval_id === "string", "owner device start returns an approval ID");
        assert.ok(typeof result.interval === "number", "owner device start returns a polling interval");
        assert.ok(typeof result.expires_in === "number", "owner device start returns an expiry interval");
        return {
          approval_id: result.approval_id,
          device_code: result.device_code,
          expires_in: result.expires_in,
          interval: result.interval,
          user_code: result.user_code,
        };
      },
      async startPendingConsent(input: Record<string, unknown>) {
        const purposeCode = stringProperty(input, "purpose_code");
        const purposeDescription = stringProperty(input, "purpose_description");
        const accessMode = stringProperty(input, "access_mode");
        const streams = recordArrayProperty(input, "streams");
        const result = await driver.startPendingConsent({
          ...(purposeCode === undefined ? {} : { purpose_code: purposeCode }),
          ...(purposeDescription === undefined ? {} : { purpose_description: purposeDescription }),
          ...(accessMode === undefined ? {} : { access_mode: accessMode }),
          ...(streams === undefined ? {} : { streams }),
        });
        assert.ok(typeof result.request_uri === "string", "pending consent start returns a request URI");
        assert.ok(typeof result.approval_id === "string", "pending consent start returns an approval ID");
        return { approval_id: result.approval_id, request_uri: result.request_uri };
      },
    };
  },
  test,
});
