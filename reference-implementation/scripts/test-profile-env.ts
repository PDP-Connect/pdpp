// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ProcessEnvLike } from "./test-env.ts";

export function storageProfileEnvironment(profile: string, source: ProcessEnvLike): ProcessEnvLike {
  const environment: ProcessEnvLike = { ...source };
  if (profile === "memory-default") {
    // biome-ignore lint/performance/noDelete: preserves the original "key genuinely absent" semantics (not just undefined-valued) for callers that do `key in environment` / Object.keys(); called once per test-file spawn, not a hot path.
    delete environment.PDPP_TEST_POSTGRES_URL;
  }
  return environment;
}

/**
 * Require an explicit, valid PDPP_TEST_PROFILE for an ungated run-tests.ts
 * invocation (no --accounting-authority bound). Twice (the 2026-08-30 #238
 * gate and the prior day's #242 verification) an absent PDPP_TEST_PROFILE
 * silently fell through to a memory-default fallback, deleting
 * PDPP_TEST_POSTGRES_URL out from under an operator who believed they were
 * running the postgres profile and skipping every PostgreSQL-only path with
 * no error. Fail closed instead: an ungated run must name a real profile
 * explicitly, and postgres must carry its URL.
 *
 * A bound accounting authority is exempt: `run-tests.ts` already requires
 * `accountingAuthority.profile === process.env.PDPP_TEST_PROFILE` before
 * this seam runs, so an authority-driven run has already proven the profile
 * explicit and matching.
 */
export function assertUngatedProfileIsExplicit(source: ProcessEnvLike): void {
  const requestedProfile = source.PDPP_TEST_PROFILE;
  if (requestedProfile !== "memory-default" && requestedProfile !== "postgres") {
    throw new Error(
      `PDPP_TEST_PROFILE must be set to "memory-default" or "postgres" (got ${JSON.stringify(requestedProfile)})`
    );
  }
  if (requestedProfile === "postgres" && !source.PDPP_TEST_POSTGRES_URL) {
    throw new Error("postgres profile requires PDPP_TEST_POSTGRES_URL");
  }
}
