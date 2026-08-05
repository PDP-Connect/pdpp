// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// DERIVED, not hand-synced. Version, status, and date are parsed out of the
// repo-root spec-core.md header; editors are parsed out of MAINTAINERS.md.
//
// This replaces three hand-typed constants. The owner's standing rule for this
// pass: anything that can go stale but is tracked in the repo must be wired so
// it cannot. Previously this file carried "update this one constant" in a
// comment, which is exactly the drift the rule bans — a comment is not a
// mechanism.
//
// Read at module scope, so it runs once per server process during SSR/SSG and
// never reaches the client bundle. Every parse failure throws rather than
// falling back to a stale literal: a build that cannot read the source of truth
// must fail loudly, not silently ship last week's version. That is the same
// fail-fast posture as scripts/sync-spec-docs.mts.
//
// NOTE ON THE DATE ITSELF: spec-core.md declares Date: 2026-04-06 while git
// says the file has been modified since. That is a defect in the SOURCE, not
// here, and it is deliberately not worked around — this module propagates
// whatever the spec header declares, so fixing the header fixes the site.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

// Hoisted: these run once at module load, and a regex literal inside a function
// is recompiled on every call.
const SPEC_VERSION_PATTERN = /\bv\d+\.\d+\.\d+\b/;
const SPEC_STATUS_PATTERN = /^Status:\s*(.+?)\s*$/;
const SPEC_DATE_PATTERN = /^Date:\s*(\d{4}-\d{2}-\d{2})\s*$/;
// The "Active maintainers" table row: | Name | `@handle` | Scope | Active | ... |
const ACTIVE_MAINTAINER_ROW = /^\|\s*([^|]+?)\s*\|\s*`@[^`]+`\s*\|[^|]*\|\s*Active\s*\|/;

function readRepoFile(relativePath: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relativePath), "utf8");
  } catch (cause) {
    throw new Error(`pdpp-concept: cannot read ${relativePath} (resolved from ${REPO_ROOT})`, { cause });
  }
}

function parseSpecHeader(): { date: string; label: string; version: string } {
  const source = readRepoFile("spec-core.md");
  const [titleLine = "", , statusLine = "", dateLine = ""] = source.split("\n");

  // "# Personal Data Portability Protocol (PDPP) v0.1.0"
  const version = titleLine.match(SPEC_VERSION_PATTERN)?.[0];
  const label = statusLine.match(SPEC_STATUS_PATTERN)?.[1];
  const date = dateLine.match(SPEC_DATE_PATTERN)?.[1];

  if (!(version && label && date)) {
    throw new Error(
      `pdpp-concept: spec-core.md header did not parse (version=${version}, status=${label}, date=${date}). ` +
        "Expected '# ... vX.Y.Z' on line 1, 'Status: ...' on line 3, 'Date: YYYY-MM-DD' on line 4."
    );
  }

  return { date, label, version };
}

function parseEditors(): readonly string[] {
  const source = readRepoFile("MAINTAINERS.md");

  // Take the name column of every row whose Status column reads Active, so a
  // maintainer going emeritus drops off the site without a site edit.
  const editors = source
    .split("\n")
    .map((line) => line.match(ACTIVE_MAINTAINER_ROW)?.[1])
    .filter((name): name is string => name !== undefined);

  if (editors.length === 0) {
    throw new Error("pdpp-concept: MAINTAINERS.md yielded no active maintainers; the table shape must have changed.");
  }

  return editors;
}

const header = parseSpecHeader();

export const SPEC_STATUS = {
  date: header.date,
  label: header.label,
  version: header.version,
} as const;

export const SPEC_STATUS_STAMP = `${SPEC_STATUS.label} · ${SPEC_STATUS.version} · ${SPEC_STATUS.date}`;

export const SPEC_EDITORS = parseEditors();
