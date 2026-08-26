// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * canary/otp-posture
 *
 * Decides which connectors the canary harness refuses to auto-trigger,
 * because triggering them texts a real one-time password to the owner's
 * phone. The answer is DERIVED from connector manifests, never hand-listed
 * here, and it is derived FAIL-CLOSED.
 *
 * Why derivation rather than a hardcoded list
 * -------------------------------------------
 * The list used to be six string literals in `manifest.ts`. That is
 * connector-specific executable knowledge inside RI production code, which
 * the zero-connector-knowledge contract exists to forbid — and the contract
 * is right, because a hand-maintained list drifts the moment a connector is
 * added. It had already drifted: `wholefoods` declares
 * `interaction_posture: "otp_likely"` and `human_interaction: ["otp"]` in its
 * own manifest, and was NOT in the hardcoded six. A denylist that misses one
 * connector is worse than no denylist, because it is false confidence with a
 * name attached.
 *
 * Why this is not "a denylist a manifest can disable at 2am"
 * ----------------------------------------------------------
 * That objection is the right instinct, and it is what D10 encodes:
 * qualification is proven, never self-declared. So the derivation is
 * deliberately asymmetric, and the asymmetry is the whole design:
 *
 *   - Declaring an OTP posture can only ADD a connector to the refusal set.
 *   - NOTHING a manifest declares can REMOVE a connector from it.
 *
 * A connector is allowed to be canary-triggered only when it positively
 * proves a non-interactive posture: its `interaction_posture` must be one of
 * a CLOSED, RI-OWNED set of values ({@link CANARY_TRIGGERABLE_POSTURES}) that
 * this file — not the manifest — decides are safe, AND it must not name `otp`
 * in `human_interaction`. Anything else is refused: an unknown posture, a
 * missing posture, a missing manifest, a malformed manifest, an unreadable
 * manifest directory. Silence is refusal, and so is novelty.
 *
 * That makes the 2am failure mode inert. An operator editing a manifest to
 * dodge the guard has to write a posture value this file already blesses; if
 * he invents one, or deletes the field, or deletes the file, the connector
 * becomes MORE refused, not less. The lie a manifest can tell only costs its
 * author a canary run it wanted.
 *
 * In the ruling's terms this is shape (b): the manifest SELECTS a closed
 * RI-owned variant. Omission yields a withheld verdict (refusal), never a
 * green one — which is exactly the condition under which shape (b) is sound.
 * Shape (a) would be wrong (the connector could opt itself IN to being
 * triggered) and shape (c) is what we are replacing, because an RI-owned
 * registry of connector names is the drift that produced the wholefoods gap.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo-relative location of the connector manifests. Resolved from this
 * module's own URL so the harness works regardless of the caller's cwd.
 */
const MANIFEST_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "polyfill-connectors",
  "manifests"
);

/**
 * The CLOSED, RI-OWNED set of interaction postures a canary may trigger.
 *
 * This is the "variant" half of shape (b): a manifest selects one of these,
 * it does not invent one. `otp_likely` is absent by construction, but so is
 * every value not written here — a new posture string added to the manifest
 * vocabulary tomorrow is refused until someone reviews it against this list.
 * That default is the safety property; do not turn this into a denylist of
 * unsafe postures, which would silently admit unknown ones.
 */
export const CANARY_TRIGGERABLE_POSTURES: ReadonlySet<string> = new Set([
  "none",
  "credentials",
  "manual_action_likely",
]);

/**
 * The `human_interaction` token meaning "this connector asks a human for a
 * one-time code". Checked independently of posture: two declarations must
 * BOTH be non-OTP for a connector to be triggerable, so a manifest that
 * scrubs one and forgets the other is still refused.
 */
const OTP_INTERACTION_TOKEN = "otp";

interface RefreshPolicyShape {
  readonly interaction_posture?: unknown;
}

interface CapabilitiesShape {
  readonly human_interaction?: unknown;
  readonly refresh_policy?: RefreshPolicyShape;
}

interface ManifestShape {
  readonly capabilities?: CapabilitiesShape;
}

/**
 * True when a manifest positively proves the connector never prompts the
 * owner for a one-time code. Every failure to prove that — unparseable
 * manifest, absent capabilities, unknown posture, an `otp` interaction token —
 * returns false, which denies.
 */
function provesNonOtpPosture(manifestJson: string): boolean {
  let parsed: ManifestShape;
  try {
    parsed = JSON.parse(manifestJson) as ManifestShape;
  } catch {
    // A manifest we cannot read is a manifest that has proven nothing.
    return false;
  }

  const capabilities = parsed?.capabilities;
  if (!capabilities || typeof capabilities !== "object") {
    return false;
  }

  const interactions = capabilities.human_interaction;
  if (Array.isArray(interactions) && interactions.includes(OTP_INTERACTION_TOKEN)) {
    return false;
  }

  const refreshPolicy = capabilities.refresh_policy;
  const posture = refreshPolicy ? refreshPolicy.interaction_posture : undefined;
  if (typeof posture !== "string") {
    return false;
  }

  return CANARY_TRIGGERABLE_POSTURES.has(posture);
}

/**
 * Derives the set of connector slugs the canary must refuse to trigger.
 *
 * Returns slugs in sorted order for stable assertions and stable error text.
 * Exported for tests, which drive it against a fixture directory; production
 * callers use {@link OTP_DENYLISTED_CONNECTORS}, computed once at load.
 */
export function deriveOtpDenylist(manifestDir: string = MANIFEST_DIR): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(manifestDir);
  } catch (error) {
    // The manifests are how this harness knows what is safe. If they cannot
    // be enumerated, no connector has proven anything, and the harness must
    // not fall back to an empty (permissive) denylist.
    throw new Error(
      `canary OTP guard: cannot read connector manifests at ${manifestDir}, so no connector can prove a non-OTP posture. Refusing to derive a permissive denylist.`,
      { cause: error }
    );
  }

  const denied: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const slug = entry.slice(0, -".json".length);
    let contents: string;
    try {
      contents = readFileSync(join(manifestDir, entry), "utf8");
    } catch {
      denied.push(slug);
      continue;
    }
    if (!provesNonOtpPosture(contents)) {
      denied.push(slug);
    }
  }
  return denied.sort((left, right) => left.localeCompare(right));
}
