// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The specification's own front matter — VERSION / STATUS / DATE / EDITORS —
// taken from the artifacts that already declare them, never hand-typed here.
//
//   version, status, date  <- the repo-root spec-core.md header
//   editors                <- MAINTAINERS.md
//
// Those files are read ONCE, by scripts/sync-spec-docs.mjs at prebuild, which
// writes src/generated/spec-front-matter.ts. Nothing here touches the file
// system.
//
// That indirection is load-bearing rather than ceremony. Vercel's project root
// is apps/site, so the repo root exists while the build script runs and is
// absent from the serverless bundle that serves a request; a path above the
// project root is also dropped from outputFileTracingIncludes. Reading these
// files when a page rendered returned 500 in production for the front door,
// Participate and every specification page while passing every local check,
// because the server that serves the site locally is the repo itself. The
// spec bodies are single-sourced through the same prebuild step.
//
// A malformed header still breaks the build loudly: the parsers and their
// refusal to guess now live in that script.

import { SPEC_FRONT_MATTER } from "@/generated/spec-front-matter.ts";

export interface SpecFrontMatter {
  date: string;
  editors: string[];
  status: string;
  version: string;
}

export function getSpecFrontMatter(): SpecFrontMatter {
  return {
    date: SPEC_FRONT_MATTER.date,
    editors: [...SPEC_FRONT_MATTER.editors],
    status: SPEC_FRONT_MATTER.status,
    version: SPEC_FRONT_MATTER.version,
  };
}
