// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { EmittedMessage } from "./connector-runtime-protocol.ts";
import {
  DEFAULT_SAFE_DIAGNOSTICS_POLICY,
  sanitizeSafeDiagnosticInfo,
  sanitizeSafeDiagnosticPayload,
  sanitizeSafeEmission,
  withDiagnosticDeadline,
} from "./safe-diagnostics.ts";

function asEmittedMessage(value: unknown): EmittedMessage {
  return value as EmittedMessage;
}

test("the safe emission boundary closes runtime progress and DONE bypasses", () => {
  const raw = "account=ACCT-123 transaction=PRIVATE token=SECRET https://usaa.test/private";
  const progress = sanitizeSafeEmission({
    type: "PROGRESS",
    message: raw,
    stream: raw,
    count: Number.MAX_SAFE_INTEGER,
  });
  const done = sanitizeSafeEmission({
    type: "DONE",
    status: "failed",
    records_emitted: Number.MAX_SAFE_INTEGER,
    error: { code: raw, message: raw, retryable: true },
  });

  assert.deepEqual(progress, { type: "PROGRESS", message: "Progress", stream: "unknown", count: 1_000_000 });
  assert.deepEqual(done, {
    type: "DONE",
    status: "failed",
    records_emitted: 1_000_000,
    error: { code: "unknown", message: "Connector failure (network)", retryable: true },
  });
  assert.doesNotMatch(JSON.stringify({ progress, done }), /ACCT-123|PRIVATE|SECRET|https?:\/\//u);
});

test("the shared diagnostic boundary preserves structural state but drops mutation values", () => {
  const raw = "account-123 token=SECRET PRIVATE MERCHANT https://usaa.test/private";
  const policy = {
    ...DEFAULT_SAFE_DIAGNOSTICS_POLICY,
    phaseAllowlist: new Set(["known_phase"]),
  };
  const safe = sanitizeSafeDiagnosticInfo(
    {
      account_page_identity: "exact",
      artifact: {
        candidates: [
          {
            bodyBytes: 11,
            bodyError: `raw body ${raw}`,
            contentDisposition: `attachment; filename="${raw}.csv"`,
            contentType: "text/csv",
            method: "POST",
            reason: "body_error",
            source: "playwright",
            status: 200,
            url: `https://usaa.test/export/${raw}?token=SECRET`,
          },
        ],
        cdpError: `raw error ${raw}`,
        cdpReady: true,
        totalCdpRequestsStarted: 1,
        totalCdpResponsesSeen: 1,
        totalResponsesSeen: 1,
      },
      diag: {
        dialogs_open: 1,
        export_candidates: [{ cls: raw, id: raw, tag: "button", text: raw }],
        has_utility_bar: true,
        nav_candidates: [{ cls: raw, id: raw, tag: "BUTTON", text: raw }],
        title: raw,
        url: `https://usaa.test/my/checking?account=${raw}`,
      },
      download: {
        bytes: 12,
        contentDisposition: "attachment; filename=statement.csv",
        contentType: "text/csv; charset=utf-8",
        csvHeader: "present",
        method: "GET",
        pdfMagic: "absent",
        status: 200,
        suggestedFilename: "statement.csv",
        url: `https://usaa.test/export/transactions?token=${raw}`,
      },
      error: `raw error ${raw}`,
      phase: "known_phase",
      surface_manifest: {
        capture_state: "captured",
        candidate_count: 1,
        candidates: [
          {
            aria_disabled: false,
            class_tokens: `as_credit__export ${raw}`,
            disabled: false,
            kind: "export",
            role: "button",
            tag: "BUTTON",
            text: raw,
            type: "button",
            visible: true,
          },
        ],
        control_count: 1,
        controls: [
          {
            aria_disabled: false,
            class_tokens: `dialog-control ${raw}`,
            disabled: false,
            name: raw,
            role: "combobox",
            tag: "SELECT",
            text: raw,
            type: null,
            visible: true,
          },
        ],
        phase: "after_export_affordance_probe",
      },
    },
    policy
  );
  const serialized = JSON.stringify(safe);

  assert.equal(safe.phase, "known_phase");
  assert.equal(safe.account_page_identity, "exact");
  assert.equal(
    (safe.surface_manifest as { candidates: Array<{ class_tokens: string[] }> }).candidates[0]?.class_tokens[0],
    "as_credit__export"
  );
  assert.equal((safe.surface_manifest as { controls: Array<{ name: string | null }> }).controls[0]?.name, null);
  assert.deepEqual(safe.download, {
    bytes: 12,
    contentDisposition: "attachment",
    contentType: "text/csv",
    csvHeader: "present",
    filenameShape: ".csv",
    method: "GET",
    pathShape: "/export/transactions",
    pdfMagic: "absent",
    source: null,
    status: 200,
    suggestedFilename: null,
    url: null,
  });
  assert.doesNotMatch(serialized, /account-123|token=SECRET|PRIVATE MERCHANT|https?:\/\//u);
});

test("a wedged diagnostic Playwright evaluation fails closed at its deadline", async () => {
  let evaluations = 0;
  const result = await withDiagnosticDeadline(() => {
    evaluations += 1;
    return new Promise<string>(() => undefined);
  }, 5);

  assert.equal(result, null);
  assert.equal(evaluations, 1);
});

test("safe diagnostic payloads never copy arbitrary request or response fields", () => {
  const raw = "request_id=REQ-123 path=/accounts/ACCT token=SECRET";
  const safe = sanitizeSafeDiagnosticPayload({
    browser_surface: {
      account_detail_marker_count: 1,
      managed_surface: "managed",
      route: "expected",
      surface: "usaa_transaction_export",
      request_id: raw,
      url: `https://usaa.test/${raw}`,
      error: raw,
    },
    request: raw,
    response_body: raw,
    token: raw,
  });

  assert.equal((safe.browser_surface as { route: string }).route, "expected");
  assert.doesNotMatch(JSON.stringify(safe), /REQ-123|ACCT|SECRET|https?:\/\//u);
});

test("safe emission returns fixed finite fallbacks for hostile top-level values", () => {
  const throwingTopLevel = new Proxy(
    { type: "PROGRESS", message: "raw secret" },
    {
      get() {
        throw new Error("secret-getter");
      },
    }
  );
  const safeTopLevel = sanitizeSafeEmission(asEmittedMessage(throwingTopLevel));
  assert.deepEqual(safeTopLevel, {
    error: { code: "unknown", message: "Connector failure (unknown)", retryable: false },
    records_emitted: 0,
    status: "failed",
    type: "DONE",
  });

  const safeArray = sanitizeSafeEmission(asEmittedMessage(["raw secret"]));
  assert.deepEqual(safeArray, safeTopLevel);

  const unknownStatus = sanitizeSafeEmission(
    asEmittedMessage({ type: "DONE", status: "raw-status", records_emitted: 9_999_999 })
  );
  assert.deepEqual(unknownStatus, { records_emitted: 1_000_000, status: "failed", type: "DONE" });
});

test("safe emission contains nested throwing getters, proxies, Error.message, and String traps", () => {
  const throwingProgress = Object.defineProperties(
    { type: "PROGRESS" },
    {
      message: {
        get() {
          throw new Error("secret-progress-getter");
        },
      },
    }
  );
  assert.deepEqual(sanitizeSafeEmission(asEmittedMessage(throwingProgress)), {
    message: "Progress",
    type: "PROGRESS",
  });

  const throwingDiagnostics = new Proxy(
    { phase: "known_phase", error: "raw diagnostics" },
    {
      get() {
        throw new Error("secret-diagnostics-getter");
      },
    }
  );
  const safeSkip = sanitizeSafeEmission(
    asEmittedMessage({
      diagnostics: throwingDiagnostics,
      message: "raw skip message",
      reason: "raw reason",
      stream: "raw stream",
      type: "SKIP_RESULT",
    })
  );
  assert.deepEqual(safeSkip, {
    diagnostics: { diagnostic: "sanitized" },
    message: "Safe diagnostic skipped: diagnostic_sanitized",
    reason: "diagnostic_sanitized",
    stream: "unknown",
    type: "SKIP_RESULT",
  });

  const throwingErrorMessage = new Error("raw error");
  Object.defineProperty(throwingErrorMessage, "message", {
    configurable: true,
    get() {
      throw new Error("secret-error-message");
    },
  });
  const stringTrap = new Proxy(Object.create(null), {
    get() {
      throw new Error("secret-string-trap");
    },
  });
  const safeDone = sanitizeSafeEmission(
    asEmittedMessage({
      error: { code: "unknown", message: throwingErrorMessage, retryable: true },
      records_emitted: 1,
      status: "failed",
      type: "DONE",
    })
  );
  const safeDoneStringTrap = sanitizeSafeEmission(
    asEmittedMessage({
      error: { code: "unknown", message: stringTrap, retryable: true },
      records_emitted: 1,
      status: "failed",
      type: "DONE",
    })
  );
  assert.deepEqual(safeDone, {
    error: { code: "unknown", message: "Connector failure (unknown)", retryable: true },
    records_emitted: 1,
    status: "failed",
    type: "DONE",
  });
  assert.deepEqual(safeDoneStringTrap, safeDone);
});

test("safe diagnostic info fails closed for top-level, nested, own-property, and array traps", () => {
  const throwingTopLevel = new Proxy(
    { diag: { dialogs_open: 1 }, phase: "known_phase" },
    {
      get() {
        throw new Error("secret-top-level-getter");
      },
    }
  );
  assert.deepEqual(sanitizeSafeDiagnosticInfo(throwingTopLevel), { diag: null, phase: "unknown" });

  const throwingNested = new Proxy(
    { dialogs_open: 1 },
    {
      get() {
        throw new Error("secret-nested-getter");
      },
    }
  );
  assert.deepEqual(sanitizeSafeDiagnosticInfo({ diag: throwingNested, phase: "known_phase" }), {
    diag: null,
    phase: "unknown",
  });

  const throwingOwnProperty = new Proxy(
    { phase: "known_phase", error: "raw error" },
    {
      getOwnPropertyDescriptor() {
        throw new Error("secret-own-property-trap");
      },
    }
  );
  assert.deepEqual(sanitizeSafeDiagnosticInfo(throwingOwnProperty), {
    diag: null,
    diagnostic: "sanitized",
    phase: "unknown",
  });

  assert.deepEqual(sanitizeSafeDiagnosticInfo([]), {
    diag: null,
    diagnostic: "sanitized",
    phase: "unknown",
  });
  assert.deepEqual(
    sanitizeSafeDiagnosticInfo({
      error: new Proxy(Object.create(null), {
        get() {
          throw new Error("secret");
        },
      }),
    }),
    { diag: null, error: "unknown", phase: "unknown" }
  );
});
