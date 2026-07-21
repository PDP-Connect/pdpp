import assert from "node:assert/strict";
import test from "node:test";

import { browserSurfaceManagedState, buildBrowserSurfaceDiagnostic } from "./browser-surface-diagnostic.ts";

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
