// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  browserSurfaceManagedState,
  buildBrowserSurfaceCandidateManifest,
  buildBrowserSurfaceDiagnostic,
} from "./browser-surface-diagnostic.ts";

function chaseInput(overrides: Record<string, unknown> = {}) {
  return {
    activityTableMarkerCount: 1,
    dashboardMarkerCount: 1,
    kind: "chase_current_activity",
    managedSurface: "unknown",
    parserCount: 3,
    readCount: 1,
    route: "expected",
    targetCount: 3,
    verifiedEmptyMarkerCount: 0,
    waitOutcome: "not_needed",
    ...overrides,
  };
}

test("browser surface diagnostic maps only runtime launch posture", () => {
  assert.equal(browserSurfaceManagedState("managed_neko"), "managed");
  assert.equal(browserSurfaceManagedState("legacy_remote_cdp"), "legacy_remote");
  assert.equal(browserSurfaceManagedState("isolated_local"), "isolated");
  assert.equal(browserSurfaceManagedState("https://private.example/?token=secret"), "unknown");
});

test("browser surface diagnostic records recognized, empty, parser-zero, and unexpected structural states", () => {
  const recognized = buildBrowserSurfaceDiagnostic(chaseInput());
  const verifiedEmpty = buildBrowserSurfaceDiagnostic(
    chaseInput({ parserCount: 0, targetCount: 0, verifiedEmptyMarkerCount: 1 })
  );
  const parserZero = buildBrowserSurfaceDiagnostic(
    chaseInput({ parserCount: 0, targetCount: 0, verifiedEmptyMarkerCount: 0 })
  );
  const unexpected = buildBrowserSurfaceDiagnostic(
    chaseInput({
      activityTableMarkerCount: 0,
      dashboardMarkerCount: 0,
      parserCount: 0,
      route: "unknown",
      targetCount: 0,
    })
  );

  assert.equal(recognized?.posture, "recognized");
  assert.equal(verifiedEmpty?.posture, "verified_empty");
  assert.equal(parserZero?.posture, "parser_zero");
  assert.equal(unexpected?.posture, "unexpected");
});

test("browser surface diagnostic rejects free text, URLs, identifiers, invalid enums, and fixture references", () => {
  const input = chaseInput({
    fixture: { reference: "usaa/accounts/account-12345678.html", sha256: "a".repeat(64) },
    kind: "alice_smith_private",
    managedSurface: "owner_cookie_value",
    route: "https://private.example/?token=raw-secret",
    waitOutcome: "raw_dom_text",
  });
  const diagnostic = buildBrowserSurfaceDiagnostic(input);

  assert.equal(diagnostic, null);
  assert.doesNotMatch(JSON.stringify(diagnostic), /alice|private\.example|account-12345678|raw-secret/i);
});

test("browser surface diagnostic has a fixed finite structural shape", () => {
  const diagnostic = buildBrowserSurfaceDiagnostic(
    chaseInput({ parserCount: Number.POSITIVE_INFINITY, readCount: 1.5, targetCount: 9_999_999 })
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.parser_count, 0);
  assert.equal(diagnostic.read_count, 0);
  assert.equal(diagnostic.target_count, 1_000_000);
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "account_detail_marker_count",
    "activity_table_marker_count",
    "dashboard_marker_count",
    "managed_surface",
    "navigation_marker_count",
    "parser_count",
    "phase",
    "posture",
    "read_count",
    "route",
    "surface",
    "target_count",
    "transaction_marker_count",
    "verified_empty_marker_count",
    "wait_outcome",
  ]);
});

test("surface candidate manifests retain selector state while dropping sensitive values", () => {
  const manifest = buildBrowserSurfaceCandidateManifest({
    candidateCount: 4,
    candidates: [
      {
        aria_disabled: false,
        class_tokens: "as_credit__utility-bar-item as_credit__export account-123456",
        disabled: false,
        kind: "export",
        role: "button",
        tag: "BUTTON",
        text: "Export for account 123456 with transaction at PRIVATE MERCHANT",
        type: "button",
        visible: true,
      },
      {
        aria_disabled: true,
        class_tokens: ["export", "dynamic-123"],
        disabled: true,
        kind: "export",
        role: "button",
        tag: "BUTTON",
        text: "Export",
        type: "button",
        visible: false,
      },
      {
        aria_disabled: false,
        class_tokens: "download-link",
        disabled: false,
        kind: "download",
        role: "link",
        tag: "A",
        text: "Download statement for PRIVATE MERCHANT",
        type: null,
        visible: true,
      },
    ],
    controlCount: 1,
    controls: [
      {
        aria_disabled: false,
        class_tokens: "dialog-control",
        disabled: false,
        name: "selectionType",
        role: "combobox",
        tag: "SELECT",
        text: "PRIVATE MERCHANT 123456",
        type: null,
        visible: true,
      },
    ],
    phase: "after_export_affordance_probe",
  });

  assert.equal(manifest.candidate_count, 4, "the total candidate count survives the cap");
  assert.equal(manifest.candidates[0]?.tag, "button");
  assert.deepEqual(manifest.candidates[0]?.class_tokens, ["as_credit__utility-bar-item", "as_credit__export"]);
  assert.equal(manifest.candidates[0]?.text_category, "export");
  assert.equal(manifest.candidates[1]?.disabled, true);
  assert.equal(manifest.candidates[1]?.visible, false);
  assert.equal(manifest.controls[0]?.name, "selectionType");
  assert.equal(manifest.controls[0]?.role, "combobox");
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /123456|PRIVATE MERCHANT|account-/);
  assert.doesNotMatch(serialized, /"(?:text|id|href|url)"/);
});
