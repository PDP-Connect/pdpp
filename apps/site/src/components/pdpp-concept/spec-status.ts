// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { SPEC_FRONT_MATTER } from "@/generated/spec-front-matter.ts";

// DERIVED, not hand-synced. Version, status, and date come from the repo-root
// spec-core.md header; editors from MAINTAINERS.md. This replaces three
// hand-typed constants: anything that can go stale but is tracked in the repo
// is wired so it cannot, and a comment saying "update this constant" is not a
// mechanism.
//
// Those two files are parsed ONCE, by scripts/sync-spec-docs.mjs at prebuild,
// which writes src/generated/spec-front-matter.ts. Nothing here touches the
// file system, and every parse failure still fails the build loudly rather
// than shipping last week's version.
//
// Reading them when a page rendered is what broke production: Vercel's project
// root is apps/site, so the repo root is present during the build and gone from
// the serverless bundle that serves a request. The front door, Participate and
// the specification pages all returned 500 while every local check passed,
// because the server that serves the site locally is the repo itself.
//
// NOTE ON THE DATE ITSELF: spec-core.md declares Date: 2026-04-06 while git
// says the file has been modified since. That is a defect in the SOURCE, not
// here, and it is deliberately not worked around — this module propagates
// whatever the spec header declares, so fixing the header fixes the site.

export const SPEC_STATUS = {
  date: SPEC_FRONT_MATTER.date,
  label: SPEC_FRONT_MATTER.status,
  version: SPEC_FRONT_MATTER.version,
} as const;

export const SPEC_STATUS_STAMP = `${SPEC_STATUS.label} · ${SPEC_STATUS.version} · ${SPEC_STATUS.date}`;

export const SPEC_EDITORS: readonly string[] = SPEC_FRONT_MATTER.editors;
