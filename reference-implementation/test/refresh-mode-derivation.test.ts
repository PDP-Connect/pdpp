// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Oracle for the RI-owned refresh-mode derivation and the build-time
 * consistency gate that keeps `capabilities.refresh_policy` from drifting
 * back into self-contradiction.
 *
 * The corpus test at the bottom is the load-bearing one: it asserts the
 * derivation against every SHIPPED manifest, so a hand-edited
 * `recommended_mode` that disagrees with the connector's declared
 * interaction posture fails the build rather than silently changing which
 * connectors get auto-scheduled.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deriveRecommendedMode } from "../runtime/refresh-mode-derivation.ts";
import { refreshPolicyContradictions } from "../server/refresh-policy-consistency.ts";

const MANIFEST_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "polyfill-connectors",
  "manifests"
);

test("derivation: postures with no per-run gesture derive automatic", () => {
  assert.equal(deriveRecommendedMode({ interaction_posture: "none" }), "automatic");
  assert.equal(deriveRecommendedMode({ interaction_posture: "credentials" }), "automatic");
});

test("derivation: a background-unsafe declaration cannot force a gesture-free posture to manual", () => {
  // This is the Notion/Oura/Strava defect in miniature: a token connector
  // with nothing to interact with declared background_safe:false to mean
  // "unproven". Maturity is the tier gate's job, not the mode's.
  assert.equal(deriveRecommendedMode({ background_safe: false, interaction_posture: "none" }), "automatic");
  assert.equal(deriveRecommendedMode({ background_safe: false, interaction_posture: "credentials" }), "automatic");
});

test("derivation: per-run gesture postures derive manual unless session persistence is declared", () => {
  assert.equal(deriveRecommendedMode({ interaction_posture: "otp_likely" }), "manual");
  assert.equal(deriveRecommendedMode({ background_safe: false, interaction_posture: "otp_likely" }), "manual");
  assert.equal(deriveRecommendedMode({ background_safe: true, interaction_posture: "otp_likely" }), "automatic");

  assert.equal(deriveRecommendedMode({ interaction_posture: "manual_action_likely" }), "manual");
  assert.equal(
    deriveRecommendedMode({ background_safe: true, interaction_posture: "manual_action_likely" }),
    "automatic"
  );
});

test("derivation: default is automatic when posture is absent or unrecognized", () => {
  assert.equal(deriveRecommendedMode(undefined), "automatic");
  assert.equal(deriveRecommendedMode(null), "automatic");
  assert.equal(deriveRecommendedMode({}), "automatic");
  assert.equal(deriveRecommendedMode({ interaction_posture: "not_a_real_posture" }), "automatic");
});

test("derivation: assisted_after_owner_auth is not an input to mode", () => {
  // run-automation-policy.ts owns this flag; it decides whether a RUNNING
  // job may ask for help, not whether the job may start.
  const withAssist = { assisted_after_owner_auth: true, background_safe: true, interaction_posture: "otp_likely" };
  assert.equal(deriveRecommendedMode(withAssist), "automatic");
});

test("consistency gate: background_safe:true with a hand-written manual mode is rejected", () => {
  const found = refreshPolicyContradictions({
    background_safe: true,
    interaction_posture: "otp_likely",
    recommended_mode: "manual",
  });
  assert.ok(
    found.some((c) => c.includes("recommended_mode")),
    `expected a recommended_mode contradiction, got ${JSON.stringify(found)}`
  );
});

test("consistency gate: background_safe:false with assisted_after_owner_auth:true is rejected", () => {
  const found = refreshPolicyContradictions({
    assisted_after_owner_auth: true,
    background_safe: false,
    interaction_posture: "otp_likely",
    recommended_mode: "manual",
  });
  assert.ok(
    found.some((c) => c.includes("assisted_after_owner_auth")),
    `expected an assisted_after_owner_auth contradiction, got ${JSON.stringify(found)}`
  );
});

test("consistency gate: a gesture-free posture declaring background_safe:false is rejected", () => {
  // The Notion/Oura/Strava defect. Asserted on the SPECIFIC message rather
  // than "some contradiction", because the mode-vs-derived check also fires
  // on this input and would otherwise mask the loss of this rule entirely.
  for (const posture of ["none", "credentials"]) {
    const found = refreshPolicyContradictions({
      background_safe: false,
      interaction_posture: posture,
      // Declare the mode the facts derive, so the mode check stays silent
      // and only the background_safe rule can produce a message here.
      recommended_mode: "automatic",
    });
    assert.deepEqual(
      found.filter((c) => c.includes("background_safe:false contradicts interaction_posture")).length,
      1,
      `expected exactly one gesture-free background_safe contradiction for posture=${posture}, got ${JSON.stringify(found)}`
    );
  }
});

test("consistency gate: a minimal policy with no declared posture is accepted", () => {
  // The validator has a documented minimal-manifest contract: mode +
  // rationale alone is valid. With no posture declared there is no fact to
  // contradict, so the gate must not reject it. The corpus test below is
  // what holds SHIPPED manifests to declaring a posture.
  assert.deepEqual(refreshPolicyContradictions({ recommended_mode: "manual" }), []);
  assert.deepEqual(refreshPolicyContradictions({ recommended_mode: "automatic" }), []);
});

test("every shipped manifest declares an interaction_posture", async () => {
  // Without this, a shipped manifest could dodge the mode-consistency check
  // simply by omitting the posture.
  const policies = await readShippedPolicies();
  const missing = policies
    .filter(({ policy }) => typeof policy.interaction_posture !== "string")
    .map(({ file }) => file);
  assert.deepEqual(missing, [], `manifests missing interaction_posture:\n${missing.join("\n")}`);
});

test("consistency gate: a coherent policy yields no contradictions", () => {
  assert.deepEqual(
    refreshPolicyContradictions({
      background_safe: true,
      interaction_posture: "none",
      recommended_mode: "automatic",
    }),
    []
  );
  assert.deepEqual(
    refreshPolicyContradictions({
      background_safe: false,
      interaction_posture: "otp_likely",
      recommended_mode: "manual",
    }),
    []
  );
});

test("consistency gate: paused is an operator intent the gate does not second-guess", () => {
  assert.deepEqual(
    refreshPolicyContradictions({
      background_safe: false,
      interaction_posture: "otp_likely",
      recommended_mode: "paused",
    }),
    []
  );
});

interface ShippedManifest {
  readonly capabilities?: {
    readonly refresh_policy?: Record<string, unknown>;
  };
  readonly connector_id?: unknown;
}

async function readShippedPolicies(): Promise<ReadonlyArray<{ file: string; policy: Record<string, unknown> }>> {
  const entries = await readdir(MANIFEST_DIR);
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const parsed = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(join(MANIFEST_DIR, file), "utf8");
      return { file, manifest: JSON.parse(raw) as ShippedManifest };
    })
  );
  const out: Array<{ file: string; policy: Record<string, unknown> }> = [];
  for (const { file, manifest } of parsed) {
    const policy = manifest.capabilities?.refresh_policy;
    if (policy && typeof policy === "object") {
      out.push({ file, policy });
    }
  }
  return out;
}

test("every shipped manifest declares a recommended_mode its own facts derive", async () => {
  const policies = await readShippedPolicies();
  assert.ok(policies.length > 0, "expected to read shipped manifests");
  const mismatched: string[] = [];
  for (const { file, policy } of policies) {
    if (policy.recommended_mode === "paused") {
      continue;
    }
    const derived = deriveRecommendedMode({
      background_safe: typeof policy.background_safe === "boolean" ? policy.background_safe : undefined,
      interaction_posture: typeof policy.interaction_posture === "string" ? policy.interaction_posture : undefined,
    });
    if (policy.recommended_mode !== derived) {
      mismatched.push(`${file}: declared=${String(policy.recommended_mode)} derived=${derived}`);
    }
  }
  assert.deepEqual(mismatched, [], `manifests contradict their own derivation:\n${mismatched.join("\n")}`);
});

test("no shipped manifest carries a contradictory refresh_policy", async () => {
  const policies = await readShippedPolicies();
  const offenders: string[] = [];
  for (const { file, policy } of policies) {
    const found = refreshPolicyContradictions(policy);
    if (found.length > 0) {
      offenders.push(`${file}: ${found.join("; ")}`);
    }
  }
  assert.deepEqual(offenders, [], `contradictory refresh_policy declarations:\n${offenders.join("\n")}`);
});
