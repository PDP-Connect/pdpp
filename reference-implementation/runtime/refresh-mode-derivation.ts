// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Derives a connector's refresh mode from the facts that actually determine
 * it, instead of trusting a hand-written `recommended_mode` string.
 *
 * WHY THIS EXISTS
 *
 * `capabilities.refresh_policy` carried three independently hand-written
 * fields — `recommended_mode`, `background_safe`, `assisted_after_owner_auth`
 * — that were supposed to agree and did not. Measured across the shipped
 * manifests, `background_safe` had stopped discriminating anything: Notion (a
 * pure API-token connector with nothing to interact with) and Chase (an
 * interactive-OTP bank) both declared `background_safe: false`, for entirely
 * different reasons, neither of which was "unattended refresh is impossible".
 * The Notion/Oura/Strava/Steam/Jellyfin rationales say so outright — they read
 * "unproven pending credentialed live testing", which is a MATURITY statement
 * wearing a SAFETY flag's clothes.
 *
 * Those are two different facts and the manifests already declare both:
 *
 *   - CAPABILITY  — `refresh_policy.interaction_posture`: what human gesture,
 *     if any, each run needs. This field stayed honest because it is an
 *     enum with a validated domain rather than a free boolean.
 *   - MATURITY    — `public_listing.tier`: whether this connector has been
 *     proven on a real deployment yet.
 *
 * Mode is a function of CAPABILITY only. Maturity is enforced separately by
 * the `public_listing.tier` gate that auto-enrollment already applies, so an
 * unproven connector does not get auto-scheduled merely because it derives
 * as automatic. Keeping them apart is the whole point: previously a connector
 * could only express "not proven yet" by lying about what it is capable of,
 * and that lie then leaked into every consumer of `background_safe`.
 *
 * ARCHITECTURE PRECEDENT (load-bearing)
 *
 * This repo has a standing ruling that a derivation FORMULA must not live in
 * a manifest: a manifest may DECLARE a fact or SELECT a closed variant, but
 * the reference implementation owns formulas. So this module reads declared
 * inputs (`interaction_posture`, `background_safe`) and owns the rule. No
 * manifest gains a field describing HOW its mode is computed.
 *
 * THE RULE
 *
 * Default to automatic, and only step down to manual when a declared fact
 * says a human gesture is required per run:
 *
 *   manual_action_likely -> manual, UNLESS the connector declares
 *                           `background_safe: true`, which is how a browser
 *                           connector states that the owner's session
 *                           persists across runs after the first login
 *                           (ChatGPT, WHOOP, Google Calendar/Contacts).
 *   otp_likely           -> manual, UNLESS `background_safe: true` for the
 *                           same session-persistence reason (Amazon, Reddit,
 *                           H-E-B). Chase/USAA/Venmo/Whole Foods do not
 *                           declare it and stay manual.
 *   none | credentials   -> automatic. There is no per-run gesture to make.
 *   (undeclared posture) -> automatic, per the owner's explicit default:
 *                           prefer automatic until a connector proves it must
 *                           not be.
 *
 * `assisted_after_owner_auth` is deliberately NOT an input here. It answers a
 * different question — may a run that has already started ask the owner for
 * bounded help — and `runtime/run-automation-policy.ts` already consumes it
 * that way, mapping it to `automation_mode: "assisted"` while still allowing
 * the run to start. Treating it as a mode input is what made Amazon, Reddit
 * and H-E-B unschedulable despite declaring themselves background-safe.
 */

/**
 * The declared inputs this derivation reads. Nothing else is consulted.
 *
 * Both properties admit an explicit `undefined` (the repo builds with
 * `exactOptionalPropertyTypes`) because callers read them out of loosely
 * typed manifest JSON, where "absent" and "present but not a boolean/string"
 * collapse to the same thing.
 */
export interface RefreshModeInputs {
  readonly background_safe?: boolean | undefined;
  readonly interaction_posture?: string | undefined;
}

export type DerivedRefreshMode = "automatic" | "manual";

/**
 * Postures whose per-run human gesture can be waived by an explicit
 * `background_safe: true` session-persistence declaration.
 */
const SESSION_PERSISTENCE_WAIVABLE_POSTURES: ReadonlySet<string> = new Set(["manual_action_likely", "otp_likely"]);

/**
 * Derives the refresh mode from declared capability facts.
 *
 * Total over its input domain: an absent or unrecognized posture derives
 * automatic, matching the owner's stated default of erring toward automatic
 * schedules rather than silently withholding them.
 */
export function deriveRecommendedMode(inputs: RefreshModeInputs | null | undefined): DerivedRefreshMode {
  const posture = inputs?.interaction_posture;
  if (typeof posture !== "string" || !SESSION_PERSISTENCE_WAIVABLE_POSTURES.has(posture)) {
    return "automatic";
  }
  return inputs?.background_safe === true ? "automatic" : "manual";
}
