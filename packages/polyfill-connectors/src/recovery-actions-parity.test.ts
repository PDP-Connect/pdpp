// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { RECOVERY_ACTIONS as CANONICAL_RECOVERY_ACTIONS } from "@pdpp/reference-contract/common";
import { RECOVERY_ACTIONS as BUNDLED_RECOVERY_ACTIONS } from "./recovery-actions.ts";

// This package's safe-diagnostics.ts cannot import @pdpp/reference-contract
// directly (it compiles into @pdpp/local-collector's publishable dist, which
// does not declare that private, unpublished package as a dependency — see
// local-collector/scripts/validate-package.ts). recovery-actions.ts is a
// hand-mirrored copy for that boundary. This test is what makes the mirror
// safe: if the canonical vocabulary in reference-contract grows or changes
// without this file being updated to match, the test fails loudly instead of
// the bundled copy silently drifting out of sync.
test("bundled RECOVERY_ACTIONS mirror matches the canonical @pdpp/reference-contract vocabulary", () => {
  assert.deepEqual(
    [...BUNDLED_RECOVERY_ACTIONS].sort(),
    [...CANONICAL_RECOVERY_ACTIONS].sort(),
    "packages/polyfill-connectors/src/recovery-actions.ts has drifted from packages/reference-contract/src/common/recovery-actions.ts — update the mirror to match"
  );
});
