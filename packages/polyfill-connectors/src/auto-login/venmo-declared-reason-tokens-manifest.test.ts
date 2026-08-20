// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard: `venmo.json`'s `capabilities.declared_reason_tokens` must equal
 * `VENMO_DECLARED_REASON_TOKENS`, the constant Venmo's own throw sites are
 * built from.
 *
 * WHY THIS TEST LIVES HERE AND NOT IN THE RI
 * ------------------------------------------
 * These two lists are the same fact written twice: the manifest is what the
 * RI reads at run time (`runtime/declared-reason-tokens.ts`), and the
 * constant is what the connector actually throws. If they drift, the symptom
 * is silent — the RI keeps redacting a real fault-class name and the owner
 * sees `[REDACTED]` again, which is exactly production `run_1787101857760`.
 *
 * Drift detection belongs next to the source of truth. The RI cannot own this
 * check: doing so would mean RI production or test code importing
 * `src/auto-login/venmo.ts` and naming a connector, the precise
 * zero-connector-knowledge violation that moving these tokens into the
 * manifest removed. Here, both sides are in-package and importing the real
 * constant is free.
 *
 * The RI's half of the contract — that a declared token survives redaction
 * and an undeclared connector is byte-identical to prior behavior — is tested
 * against synthetic manifests in
 * `reference-implementation/test/venmo-declared-reason-tokens-survive-redaction.test.ts`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VENMO_DECLARED_REASON_TOKENS } from "./venmo.ts";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VENMO_MANIFEST_PATH = join(PACKAGE_ROOT, "manifests", "venmo.json");

interface VenmoManifest {
  capabilities?: { declared_reason_tokens?: unknown };
}

function readDeclaredTokens(): unknown {
  const manifest = JSON.parse(readFileSync(VENMO_MANIFEST_PATH, "utf8")) as VenmoManifest;
  return manifest.capabilities?.declared_reason_tokens;
}

test("venmo.json declares exactly the tokens VENMO_DECLARED_REASON_TOKENS names", () => {
  const declared = readDeclaredTokens();
  assert.ok(Array.isArray(declared), "venmo.json must declare capabilities.declared_reason_tokens as an array");
  assert.deepEqual(
    new Set(declared),
    new Set(VENMO_DECLARED_REASON_TOKENS),
    "manifest tokens drifted from the connector's own thrown vocabulary — the RI reads the MANIFEST, so a token " +
      "missing here is redacted to [REDACTED] in the owner's UI even though the throw site still emits it"
  );
});

test("venmo.json declares no duplicate reason tokens", () => {
  const declared = readDeclaredTokens() as string[];
  assert.equal(new Set(declared).size, declared.length, "duplicate entries in capabilities.declared_reason_tokens");
});

test("every declared venmo reason token satisfies the RI's registration gate (>=24 chars, snake_case)", () => {
  // Mirrors `validateDeclaredReasonTokensCapability` in
  // reference-implementation/server/connector-manifest-validation.ts. A token
  // failing this is rejected at manifest registration, so catching it here
  // turns a deploy-time rejection into a build-time one.
  const snakeCase = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
  for (const token of readDeclaredTokens() as string[]) {
    assert.ok(token.length >= 24, `expected ${token} to be >=24 chars (got ${token.length})`);
    assert.match(token, snakeCase, `expected ${token} to be snake_case`);
  }
});
