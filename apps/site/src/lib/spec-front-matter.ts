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

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface SpecFrontMatter {
  date: string;
  editors: string[];
  status: string;
  version: string;
}

// Walk up to the directory that holds the workspace markers, rather than
// counting path segments from the current working directory. `cwd/../..` is
// only the repo root when the process happens to start in apps/site: it is
// true for `next dev` and `next build` locally, and false on Vercel, where the
// three routes that read the spec 500'd at request time while the one route
// using a marker-based resolver kept working.
//
// Mirrors `openspec/filesystem.ts`, which resolves the same root the same way;
// that one is async and this runs in a sync module scope.
function resolveRepoRoot(): string {
  let dir = process.cwd();
  const { root } = path.parse(dir);
  for (;;) {
    const isRepoRoot =
      existsSync(path.join(dir, "pnpm-workspace.yaml")) &&
      existsSync(path.join(dir, "openspec")) &&
      statSync(path.join(dir, "openspec"), { throwIfNoEntry: false })?.isDirectory() === true;
    if (isRepoRoot) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (dir === root || parent === dir) {
      throw new Error(
        `spec-front-matter: could not resolve the repo root from ${process.cwd()} ` +
          "(needs a directory containing both pnpm-workspace.yaml and openspec/)."
      );
    }
    dir = parent;
  }
}

const repoRoot = resolveRepoRoot();

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
