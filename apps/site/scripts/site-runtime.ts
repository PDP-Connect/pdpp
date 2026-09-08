// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface SiteRuntimeEnvironment {
  NODE_ENV?: string;
  PDPP_SITE_NEXT_DIST_DIR?: string;
  PDPP_SITE_SOURCE_DIR?: string;
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
  };
}
