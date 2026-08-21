// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the two connection-scoped static-secret resolvers to one contract.
 *
 * There are two structurally identical implementations of the same resolver:
 *
 *   - `server/connection-scoped-run-env.ts` — the leaf module, used by
 *     `scheduler-manager-factory.ts` and the reference test suite.
 *   - `server/index.ts`'s `buildControllerStaticSecretRunEnvResolver` — the
 *     one the LIVE server installs for BOTH the controller path (manual runs,
 *     `/_ref/run-now`) and the scheduler path (automatic runs).
 *
 * They drifted. The leaf module forwarded `isStaticSecretCaptureOptional` to
 * `resolveStaticSecretRunEnv`; the `index.ts` copy did not. Because only the
 * `index.ts` copy runs in production, the drift was invisible to every existing
 * test — `static-secret-run-credentials.test.ts` proves the SEAM honors the
 * argument, but nothing proved the live caller passes it.
 *
 * Consequence of the omission: `resolveStaticSecretRunEnv` treats a missing
 * credential as a soft `null` (proceed without an env fragment, let the
 * connector fall back to manual sign-in) under EITHER of two conditions —
 * a browser-session `sourceBinding.kind`, or the connector's manifest
 * declaring `credential_capture.required: false`. With the second condition
 * unreachable on the live path, a `captureRequired: false` connector (venmo)
 * bound as anything other than `browser_collector` /
 * `browser_enrollment_shell` — for instance a `historical_archive` binding —
 * hit the store's throw and had its run REFUSED, instead of starting and
 * offering the owner the manual sign-in the manifest explicitly promises.
 *
 * This test asserts the argument set itself rather than an end-to-end run, so
 * it stays a fast unit test with no DB or spawn, and it fails loudly the
 * moment either implementation stops forwarding a resolver argument the other
 * one forwards.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INDEX_PATH = fileURLToPath(new URL("../server/index.ts", import.meta.url));
const LEAF_PATH = fileURLToPath(new URL("../server/connection-scoped-run-env.ts", import.meta.url));
/** A bare JS identifier — hoisted so the matcher is compiled once, not per key. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

/**
 * Extract the object-literal argument names passed to the single
 * `resolveStaticSecretRunEnv({ ... })` call in `source`.
 *
 * Deliberately a source-level read rather than a behavioral probe: the point
 * is to compare the two CALL SITES, and one of them (`index.ts`) cannot be
 * imported in isolation under bare `node --test` without booting the whole
 * server. Parsing the call is the cheapest honest way to compare them.
 */
function resolverArgumentNames(source: string, label: string): string[] {
  const callIndex = source.indexOf("resolveStaticSecretRunEnv as (args:");
  const searchFrom = callIndex === -1 ? source.indexOf("await resolveStaticSecretRunEnv({") : callIndex;
  assert.notEqual(searchFrom, -1, `${label}: could not locate the resolveStaticSecretRunEnv call`);
  const open = source.indexOf("({", searchFrom);
  assert.notEqual(open, -1, `${label}: could not locate the call's argument object`);

  // Walk braces so a nested object/arrow inside an argument cannot end the
  // scan early (the leaf passes an arrow function for
  // buildConnectionScopedSecretEnv).
  let depth = 0;
  let end = -1;
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.notEqual(end, -1, `${label}: unbalanced braces in the resolveStaticSecretRunEnv call`);

  const body = source.slice(open + 2, end);
  const names = new Set<string>();
  // Top-level keys only: skip anything nested inside a deeper brace/paren.
  let nesting = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") {
      nesting += 1;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      nesting -= 1;
    }
    if (nesting === 0 && ch === ",") {
      recordName(current, names);
      current = "";
      continue;
    }
    current += ch;
  }
  recordName(current, names);
  return [...names].sort();
}

function recordName(chunk: string, into: Set<string>): void {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) {
    return;
  }
  // `key: value` and shorthand `key` both yield `key`.
  const name = (trimmed.split(":")[0] ?? "").trim();
  if (IDENTIFIER_PATTERN.test(name)) {
    into.add(name);
  }
}

test("both connection-scoped static-secret resolvers pass the same arguments", async () => {
  const [indexSource, leafSource] = await Promise.all([readFile(INDEX_PATH, "utf8"), readFile(LEAF_PATH, "utf8")]);
  const indexArgs = resolverArgumentNames(indexSource, "server/index.ts");
  const leafArgs = resolverArgumentNames(leafSource, "server/connection-scoped-run-env.ts");
  assert.deepEqual(
    indexArgs,
    leafArgs,
    "server/index.ts and server/connection-scoped-run-env.ts must pass resolveStaticSecretRunEnv the same arguments; " +
      "a difference means the live path and the tested path disagree about credential resolution"
  );
});

test("the live resolver forwards isStaticSecretCaptureOptional", async () => {
  const indexSource = await readFile(INDEX_PATH, "utf8");
  const indexArgs = resolverArgumentNames(indexSource, "server/index.ts");
  assert.ok(
    indexArgs.includes("isStaticSecretCaptureOptional"),
    "server/index.ts installs the resolver the live server uses; without isStaticSecretCaptureOptional a " +
      "credential_capture.required:false connector has its run refused instead of falling back to manual sign-in"
  );
});
