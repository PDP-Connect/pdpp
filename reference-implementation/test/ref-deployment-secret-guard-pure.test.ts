// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the deployment-report secret-leak guard in
// operations/ref-deployment/index.ts. No test imports it by name. This operation
// re-asserts, at the public-surface boundary, that a regressed dependency cannot
// leak an unredacted secret env value or emit an invalid provenance marker — a
// defense-in-depth guard on the deployment diagnostics endpoint.
//
// The report collector is stubbed so we exercise the guard directly.
//
// Mutation surface:
//   - an environment entry with a provenance other than present/absent/redacted throws.
//   - a `secret` entry with provenance='present' AND a non-null value throws
//     (secrets MUST be redacted); a null-valued present secret is allowed.
//   - a valid report passes through unchanged.

import assert from "node:assert/strict";
import test from "node:test";

import {
  executeRefDeployment,
  type RefDeploymentDependencies,
  type RefDeploymentEnvEntry,
  type RefDeploymentReport,
} from "../operations/ref-deployment/index.ts";

const REGEXP_1 = /leaked a secret env value for LEAK/;
const REGEXP_2 = /invalid provenance/;
const REGEXP_3 = /leaked a secret env value/;

// The test only exercises the secret-leak guard, which reads `environment`
// and returns the report unchanged. The other required `RefDeploymentReport`
// fields are irrelevant to the guard, so the fixture fills them with
// minimal-but-honest placeholder values; `service`/`version` are extra
// fixture-only fields (not part of the real report shape) carried through
// by the pass-through behavior and asserted on below.
type FixtureReport = RefDeploymentReport & { readonly service: string; readonly version: string };

function report(environment: readonly RefDeploymentEnvEntry[]): FixtureReport {
  return {
    database: { path: ":memory:" },
    environment,
    lexical: {},
    manifests: [],
    runtime_capabilities: {},
    semantic: {},
    service: "pdpp-reference",
    version: "0.1.0",
    warnings: [],
  };
}

function deps(environment: readonly RefDeploymentEnvEntry[]): RefDeploymentDependencies {
  return { collectDeploymentReport: async () => report(environment) };
}

// `executeRefDeployment`'s declared return type is the real
// `RefDeploymentReport` shape, which has no `version` field — even though
// the operation passes the fixture's extra `service`/`version` fields
// through unchanged at runtime (see `report`/`deps` above). This guard
// narrows the envelope back to `FixtureReport` for the one assertion that
// reads `.version`, without an `any`/`as unknown as` cast.
function isFixtureReport(value: RefDeploymentReport): value is FixtureReport {
  return "version" in value && typeof value.version === "string";
}

test("executeRefDeployment: a valid report (present non-secret, redacted secret, absent) passes through", async () => {
  const env: RefDeploymentEnvEntry[] = [
    { name: "PORT", provenance: "present", secret: false, value: "3000" },
    { name: "DB_PASSWORD", provenance: "redacted", secret: true, value: null },
    { name: "OPTIONAL_FLAG", provenance: "absent", secret: false, value: null },
  ];
  const out = await executeRefDeployment(deps(env));
  assert.deepEqual(out.environment, env, "the report is returned unchanged");
  assert.ok(isFixtureReport(out), "the fixture report carries its version field through unchanged");
  assert.equal(out.version, "0.1.0");
});

// A dependency env entry shaped like `RefDeploymentEnvEntry` but with
// `provenance` widened to plain `string`, for constructing fixtures that
// deliberately regress past the type system — the guard re-validates
// `provenance` at runtime precisely because a dependency could do this.
interface RegressedEnvEntry {
  readonly name: string;
  readonly provenance: string;
  readonly secret: boolean;
  readonly value: string | null;
}

// A regressed report shape: same fields as `RefDeploymentReport`, but with
// `environment` widened to allow a `provenance` value outside the real
// union. `executeRefDeployment` only requires its dependency's
// `collectDeploymentReport` to be call-compatible (return something with
// an `environment` array of entries with `name`/`provenance`/`secret`/
// `value`), so a dependency built against this wider shape is exactly the
// "regressed dependency" the operation's guard defends against.
interface RegressedDeploymentDependencies {
  collectDeploymentReport: () => Promise<{
    readonly database: { readonly path: string };
    readonly environment: readonly RegressedEnvEntry[];
    readonly runtime_capabilities: Readonly<Record<string, unknown>>;
    readonly lexical: Readonly<Record<string, unknown>>;
    readonly manifests: readonly Readonly<Record<string, unknown>>[];
    readonly semantic: Readonly<Record<string, unknown>>;
    readonly warnings: readonly Readonly<Record<string, unknown>>[];
  }>;
}

function regressedDeps(environment: readonly RegressedEnvEntry[]): RegressedDeploymentDependencies {
  return {
    collectDeploymentReport: async () => ({
      database: { path: ":memory:" },
      environment,
      lexical: {},
      manifests: [],
      runtime_capabilities: {},
      semantic: {},
      warnings: [],
    }),
  };
}

// `executeRefDeployment` only calls `collectDeploymentReport()` and reads
// the result's `environment` entries by field, so a
// `RegressedDeploymentDependencies` value is call-compatible at runtime.
// The declared `RefDeploymentDependencies` parameter type is narrower
// (`provenance` restricted to the known-good union) than what a truly
// regressed dependency could return, which is exactly the scenario this
// test constructs; a structural cast at the call boundary is the only way
// to express "dependency returns a shape the operation's own type doesn't
// allow" without `as any`/`as unknown as`.
function asDependencies(regressed: RegressedDeploymentDependencies): RefDeploymentDependencies {
  return regressed as RefDeploymentDependencies;
}

test("executeRefDeployment: an invalid provenance marker throws", async () => {
  await assert.rejects(
    executeRefDeployment(
      asDependencies(regressedDeps([{ name: "X", provenance: "maybe", secret: false, value: "v" }]))
    ),
    REGEXP_2
  );
});

test("executeRefDeployment: SECRET LEAK — a present secret with a non-null value throws", async () => {
  await assert.rejects(
    executeRefDeployment(deps([{ name: "API_KEY", provenance: "present", secret: true, value: "sk-live-123" }])),
    REGEXP_3,
    "an unredacted secret value must be rejected at the boundary"
  );
});

test("executeRefDeployment: a present secret with a NULL value is allowed (properly redacted)", async () => {
  const env: RefDeploymentEnvEntry[] = [{ name: "API_KEY", provenance: "present", secret: true, value: null }];
  const out = await executeRefDeployment(deps(env));
  assert.deepEqual(out.environment, env);
});

test("executeRefDeployment: a present NON-secret with a value is fine (only secrets are guarded)", async () => {
  const env: RefDeploymentEnvEntry[] = [{ name: "LOG_LEVEL", provenance: "present", secret: false, value: "info" }];
  const out = await executeRefDeployment(deps(env));
  assert.deepEqual(out.environment, env);
});

test("executeRefDeployment: the guard scans every entry (a leak anywhere in the list is caught)", async () => {
  await assert.rejects(
    executeRefDeployment(
      deps([
        { name: "OK", provenance: "present", secret: false, value: "v" },
        { name: "OK2", provenance: "redacted", secret: true, value: null },
        { name: "LEAK", provenance: "present", secret: true, value: "oops" }, // last entry leaks
      ])
    ),
    REGEXP_1
  );
});
