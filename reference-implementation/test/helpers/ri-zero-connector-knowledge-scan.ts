// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural scanner backing the zero-connector-knowledge conformance guard.
 *
 * Spec: openspec/changes/enforce-ri-zero-connector-knowledge/specs/
 *       reference-implementation-architecture/spec.md
 *
 * Proves RI production code carries no hardcoded connector/provider identity,
 * endpoint, scope, or credential-env-var knowledge. This is a text-structural
 * scan, not a type-checker: it trades a small amount of theoretical
 * evadability (string concatenation, indirect constants) for zero new
 * toolchain dependency, matching the existing manifest-honesty guards in
 * `packages/polyfill-connectors/`. See the change's design.md Non-Goals.
 *
 * The scanner derives its notion of "known connector identity" from the
 * shipped manifests themselves (both manifest roots), rather than hardcoding
 * a second connector-name list here — a hand-typed allowlist in the guard
 * would be exactly the violation the guard exists to forbid.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export interface ScanRoots {
  /** Absolute path to the repository root. */
  repoRoot: string;
}

export interface Violation {
  file: string;
  line: number;
  snippet: string;
  rule: string;
}

const PRODUCTION_SCAN_ROOTS = ["cli", "lib", "operations", "runtime", "scripts", "server"];

/** Directories inside `reference-implementation/` that are exempt: connector-authored
 * code, test files, and generated/docs output. */
const EXEMPT_DIR_SEGMENTS = new Set(["connectors", "test", "node_modules", "generated", "docs", "openapi"]);

const MANIFEST_ROOTS = ["reference-implementation/manifests", "packages/polyfill-connectors/manifests"];

const REGISTRY_ID_PREFIX = "https://registry.pdpp.org/connectors/";

/** Hosts that are generic/protocol/infra, never provider-specific. Anything else
 * appearing as a literal absolute URL host in production code is a violation. */
const GENERIC_URL_HOSTS = new Set([
  "registry.pdpp.org",
  "pdpp.org",
  "pdpp.local",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "example.com",
  "example.test",
  "foreign.example",
  "dashboard.example",
  "schema.org",
  "www.w3.org",
  "w3.org",
  "www.iana.org",
  "iana.org",
  "json-schema.org",
  "www.standardwebhooks.com",
  "standardwebhooks.com",
  "www.rfc-editor.org",
  // n.eko is the RI's own self-hosted browser-surface runtime (see
  // reference-native-provider-boundary spec), not a third-party data
  // provider — its in-network Docker service names are RI infra, same
  // status as `localhost`.
  "neko",
  "neko.local",
  "neko-playground",
  "allocator.local",
  "cdp.local",
]);

/** Env-var name shapes that are always generic (never provider-specific). */
const GENERIC_ENV_PREFIXES = ["PDPP_", "NODE_", "CI_", "GITHUB_ACTIONS", "npm_", "NEKO_"];

function isExemptPath(relPath: string): boolean {
  const segments = relPath.split("/");
  return segments.some((segment) => EXEMPT_DIR_SEGMENTS.has(segment));
}

function walkTsFiles(dir: string, repoRoot: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      walkTsFiles(abs, repoRoot, out);
      continue;
    }
    if (extname(entry) !== ".ts") {
      continue;
    }
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) {
      continue;
    }
    const relPath = relative(repoRoot, abs);
    if (isExemptPath(relative(join(repoRoot, "reference-implementation"), abs))) {
      continue;
    }
    out.push(relPath);
  }
}

/** Every RI production `.ts` file in scope for the guard. */
export function productionFiles({ repoRoot }: ScanRoots): string[] {
  const riRoot = join(repoRoot, "reference-implementation");
  const out: string[] = [];
  for (const root of PRODUCTION_SCAN_ROOTS) {
    walkTsFiles(join(riRoot, root), repoRoot, out);
  }
  return out.sort();
}

function connectorKeyFromManifestId(id: unknown): string | null {
  if (typeof id !== "string" || !id.startsWith(REGISTRY_ID_PREFIX)) {
    return null;
  }
  return id.slice(REGISTRY_ID_PREFIX.length);
}

/** Reads `connector_key`/`connector_id` from every manifest across both roots.
 * This is the guard's sole source of "known connector identity" — never
 * hand-typed. */
export function manifestDerivedConnectorKeys({ repoRoot }: ScanRoots): Set<string> {
  const keys = new Set<string>();
  for (const manifestRoot of MANIFEST_ROOTS) {
    const dir = join(repoRoot, manifestRoot);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const file of files) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }
      const key = parsed.connector_key;
      if (typeof key === "string" && key.length > 0) {
        keys.add(key);
      }
      const derivedFromId = connectorKeyFromManifestId(parsed.connector_id);
      if (derivedFromId) {
        keys.add(derivedFromId);
      }
    }
  }
  return keys;
}

const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function stripComments(source: string): string {
  // Blank out line and block comments so literals inside comments/docs don't
  // false-positive, while preserving line numbers (newlines kept intact).
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, pre) => pre + " ".repeat(m.length - pre.length));
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

function lineTextAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? source.length : end).trim();
}

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN|API_KEY|ACCESS_TOKEN|PASSWORD)$/;

/**
 * A small set of manifest-derived connector keys double as ordinary English
 * words or generic technical terms (`meta`, `oura`, `notion`, `loom`,
 * `strava`, `steam`, `pocket`, `shopify`-adjacent brand words, etc.) and can
 * appear in production code with no connector-identity meaning at all (e.g.
 * a `meta` field on an unrelated JSON envelope). A bare string-literal match
 * against the manifest-derived key set is therefore not sufficient signal by
 * itself — it must appear in an IDENTITY CONTEXT: alongside a sibling string
 * literal that is also a known connector key (an allowlist/array of keys), or
 * immediately after an identity-shaped identifier (`connector`, `connectorId`,
 * `connectorKey`, `canonicalId`, `provider`, `providerId`) via `===`/`==`/`:`/
 * a case clause. This keeps the guard from flagging incidental short-word
 * collisions while still catching every real allowlist/dispatch/branch shape
 * found in the audit.
 */
const IDENTITY_CONTEXT_BEFORE_RE =
  /(?:connector(?:Id|Key|_id|_key)?|canonicalId|canonical_key|provider(?:Id|_id)?)\s*(?:===|==|!==|!=|:)\s*$/i;
const CASE_CONTEXT_BEFORE_RE = /\bcase\s*$/;

function hasIdentityContext(source: string, matchStart: number): boolean {
  const before = source.slice(Math.max(0, matchStart - 80), matchStart);
  return IDENTITY_CONTEXT_BEFORE_RE.test(before) || CASE_CONTEXT_BEFORE_RE.test(before);
}

/**
 * Scans one production file's source for the four violation shapes:
 * (1) a string literal equal to a known manifest-derived connector key,
 *     appearing in identity-comparison/collection context;
 * (2) [covered by (1) generically — array/set/object-key/switch/=== all
 *     surface as a bare string literal match against the known-key set];
 * (3) a literal absolute URL whose host isn't on the generic allowlist;
 * (4) a provider-shaped credential env-var name literal.
 */
export function scanFile(absPath: string, relPath: string, connectorKeys: Set<string>): Violation[] {
  const raw = readFileSync(absPath, "utf8");
  const source = stripComments(raw);
  const violations: Violation[] = [];

  // First pass: collect every string-literal match with its list membership,
  // so a "sibling literal in the same array/object" context can be detected
  // without a full parser (two-or-more known-connector-key literals close
  // together is itself the allowlist shape we're catching).
  const literalMatches = [...source.matchAll(STRING_LITERAL_RE)].map((m) => ({
    index: m.index ?? 0,
    value: m[2] ?? "",
  }));
  const connectorLiteralIndexes = literalMatches
    .filter((m) => connectorKeys.has(m.value))
    .map((m) => m.index);

  function hasNearbyConnectorSibling(index: number): boolean {
    // Another known-connector-key literal within 200 chars (same array/object
    // literal in practice) is itself the allowlist/dispatch-table shape.
    return connectorLiteralIndexes.some((other) => other !== index && Math.abs(other - index) <= 200);
  }

  for (const { index, value } of literalMatches) {
    if (connectorKeys.has(value) && (hasIdentityContext(source, index) || hasNearbyConnectorSibling(index))) {
      violations.push({
        file: relPath,
        line: lineNumberAt(source, index),
        snippet: lineTextAt(raw, index),
        rule: "hardcoded-connector-identity-literal",
      });
      continue;
    }

    const urlMatch = value.match(/^https?:\/\/([^/\s:]+)/);
    if (urlMatch) {
      const host = (urlMatch[1] ?? "").toLowerCase();
      // `${...}` (template-literal interpolation, since the literal scanner
      // doesn't distinguish backtick templates from quoted strings) and
      // `{placeholder}` host segments are not hardcoded hosts at all — a
      // dynamically-assembled or placeholder-templated URL carries no
      // provider knowledge by itself.
      const isPlaceholderHost = host.includes("$") || host.includes("{");
      if (host && !isPlaceholderHost && !GENERIC_URL_HOSTS.has(host)) {
        violations.push({
          file: relPath,
          line: lineNumberAt(source, index),
          snippet: lineTextAt(raw, index),
          rule: "hardcoded-provider-endpoint-url",
        });
      }
      continue;
    }

    if (ENV_KEY_RE.test(value) && !GENERIC_ENV_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      violations.push({
        file: relPath,
        line: lineNumberAt(source, index),
        snippet: lineTextAt(raw, index),
        rule: "hardcoded-provider-credential-env-key",
      });
    }
  }

  // Multiple literals on one line (e.g. a multi-entry array literal) each
  // independently match the same rule; collapse to one report per
  // file:line:rule so the inventory reads as one fix action per site.
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.line}:${v.rule}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function scanRepository(roots: ScanRoots): Violation[] {
  const connectorKeys = manifestDerivedConnectorKeys(roots);
  const files = productionFiles(roots);
  const violations: Violation[] = [];
  for (const relPath of files) {
    violations.push(...scanFile(join(roots.repoRoot, relPath), relPath, connectorKeys));
  }
  return violations;
}

export function formatViolationInventory(violations: Violation[]): string {
  if (violations.length === 0) {
    return "no violations";
  }
  const lines = violations
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.snippet}`);
  return `${violations.length} violation(s):\n${lines.join("\n")}`;
}
