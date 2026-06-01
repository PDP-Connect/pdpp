import assert from "node:assert/strict";
import test from "node:test";
import { isFallbackConnectionLabel } from "./connector-display.ts";

// `isFallbackConnectionLabel` decides whether a connection still needs an
// owner-meaningful label. A label is a fallback when it degrades to the bare
// connector type, a registry URL, a `local-device:` binding, a `legacy`
// placeholder, or is absent. An owner-set label that says something specific
// is not a fallback.

test("absent display name is a fallback", () => {
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: null }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "   " }), true);
});

test("a registry URL display name is a fallback", () => {
  assert.equal(
    isFallbackConnectionLabel({
      connectorId: "gmail",
      displayName: "https://registry.pdpp.org/connectors/gmail",
    }),
    true
  );
});

test("a local-device binding display name is a fallback", () => {
  assert.equal(
    isFallbackConnectionLabel({
      connectorId: "claude_code",
      displayName: "local-device:laptop:claude_code",
    }),
    true
  );
});

test("a legacy placeholder display name is a fallback", () => {
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "legacy" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "legacy_default" }), true);
});

test("a label equal to the connector type name is a fallback", () => {
  // Labels identical to the type carry no per-connection meaning, regardless
  // of casing or display formatting, so they still need a real name.
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "gmail" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "Gmail" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "amazon", displayName: "Amazon", name: "Amazon" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "claude_code", displayName: "Claude Code" }), true);
});

test("an owner-meaningful label is not a fallback", () => {
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "Personal Gmail" }), false);
  assert.equal(isFallbackConnectionLabel({ connectorId: "amazon", displayName: "Shared Amazon" }), false);
});
