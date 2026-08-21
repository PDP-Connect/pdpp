#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bans direct `process.env.<CONNECTOR>_USERNAME` / `_PASSWORD` credential
 * reads in connector code.
 *
 * ## Why
 *
 * A connector's sign-in credentials must come from the `credentials` object
 * the runtime resolves for THIS run's connection and threads into
 * `ensureSession` (see `src/auto-login/login-credentials.ts` for the full
 * rationale). Reading `process.env` directly reaches the same value in the
 * happy case — the reference server injects the connection-scoped fragment
 * into the child's environment — but it silently discards everything the
 * runtime built around the declared path:
 *
 *   - a connector that reads `process.env` has no reason to declare an `auth`
 *     block, and four did not (`heb`, `chase`, `amazon`, `chatgpt`), so the
 *     runtime resolved `{}` and never raised the `credentials` INTERACTION
 *     that would have told the owner a credential was expected;
 *   - an absent value falls through to a generic "hand the page to the owner"
 *     branch whose message blames the PAGE, not the credential.
 *
 * The result was a run that bailed to manual sign-in within seconds and gave
 * the owner a misleading reason, indefinitely.
 *
 * ## What this enforces
 *
 * Under `src/auto-login/` and `connectors/`, a credential-shaped
 * `process.env` read is an error. Use `resolveLoginCredentials(credentials,
 * …)` instead. Files still carrying the old shape are listed in
 * `MIGRATION_ALLOWLIST` with the connector that owns them; the list may only
 * shrink. A file that leaves the list can never silently rejoin it, and a NEW
 * file can never be added to it without an explicit edit here — which is what
 * makes the wrong thing hard to do rather than merely discouraged.
 *
 * Test files are exempt: they legitimately set and restore these variables to
 * drive the very fallbacks being migrated away from.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = [join(PACKAGE_ROOT, "src", "auto-login"), join(PACKAGE_ROOT, "connectors")];

/**
 * Credential-shaped environment reads. Deliberately narrow: this bans the
 * per-account SIGN-IN pair, not every `process.env` read. Tokens and API keys
 * that a connector legitimately receives only via injection (and that have no
 * interactive sign-in form) are out of scope here.
 */
const CREDENTIAL_ENV_PATTERN = /process\.env\.([A-Z][A-Z0-9_]*_(?:USERNAME|PASSWORD|EMAIL))\b/g;

/**
 * Files that still read credentials from `process.env`, pending migration to
 * `resolveLoginCredentials`. THIS LIST MAY ONLY SHRINK.
 *
 * Each entry is a path relative to the package root. `heb.ts` is listed
 * because a concurrent change owns that file; the rest are queued behind it so
 * this gate could land without a mass rewrite that would collide with in-flight
 * work.
 */
const MIGRATION_ALLOWLIST: ReadonlySet<string> = new Set([
  "connectors/amazon/index.ts",
  "connectors/jellyfin/index.ts",
  "connectors/reddit/index.ts",
  "src/auto-login/amazon.ts",
  "src/auto-login/chatgpt.ts",
  "src/auto-login/github.ts",
  "src/auto-login/heb.ts",
  "src/auto-login/reddit.ts",
]);

function isScannable(path: string): boolean {
  return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts");
}

function walk(root: string, into: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "fixtures") {
      continue;
    }
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      walk(full, into);
    } else if (isScannable(full)) {
      into.push(full);
    }
  }
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly variable: string;
}

function scan(): { violations: Violation[]; seenAllowlisted: Set<string> } {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(root, files);
  }
  const violations: Violation[] = [];
  const seenAllowlisted = new Set<string>();
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    const rel = relative(PACKAGE_ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, text] of lines.entries()) {
      // Skip comments: this file and login-credentials.ts NAME these variables
      // in prose explaining why they are banned.
      const trimmed = text.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) {
        continue;
      }
      CREDENTIAL_ENV_PATTERN.lastIndex = 0;
      let match = CREDENTIAL_ENV_PATTERN.exec(text);
      while (match !== null) {
        if (MIGRATION_ALLOWLIST.has(rel)) {
          seenAllowlisted.add(rel);
        } else {
          violations.push({ file: rel, line: index + 1, variable: match[1] ?? "" });
        }
        match = CREDENTIAL_ENV_PATTERN.exec(text);
      }
    }
  }
  return { seenAllowlisted, violations };
}

const { violations, seenAllowlisted } = scan();
const stale = [...MIGRATION_ALLOWLIST]
  .filter((entry) => !seenAllowlisted.has(entry))
  .sort((a, b) => a.localeCompare(b));

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error(
    `\n${violations.length} direct credential env read(s) found. Connector sign-in credentials must come from the\n` +
      "runtime-resolved `credentials` object via `resolveLoginCredentials`\n" +
      "(src/auto-login/login-credentials.ts), never from process.env:\n"
  );
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  process.env.${violation.variable}`);
  }
  console.error("");
}

if (stale.length > 0) {
  failed = true;
  console.error(
    "\nMIGRATION_ALLOWLIST entries no longer read credentials from process.env.\n" +
      "Remove them from scripts/check-no-direct-credential-env.ts — the list may only shrink:\n"
  );
  for (const entry of stale) {
    console.error(`  ${entry}`);
  }
  console.error("");
}

if (failed) {
  process.exit(1);
}

console.log(
  `check-no-direct-credential-env: OK (${MIGRATION_ALLOWLIST.size} file(s) pending migration, 0 new violations)`
);
