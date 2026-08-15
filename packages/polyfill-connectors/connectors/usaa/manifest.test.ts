// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MANIFEST_PATH = new URL("../../manifests/usaa.json", import.meta.url);

interface UsaaManifest {
  capabilities?: {
    human_interaction?: unknown;
    refresh_policy?: {
      interaction_posture?: unknown;
      rationale?: unknown;
    };
  };
}

test("usaa manifest declares OTP alongside manual_action and keeps the posture honest", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as UsaaManifest;
  const interactions = Array.isArray(manifest.capabilities?.human_interaction)
    ? [...manifest.capabilities.human_interaction].filter((value): value is string => typeof value === "string")
    : [];

  assert.deepEqual(interactions.sort(), ["manual_action", "otp"]);
  assert.equal(manifest.capabilities?.refresh_policy?.interaction_posture, "otp_likely");

  const rationale = String(manifest.capabilities?.refresh_policy?.rationale ?? "");
  assert.match(rationale, /OTP|one-time|verification code/i);
});
