import assert from "node:assert/strict";
import test from "node:test";
import {
  formatConnectorKeyForDisplay,
  formatConnectorNameForDisplay,
  formatSourceForDisplay,
} from "./connector-display.ts";

test("connector display key strips registry connector URLs to their canonical key", () => {
  assert.equal(formatConnectorKeyForDisplay("https://registry.pdpp.org/connectors/gmail"), "gmail");
});

test("connector display key hides arbitrary URL origins", () => {
  assert.equal(formatConnectorKeyForDisplay("https://example.com/custom/connectors/github"), "github");
});

test("connector display key normalizes local-device and legacy connector labels", () => {
  assert.equal(formatConnectorKeyForDisplay("local-device:claude_code:desktop"), "claude-code");
  assert.equal(formatConnectorKeyForDisplay("legacy_default"), "default connection");
  assert.notEqual(formatConnectorKeyForDisplay("legacy"), "legacy");
});

test("connector display name rejects URL and legacy display names before falling back", () => {
  assert.equal(
    formatConnectorNameForDisplay({
      connectorId: "gmail",
      displayName: "https://registry.pdpp.org/connectors/gmail",
      name: "legacy_default",
    }),
    "gmail"
  );
});

test("source display labels sanitize connector source ids", () => {
  assert.equal(
    formatSourceForDisplay({
      kind: "connector",
      id: "https://registry.pdpp.org/connectors/amazon",
    }),
    "connector:amazon"
  );
});
