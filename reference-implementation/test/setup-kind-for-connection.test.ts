// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { setupKindForConnection } from "../server/routes/ref-static-secret-setup-status.ts";

// A manifest with no static-secret capture block means the legacy fallback
// (see setupKindForConnection) can never return "static_secret" on its own —
// isolates the binding-kind -> setup-kind map from that fallback.
const NO_CAPTURE_MANIFEST = { connector_id: "test_connector" };

test("a promoted static_secret binding classifies as static_secret via the map, not the manifest fallback", () => {
  const kind = setupKindForConnection({ kind: "static_secret", setup_fields: {} }, NO_CAPTURE_MANIFEST);
  assert.equal(kind, "static_secret");
});

test("a promoted manual_upload binding classifies as manual_upload", () => {
  const kind = setupKindForConnection(
    { import_dir: "/tmp/x", import_dir_env_var: "X", kind: "manual_upload" },
    NO_CAPTURE_MANIFEST
  );
  assert.equal(kind, "manual_upload");
});

test("a promoted browser_collector binding classifies as browser_session", () => {
  const kind = setupKindForConnection({ connector_id: "chatgpt", kind: "browser_collector" }, NO_CAPTURE_MANIFEST);
  assert.equal(kind, "browser_session");
});

test("an unrecognized binding kind with no manifest capture block falls through to unknown", () => {
  const kind = setupKindForConnection({ kind: "account" }, NO_CAPTURE_MANIFEST);
  assert.equal(kind, "unknown");
});
