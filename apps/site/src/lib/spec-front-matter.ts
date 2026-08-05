// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The specification's own front matter — VERSION / STATUS / DATE / EDITORS —
// read from the artifacts that already declare them, never hand-typed here.
//
//   version, status, date  <- the repo-root spec-core.md header
//   editors                <- MAINTAINERS.md
//
// This runs at build time in a server component, so the values are baked into
// the rendered page; there is no client fetch and no runtime file access.
//
// The parsers below intentionally mirror the concept site's tools/sync-version.mjs:
// same anchored h1 shape, same "Status:"/"Date:" line prefixes, same refusal to
// guess. A header whose shape changed is a deliberate edit and should break the
// build loudly rather than quietly render a stale or empty rail.

import { readFileSync } from "node:fs";
import path from "node:path";

export interface SpecFrontMatter {
  date: string;
  editors: string[];
  status: string;
  version: string;
}

// apps/site/src/lib -> repo root
const repoRoot = path.join(process.cwd(), "..", "..");

function fail(message: string): never {
  throw new Error(
    `spec-front-matter: ${message} Refusing to render the specification rail from a guess — ` +
      "update this parser deliberately if the source format changed."
  );
}

function parseSpecCore(text: string): Pick<SpecFrontMatter, "version" | "status" | "date"> {
  const lines = text.split("\n");

  const h1 = (lines[0] || "").match(/^# Personal Data Portability Protocol \(PDPP\) (v\d+\.\d+\.\d+)\s*$/);
  if (!h1?.[1]) {
    fail(
      `spec-core.md line 1 is not "# Personal Data Portability Protocol (PDPP) vN.N.N" (got ${JSON.stringify(lines[0] ?? "")}).`
    );
  }

  const statusLine = lines.find((line) => line.startsWith("Status:"));
  const status = statusLine?.slice("Status:".length).trim();
  if (!status) {
    fail("spec-core.md has no non-empty 'Status:' header line.");
  }

  const dateLine = lines.find((line) => line.startsWith("Date:"));
  const date = dateLine?.slice("Date:".length).trim();
  if (!(date && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
    fail(`spec-core.md 'Date:' is not YYYY-MM-DD (got ${JSON.stringify(date ?? "")}).`);
  }

  return { date, status, version: h1[1] };
}

// MAINTAINERS.md states: "For root protocol specifications, active maintainers
// act as editors for the current draft." So the editor list is exactly the
// Active rows of that table — add a maintainer there and the rail follows.
function parseEditors(text: string): string[] {
  const editors: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    // | Name | GitHub ID | Scope | Status | Contact |
    const [, name, githubId, , status] = cells;
    if (!(name && githubId?.startsWith("`@")) || status !== "Active") {
      continue;
    }
    editors.push(name);
  }
  if (editors.length === 0) {
    fail("MAINTAINERS.md yielded no Active maintainer rows.");
  }
  return editors;
}

export function getSpecFrontMatter(): SpecFrontMatter {
  const specCore = readFileSync(path.join(repoRoot, "spec-core.md"), "utf8");
  const maintainers = readFileSync(path.join(repoRoot, "MAINTAINERS.md"), "utf8");
  return { ...parseSpecCore(specCore), editors: parseEditors(maintainers) };
}
