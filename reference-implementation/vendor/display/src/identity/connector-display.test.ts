// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { deriveSourceDisplayNameFallback, isFallbackConnectionLabel } from "./connector-display.ts";

test("absent display name is a fallback", () => {
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: null }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "   " }), true);
});

test("a registry URL display name is a fallback", () => {
  assert.equal(
    isFallbackConnectionLabel({
      connectorId: "gmail",
      displayName: "https://registry.pdpp.dev/connectors/gmail",
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
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "gmail" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "Gmail" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "amazon", displayName: "Amazon", name: "Amazon" }), true);
  assert.equal(isFallbackConnectionLabel({ connectorId: "claude_code", displayName: "Claude Code" }), true);
});

test("an owner-meaningful label is not a fallback", () => {
  assert.equal(isFallbackConnectionLabel({ connectorId: "gmail", displayName: "Personal Gmail" }), false);
  assert.equal(isFallbackConnectionLabel({ connectorId: "amazon", displayName: "Shared Amazon" }), false);
});

test("deriveSourceDisplayNameFallback uses manifest name when available", () => {
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "gmail",
      name: "Gmail",
    }),
    "Gmail source"
  );
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "amazon",
      name: "Amazon",
    }),
    "Amazon source"
  );
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "google-maps",
      name: "Google Maps",
    }),
    "Google Maps source"
  );
});

test("deriveSourceDisplayNameFallback falls back to formatted connectorId when no manifest name", () => {
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "gmail",
    }),
    "Gmail source"
  );
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "unknown_connector",
    }),
    "unknown connector source"
  );
});

test("deriveSourceDisplayNameFallback prioritizes manifest name over connectorId formatting", () => {
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "google_maps",
      name: "Google Maps",
    }),
    "Google Maps source"
  );
});

test("deriveSourceDisplayNameFallback ignores displayName (already filtered by isFallbackConnectionLabel)", () => {
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "gmail",
      displayName: "My Gmail",
      name: "Gmail",
    }),
    "Gmail source"
  );
});

test("deriveSourceDisplayNameFallback converts underscores/hyphens to spaces for unknown IDs", () => {
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "custom_provider",
    }),
    "custom provider source"
  );
  assert.equal(
    deriveSourceDisplayNameFallback({
      connectorId: "my-new-connector",
    }),
    "my new connector source"
  );
});
