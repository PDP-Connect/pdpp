// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build-time consistency gate for `capabilities.refresh_policy`.
 *
 * The three refresh-policy flags are hand-written per manifest and were
 * silently allowed to contradict each other, because validation only ever
 * checked each field's TYPE. That is how the shipped corpus ended up with
 * `background_safe: true` sitting next to `recommended_mode: "manual"` (the
 * connector says unattended refresh is safe, the mode says never do it), and
 * with `background_safe: false` next to `assisted_after_owner_auth: true`
 * (nothing may run in the background, and also the background run may ask
 * the owner for help).
 *
 * This gate rejects those combinations so the drift cannot recur silently.
 * It is intentionally a pure function over one policy object: the manifest
 * validator calls it per connector, and the test corpus calls it across
 * every shipped manifest.
 */

import { deriveRecommendedMode } from "../runtime/refresh-mode-derivation.ts";

/**
 * Postures that state no human gesture is required per run. A connector in
 * one of these postures has nothing to be unsafe about in the background,
 * so `background_safe: false` there is always a miscoded fact — historically
 * it meant "not proven yet", which `public_listing.tier` already expresses.
 */
const GESTURE_FREE_POSTURES: ReadonlySet<string> = new Set(["none", "credentials"]);

function readBoolean(policy: Record<string, unknown>, key: string): boolean | undefined {
  const value = policy[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Returns one human-readable message per contradiction found. An empty array
 * means the policy is internally coherent.
 *
 * `recommended_mode: "paused"` is skipped: pausing is a deliberate operator
 * intent ("this connector should not refresh at all right now"), not a claim
 * about capability, so it is not the gate's business to second-guess.
 */
export function refreshPolicyContradictions(policy: Record<string, unknown>): readonly string[] {
  const contradictions: string[] = [];
  const mode = policy.recommended_mode;
  if (mode === "paused") {
    return contradictions;
  }

  const backgroundSafe = readBoolean(policy, "background_safe");
  const assisted = readBoolean(policy, "assisted_after_owner_auth");
  const posture = typeof policy.interaction_posture === "string" ? policy.interaction_posture : undefined;

  if (backgroundSafe === false && assisted === true) {
    contradictions.push(
      "background_safe:false contradicts assisted_after_owner_auth:true — a connector that must never run in the " +
        "background cannot also ask for owner assistance during a background run"
    );
  }

  if (backgroundSafe === false && posture !== undefined && GESTURE_FREE_POSTURES.has(posture)) {
    contradictions.push(
      `background_safe:false contradicts interaction_posture:${posture} — a connector that needs no per-run human ` +
        "gesture has nothing that makes unattended refresh unsafe; declare maturity via public_listing.tier instead"
    );
  }

  // Only judge the declared mode against facts the connector actually
  // stated. A minimal policy that declares nothing but a mode and a
  // rationale has no fact to contradict, and rejecting it would break the
  // documented minimal-manifest contract. The gate exists to catch a mode
  // that DISAGREES with a stated posture, not to force every manifest to
  // declare a posture.
  if (typeof mode === "string" && posture !== undefined) {
    const derived = deriveRecommendedMode({ background_safe: backgroundSafe, interaction_posture: posture });
    if (mode !== derived) {
      contradictions.push(
        `recommended_mode:${mode} contradicts the connector's own declared facts ` +
          `(interaction_posture:${posture}, background_safe:${String(backgroundSafe)}), which derive ` +
          `recommended_mode:${derived}`
      );
    }
  }

  return contradictions;
}
