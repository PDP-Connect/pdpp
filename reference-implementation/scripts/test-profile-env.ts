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
