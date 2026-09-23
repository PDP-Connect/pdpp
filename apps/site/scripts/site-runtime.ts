// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface SiteRuntimeEnvironment {
  NODE_ENV?: string;
  PDPP_SITE_NEXT_DIST_DIR?: string;
  PDPP_SITE_SOURCE_DIR?: string;
  PDPP_SITE_TSCONFIG?: string;
  PDPP_WEB_BUILD_WORKERS?: string;
}

function parseBuildWorkers(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function resolveSiteRuntime(environment: SiteRuntimeEnvironment = process.env) {
  const isProduction = environment.NODE_ENV === "production";
  let buildWorkers: number | undefined;
  if (environment.PDPP_WEB_BUILD_WORKERS) {
    buildWorkers = parseBuildWorkers(environment.PDPP_WEB_BUILD_WORKERS);
  } else if (isProduction) {
    buildWorkers = 1;
  }

  return {
    buildWorkers,
    distDir: environment.PDPP_SITE_NEXT_DIST_DIR ?? ".next",
    isProduction,
    sourceDir: environment.PDPP_SITE_SOURCE_DIR ?? ".source",
    // Same PDPP_SITE_TSCONFIG that package.json's "types:check" script
    // passes to `tsc -p`, so `next build`'s own internal type-check pass
    // (which reads tsconfig.json directly, not through the webpack/
    // turbopack "@generated-docs" aliases) resolves against the same
    // directory as the rest of the current run. See next.config.mjs.
    tsconfigPath: environment.PDPP_SITE_TSCONFIG ?? "tsconfig.json",
  };
}
