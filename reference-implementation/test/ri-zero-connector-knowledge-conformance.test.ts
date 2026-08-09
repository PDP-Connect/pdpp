// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zero-connector-knowledge conformance guard.
 *
 * Proves RI production code (`cli/`, `lib/`, `operations/`, `runtime/`,
 * `scripts/`, `server/` under `reference-implementation/`, excluding
 * `connectors/` and test files) carries no hardcoded connector/provider
 * identity, endpoint, OAuth scope, or credential-env-var knowledge. Behavior
 * SHALL be constructed only from normative protocol concepts, the manifest
 * schema, and connector-authored facts — never from RI code that already
 * knows which connectors exist.
 *
 * `packages/polyfill-connectors/src/connector-conformance.test.ts` and its
 * siblings prove connectors are honest about what they declare. This test
 * proves the opposite direction: that RI code stays ignorant of which
 * connectors exist, reading everything it needs from the manifest instead.
 *
 * Also proves RI production code cannot evade the above by moving
 * connector/provider policy knowledge into a sibling JSON/YAML data file.
 * That closure is load-site-based, not syntax-based: it does not matter
 * whether the data reaches the file via `readFileSync`, `require`, dynamic
 * `import()`, a static `import ... with { type: "json" }`, or `new
 * URL(path, import.meta.url)` piped through `join`/`resolve` — every one of
 * those is resolved by the same AST-based constant-folder in
 * `helpers/ri-zero-connector-knowledge-data-load-scan.ts` and classified
 * identically. See that module's doc comment for the exact resolution rules
 * and the disclosed residual (single-file analysis; a value that crosses a
 * function-call boundary into a different file, or that has been reassigned
 * after declaration, is treated as UNRESOLVABLE — a violation — not silently
 * passed).
 *
 * Spec: openspec/changes/enforce-ri-zero-connector-knowledge/specs/
 *       reference-implementation-architecture/spec.md
 *
 * The zero-connector-knowledge violations this guard originally found have
 * been fixed (see `fix(ri): close Cluster C + version-disposition/scheduler/
 * compaction connector-knowledge violations`); it now runs as a standing
 * regression gate that must stay green.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isExemptDataLoadPath, scanFileDataLoads } from "./helpers/ri-zero-connector-knowledge-data-load-scan.ts";
import {
  formatViolationInventory,
  manifestDerivedConnectorKeys,
  productionFiles,
  scanFile,
  scanRepository,
} from "./helpers/ri-zero-connector-knowledge-scan.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(__dirname));

test("manifest-derived connector identity set is non-trivial (sanity check on the derivation itself)", () => {
  const keys = manifestDerivedConnectorKeys({ repoRoot });
  // A hardcoded lower-bound count would itself be exactly the kind of
  // hand-typed connector fact this guard forbids; assert shape instead.
  assert.ok(keys.size > 10, `expected manifests to yield a real connector-key vocabulary, got ${keys.size}`);
  assert.ok(keys.has("gmail"), "expected the well-known gmail connector to be derivable from shipped manifests");
});

test("falsifiability: the scanner detects a synthetic hardcoded-identity violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-violation.ts");
    writeFileSync(
      badFile,
      [
        "export function isFirstParty(connectorId: string): boolean {",
        '  return connectorId === "gmail" || connectorId === "slack";',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-violation.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      "scanner failed to detect a synthetic connector-identity literal — the guard would be a green-path wrapper"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: the scanner detects a synthetic provider-endpoint violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-endpoint.ts");
    writeFileSync(badFile, ['export const TOKEN_URL = "https://oauth2.example-provider.com/token";', ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-endpoint.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-provider-endpoint-url"),
      "scanner failed to detect a synthetic provider-endpoint URL"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: the scanner detects a synthetic provider-credential env key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-env.ts");
    writeFileSync(badFile, ['const key = "ACME_CLIENT_SECRET";', ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-env.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-provider-credential-env-key"),
      "scanner failed to detect a synthetic provider-shaped env var name"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: the scanner does not flag manifest-generic code", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-generic.ts");
    writeFileSync(
      goodFile,
      [
        "export function canonicalKey(manifest: { connector_key?: string }): string | null {",
        "  return manifest.connector_key ?? null;",
        "}",
        'export const REGISTRY_URL = "https://registry.pdpp.org/connectors/";',
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-generic.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.deepEqual(violations, [], "generic manifest-driven code must not be flagged");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// --- Rule (5): AST-based data-resource-load scanning -----------------------
//
// These tests write a synthetic source file into a REAL location inside the
// repo tree under reference-implementation/server/ (created and removed
// per-test) rather than an isolated tmpdir, because the manifest-root
// provenance check and the manifest-root resolution both need real repo
// paths (`repoRoot`-relative resolution, and reading the real shipped
// manifest files for the provenance check) to behave exactly as they would
// for a real production file. Each temp file is uniquely named and removed
// in `finally`, so no repo state changes survive a test.
//
// SAFETY: `withSyntheticProductionFile` REFUSES to write over a path that
// already exists on disk — it throws immediately instead of clobbering a
// real production file. Use `withSyntheticContentAtRealPath` for the one
// legitimate case that needs a REAL, already-existing relPath string
// (testing the SANCTIONED_POLICY_RESOURCES allowlist end-to-end): it writes
// synthetic content to an ISOLATED tmpdir file and passes the real file's
// relPath string alongside it, never touching the real file on disk.

function withSyntheticProductionFile<T>(fileName: string, contents: string, run: (relPath: string) => T): T {
  const relPath = `reference-implementation/server/${fileName}`;
  const absPath = join(repoRoot, relPath);
  if (existsSync(absPath)) {
    throw new Error(`refusing to overwrite a file that already exists on disk: ${absPath}`);
  }
  writeFileSync(absPath, contents);
  try {
    return run(relPath);
  } finally {
    rmSync(absPath, { force: true });
  }
}

/**
 * Writes `contents` to an isolated tmpdir file (never touches the real repo
 * tree) and invokes `run` with that tmpdir file's absolute path AND a REAL
 * repo-relative path string of the caller's choosing — exercising
 * classification logic (allowlist/manifest-root lookups keyed by relPath)
 * against a real path WITHOUT ever writing to or deleting the real file.
 */
function withSyntheticContentAtRealPath<T>(
  realRelPath: string,
  contents: string,
  run: (absPath: string, relPath: string) => T
): T {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-real-relpath-"));
  try {
    const tmpAbsPath = join(dir, "synthetic-source.ts");
    writeFileSync(tmpAbsPath, contents);
    return run(tmpAbsPath, realRelPath);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const DOLLAR = String.fromCharCode(36);

test("falsifiability (P1 fix): new URL(...) sibling load is caught", () => {
  withSyntheticProductionFile(
    "synthetic-new-url-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      'const POLICY_PATH = new URL("../../packages/polyfill-connectors/gmail-policy.json", import.meta.url);',
      'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "new URL(...) sibling load outside the allowlist/manifest roots must be flagged"
      );
    }
  );
});

test("falsifiability (P1 fix): readFileSync(join(__dirname, ...)) reaching the identical sibling file is caught", () => {
  // This is the exact live mutation from the red-team review: the same
  // sibling-JSON evasion, reached via join(__dirname, ...) instead of new
  // URL(..., import.meta.url). Before this fix, this shape was completely
  // invisible to the guard (91 violations, zero mention of this file).
  withSyntheticProductionFile(
    "synthetic-join-dirname-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const __dirname = dirname(fileURLToPath(import.meta.url));",
      'const POLICY_PATH = join(__dirname, "gmail-policy.json");',
      'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "readFileSync(join(__dirname, ...)) reaching the same sibling file must be flagged identically to new URL(...)"
      );
    }
  );
});

test("falsifiability (P1 fix): readFileSync(path.resolve(__dirname, ...)) is caught", () => {
  withSyntheticProductionFile(
    "synthetic-resolve-dirname-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      'import { dirname, resolve } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const __dirname = dirname(fileURLToPath(import.meta.url));",
      'const POLICY_PATH = resolve(__dirname, "gmail-policy.json");',
      'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "readFileSync(resolve(__dirname, ...)) must be flagged"
      );
    }
  );
});

test("falsifiability (P1 fix): require(...) reaching a sibling JSON file is caught", () => {
  withSyntheticProductionFile(
    "synthetic-require-load.ts",
    ['const POLICY = require("./gmail-policy.json");', ""].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "require(...) reaching a sibling JSON file must be flagged"
      );
    }
  );
});

test("falsifiability (P1 fix): dynamic import(...) reaching a sibling JSON file is caught", () => {
  withSyntheticProductionFile(
    "synthetic-dynamic-import-load.ts",
    ["async function loadPolicy() {", '  return (await import("./gmail-policy.json")).default;', "}", ""].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "dynamic import(...) reaching a sibling JSON file must be flagged"
      );
    }
  );
});

test("falsifiability (P1 fix): static `import ... with { type: 'json' }` reaching a sibling JSON file is caught", () => {
  withSyntheticProductionFile(
    "synthetic-import-attribute-load.ts",
    ['import policy from "./gmail-policy.json" with { type: "json" };', "export { policy };", ""].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "a static json-attribute import reaching a sibling JSON file must be flagged"
      );
    }
  );
});

test("falsifiability (P4 fix): a renamed/no-extension sibling file loaded as JSON is caught", () => {
  withSyntheticProductionFile(
    "synthetic-no-extension-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      'const POLICY_PATH = new URL("./gmail-policy-data", import.meta.url);',
      'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "a JSON.parse-consumed read of a no-extension sibling file must be flagged even though the path has no .json suffix"
      );
    }
  );
});

test("falsifiability (rule 6 / revise3 P2 fix): eval(require)(...) reaching a sibling JSON file is caught", () => {
  // The exact live evasion from the revise3 independent re-gate: eval hides
  // the require callee from calleeName entirely, so before this fix this
  // shape produced zero violations, silently.
  withSyntheticProductionFile(
    "synthetic-eval-require-load.ts",
    ['const POLICY = eval("require")("./gmail-policy.json");', ""].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "prohibited-data-load-evasion-mechanism"),
        "eval(...) must be flagged outright, regardless of what it evaluates to"
      );
    }
  );
});

test("falsifiability (rule 6 / revise3 P2 fix): child_process execSync(...) shelling out to read a sibling JSON file is caught", () => {
  // The other live evasion from the revise3 re-gate: execSync("cat
  // gmail-policy.json") is an arbitrary shell command line, entirely outside
  // the scanner's readFileSync/require/import call vocabulary.
  withSyntheticProductionFile(
    "synthetic-child-process-execsync-load.ts",
    [
      'import { execSync } from "node:child_process";',
      'const POLICY = JSON.parse(execSync("cat gmail-policy.json").toString());',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "prohibited-data-load-evasion-mechanism"),
        "child_process execSync(...) must be flagged outright, regardless of the shell command text"
      );
    }
  );
});

test("falsifiability (rule 6 / revise3 P2 fix): a namespace-imported child_process.exec(...) shell-out is caught", () => {
  withSyntheticProductionFile(
    "synthetic-child-process-namespace-exec-load.ts",
    [
      'import * as childProcess from "node:child_process";',
      'childProcess.exec("cat gmail-policy.json", (_err, stdout) => JSON.parse(stdout));',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "prohibited-data-load-evasion-mechanism"),
        "a namespace-imported child_process.exec(...) call must be flagged outright"
      );
    }
  );
});

test("falsifiability (rule 6 counterweight): legitimate argv-array child_process calls (execFileSync/spawn) are NOT flagged by rule 6", () => {
  // execFileSync/spawn take an argv array, not a shell command string, and
  // are real, legitimate production usage elsewhere in this codebase (e.g.
  // server/reference-revision.ts's `execFileSync("git", args, ...)`). Rule
  // (6) must not over-broadly flag every child_process import.
  withSyntheticProductionFile(
    "synthetic-child-process-execfilesync-legitimate.ts",
    [
      'import { execFileSync } from "node:child_process";',
      "export function gitRevision(): string {",
      '  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();',
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.deepEqual(
        violations,
        [],
        "execFileSync (argv-array form) must not be flagged by the eval/shell-exec prohibition"
      );
    }
  );
});

test("falsifiability (rule 6 counterweight): an unrelated same-named local `exec` function (not imported from child_process) is NOT flagged", () => {
  // This codebase's own lib/db.ts declares `export function exec(query, params)`
  // — a SQL helper with no relation to child_process. Rule (6) is keyed off
  // the real import binding, not the bare identifier text, so this must not
  // collide.
  withSyntheticProductionFile(
    "synthetic-unrelated-exec-local.ts",
    [
      "function exec(query: string, params: unknown[]): void {",
      "  // pretend SQL execution, unrelated to child_process",
      "}",
      'exec("SELECT 1", []);',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.deepEqual(violations, [], "a locally-declared exec() unrelated to node:child_process must not be flagged");
    }
  );
});

test("falsifiability (P2 fix): a non-manifest JSON file dropped in a manifest root is caught (provenance, not path prefix)", () => {
  withSyntheticProductionFile(
    "synthetic-manifest-root-provenance-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      'const POLICY_PATH = new URL("../manifests/not-a-manifest-secret-policy.json", import.meta.url);',
      'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
      "",
    ].join("\n"),
    (relPath) => {
      const fakeManifestPath = join(repoRoot, "reference-implementation/manifests/not-a-manifest-secret-policy.json");
      writeFileSync(fakeManifestPath, JSON.stringify({ some_policy_blob: true }));
      try {
        const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
        assert.ok(
          violations.some((v) => v.rule === "manifest-root-file-lacks-manifest-provenance"),
          "a .json file under a manifest root with no connector_id/connector_key must still be rejected — path prefix alone is not trust"
        );
      } finally {
        rmSync(fakeManifestPath, { force: true });
      }
    }
  );
});

test("falsifiability: a real manifest-root file WITH manifest provenance is not flagged", () => {
  withSyntheticProductionFile(
    "synthetic-manifest-root-real-provenance-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      'const MANIFEST_PATH = new URL("../manifests/synthetic-provenance-ok.json", import.meta.url);',
      'const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));',
      "",
    ].join("\n"),
    (relPath) => {
      const realManifestPath = join(repoRoot, "reference-implementation/manifests/synthetic-provenance-ok.json");
      writeFileSync(realManifestPath, JSON.stringify({ connector_id: "synthetic-test-connector" }));
      try {
        const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
        assert.deepEqual(
          violations,
          [],
          "a manifest-root .json file that actually declares connector_id must pass the provenance check"
        );
      } finally {
        rmSync(realManifestPath, { force: true });
      }
    }
  );
});

test("falsifiability: a sanctioned RI-owned sibling policy resource is not flagged (regardless of load-site syntax)", () => {
  // Uses withSyntheticContentAtRealPath (isolated tmpdir content, never
  // written to the real file on disk) — NOT withSyntheticProductionFile —
  // because relPath here is the REAL SANCTIONED_POLICY_RESOURCES key
  // (reference-implementation/server/version-disposition.ts). An earlier
  // version of this test wrote synthetic content directly over that real
  // production file and deleted it in `finally`; this shape proves the same
  // allowlist entry without ever touching the file on disk.
  withSyntheticContentAtRealPath(
    "reference-implementation/server/version-disposition.ts",
    [
      'import { readFileSync } from "node:fs";',
      'const POLICY_PATH = new URL("./version-disposition-policy.json", import.meta.url);',
      'const POLICY = JSON.parse(readFileSync(POLICY_PATH, "utf8"));',
      "",
    ].join("\n"),
    (absPath, relPath) => {
      // The real version-disposition-policy.json sibling already exists at
      // this relPath in the repo, so this exercises the real allowlist
      // entry end-to-end without needing a synthetic policy file.
      const violations = scanFileDataLoads(absPath, relPath, repoRoot);
      assert.deepEqual(violations, [], "an allowlisted sibling policy resource must not be flagged");
    }
  );
});

test("falsifiability (P1 fix): parameter-indirection through a same-file helper still resolves and is checked", () => {
  withSyntheticProductionFile(
    "synthetic-helper-indirection-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      "function readJsonPolicy(path: string) {",
      '  return JSON.parse(readFileSync(path, "utf8"));',
      "}",
      "function loadIt() {",
      '  return readJsonPolicy(new URL("./gmail-policy.json", import.meta.url).pathname);',
      "}",
      "export { loadIt };",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      // readJsonPolicy's `path` parameter has exactly one call site, whose
      // argument (new URL("./gmail-policy.json", import.meta.url).pathname)
      // IS statically resolvable (the .pathname off a resolvable new URL(...)
      // resolves the same as the URL itself) — so parameter indirection
      // through the helper correctly reaches the real sibling path, and
      // that path is neither allowlisted nor a manifest, so it must still
      // be flagged as unsanctioned, not silently pass just because it went
      // through a helper.
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "a helper parameter that DOES resolve (via one hop of call-site indirection) must still be checked against the allowlist, not exempted for going through a helper"
      );
    }
  );
});

test("falsifiability (P1 fix): parameter-indirection through a same-file helper fails closed when the call-site argument is itself unresolvable", () => {
  withSyntheticProductionFile(
    "synthetic-helper-indirection-unresolvable-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      "function readJsonPolicy(path: string) {",
      '  return JSON.parse(readFileSync(path, "utf8"));',
      "}",
      "function loadIt(entry: { path: string }) {",
      "  return readJsonPolicy(entry.path);",
      "}",
      "export { loadIt };",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      // readJsonPolicy's `path` parameter has exactly one call site, whose
      // argument (entry.path) is a MemberExpression this scanner does not
      // evaluate — genuinely unresolvable, so this must fail closed rather
      // than silently pass.
      assert.ok(
        violations.some((v) => v.rule === "unresolvable-data-resource-load"),
        "a helper parameter whose call-site argument cannot be statically resolved must fail closed, not pass silently"
      );
    }
  );
});

test("falsifiability: parameter-indirection does NOT cross-resolve two unrelated same-named parameters in different functions", () => {
  withSyntheticProductionFile(
    "synthetic-helper-indirection-ambiguity-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      // `file` is a parameter of TWO unrelated functions in this file. The
      // first is called with a real JSON sibling path; the second is called
      // with an unrelated non-path string. A scanner that resolves by name
      // alone (ignoring which function lexically encloses the reference)
      // risks cross-resolving the wrong function's call sites.
      "function readJsonPolicy(file: string) {",
      '  return JSON.parse(readFileSync(file, "utf8"));',
      "}",
      "function describeFile(file: string): string {",
      '  return "file: " + file;',
      "}",
      'readJsonPolicy(new URL("./gmail-policy.json", import.meta.url).pathname);',
      'describeFile("not-a-path-at-all");',
      "export { describeFile };",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      // readJsonPolicy's own call site correctly resolves to the real
      // sibling path and is flagged as unsanctioned (both the readFileSync
      // call inside readJsonPolicy, resolved via parameter indirection, AND
      // the standalone `new URL(...)` construction at the call site are
      // independently flagged — expected defense-in-depth, not a bug).
      // describeFile's unrelated `file` parameter — a plain non-path string
      // — must not leak into readJsonPolicy's resolution or produce ANY
      // violation tied to describeFile's own call site (line 9).
      assert.ok(
        violations.some((v) => v.rule === "unsanctioned-policy-resource-path"),
        "readJsonPolicy's own call site must still resolve correctly"
      );
      assert.ok(
        violations.every((v) => v.line !== 9),
        `describeFile's unrelated same-named parameter must not produce a spurious violation at its own call site — got ${JSON.stringify(violations)}`
      );
    }
  );
});

test("falsifiability: a genuinely unresolvable JSON.parse(readFileSync(...)) call is flagged, not silently passed", () => {
  withSyntheticProductionFile(
    "synthetic-unresolvable-load.ts",
    [
      'import { readFileSync } from "node:fs";',
      "export function loadFromEnv(env: NodeJS.ProcessEnv) {",
      '  const path = env.SOME_POLICY_PATH ?? "";',
      '  return JSON.parse(readFileSync(path, "utf8"));',
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "unresolvable-data-resource-load"),
        "a JSON.parse-consumed read whose path cannot be statically resolved must fail the gate, per 'no unknown data loads pass'"
      );
    }
  );
});

test("falsifiability: a non-JSON-consuming read of an unresolvable path is correctly out of rule (5)'s scope", () => {
  // e.g. reading an operator-supplied secret-key-file as raw text, never
  // JSON.parse'd and never resolved to a .json/.yaml-shaped literal path —
  // this is real code in credential-encryption.ts and must not be flagged,
  // since it demonstrably never carries JSON/YAML policy data.
  withSyntheticProductionFile(
    "synthetic-raw-text-read.ts",
    [
      'import { readFileSync } from "node:fs";',
      "export function readSecretKeyFile(path: string): string {",
      '  return readFileSync(path, "utf8").trim();',
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.deepEqual(
        violations,
        [],
        "a read that is never JSON.parse'd and never resolves to a data-shaped extension is out of rule (5)'s scope"
      );
    }
  );
});

test("falsifiability: a dynamic manifest-root selection (the legitimate 'pick a manifest by id' shape) is not flagged", () => {
  withSyntheticProductionFile(
    "synthetic-manifest-select.ts",
    [
      'import { readFileSync } from "node:fs";',
      "function loadManifest(entryName: string) {",
      `  const path = new URL(\`../../packages/polyfill-connectors/manifests/${DOLLAR}{entryName}\`, import.meta.url);`,
      '  return JSON.parse(readFileSync(path, "utf8"));',
      "}",
      'loadManifest("gmail.json");',
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanFileDataLoads(join(repoRoot, relPath), relPath, repoRoot);
      assert.deepEqual(
        violations,
        [],
        "selecting a manifest by connector-supplied id, resolving inside a sanctioned manifest root, must not be flagged"
      );
    }
  );
});

test("falsifiability (P3 fix): EXEMPT_DIR_SEGMENTS no longer exempts a nested directory sharing a name at any depth", () => {
  // The live mutation from the red-team review: a directory named `test`
  // nested under a production scan root (not the top-level
  // reference-implementation/test/, which isn't walked at all) containing a
  // live violation. Before this fix, isExemptPath matched ANY path segment
  // named `test` anywhere, so this was silently excluded from the scan.
  assert.equal(
    isExemptDataLoadPath("test/production-helper.ts"),
    false,
    "a nested directory literally named `test` under a production scan root must NOT be exempt (only connectors/generated/docs/openapi are, and only at the scan root's own top level)"
  );
  assert.equal(
    isExemptDataLoadPath("connectors/index.ts"),
    true,
    "a top-level connectors/ directory directly under a scan root is still legitimately exempt"
  );
});

test("falsifiability (P3 fix): a live connector-identity violation inside a nested server/test/ directory is caught by the full scan", () => {
  const nestedDir = join(repoRoot, "reference-implementation/server/test");
  mkdirSync(nestedDir, { recursive: true });
  const badFile = join(nestedDir, "synthetic-nested-test-dir-violation.ts");
  writeFileSync(
    badFile,
    [
      "export function isFirstParty(connectorId: string): boolean {",
      '  return connectorId === "gmail" || connectorId === "slack";',
      "}",
      "",
    ].join("\n")
  );
  try {
    const relPath = "reference-implementation/server/test/synthetic-nested-test-dir-violation.ts";
    const violations = scanFile(badFile, relPath, new Set(["gmail", "slack"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      "a connector-identity violation inside server/test/ (not the top-level reference-implementation/test/) must be caught, not silently exempted"
    );
  } finally {
    rmSync(nestedDir, { force: true, recursive: true });
  }
});

test("falsifiability (revise3 P2 fix): productionFiles discovers .js/.mjs/.cjs/.mts/.cts production siblings, not just .ts", () => {
  // The live gap from the revise3 independent re-gate: scripts/run-tests-failure.js
  // is a real, non-test, production .js file directly under a scanned
  // production root (scripts/) that walkTsFiles's old `.ts`-only filter made
  // completely invisible. Prove the extension set now covers the repo's
  // real executable JS/TS surface by planting one synthetic file per
  // extension and confirming productionFiles discovers each of them.
  const extensions = [".js", ".mjs", ".cjs", ".mts", ".cts"];
  const plantedRelPaths: string[] = [];
  try {
    for (const ext of extensions) {
      const relPath = `reference-implementation/scripts/synthetic-extension-scope-probe${ext}`;
      const absPath = join(repoRoot, relPath);
      if (existsSync(absPath)) {
        throw new Error(`refusing to overwrite a file that already exists on disk: ${absPath}`);
      }
      writeFileSync(absPath, "export const probe = true;\n");
      plantedRelPaths.push(relPath);
    }
    const discovered = new Set(productionFiles({ repoRoot }));
    for (const relPath of plantedRelPaths) {
      assert.ok(discovered.has(relPath), `productionFiles must discover ${relPath}, not just .ts siblings`);
    }
  } finally {
    for (const relPath of plantedRelPaths) {
      rmSync(join(repoRoot, relPath), { force: true });
    }
  }
});

test("falsifiability (revise3 P2 fix): a live connector-identity violation in a .js production file is caught by the full scan", () => {
  withSyntheticProductionFile(
    "synthetic-js-extension-violation.js",
    [
      "export function isFirstParty(connectorId) {",
      '  return connectorId === "gmail" || connectorId === "slack";',
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const absPath = join(repoRoot, relPath);
      const violations = scanFile(absPath, relPath, new Set(["gmail", "slack"]), repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
        "a connector-identity violation in a .js production file must be caught, matching .ts coverage"
      );
    }
  );
});

test("falsifiability (revise3 P2 counterweight): .d.ts declaration files and test-suffixed non-.ts extensions stay excluded", () => {
  const plantedRelPaths: string[] = [];
  try {
    for (const fileName of [
      "synthetic-extension-scope-declaration-probe.d.ts",
      "synthetic-extension-scope-test-probe.test.mjs",
      "synthetic-extension-scope-test-probe.test.js",
    ]) {
      const relPath = `reference-implementation/scripts/${fileName}`;
      const absPath = join(repoRoot, relPath);
      if (existsSync(absPath)) {
        throw new Error(`refusing to overwrite a file that already exists on disk: ${absPath}`);
      }
      writeFileSync(absPath, "export const probe = true;\n");
      plantedRelPaths.push(relPath);
    }
    const discovered = new Set(productionFiles({ repoRoot }));
    for (const relPath of plantedRelPaths) {
      assert.ok(!discovered.has(relPath), `productionFiles must NOT discover ${relPath} (declaration/test file)`);
    }
  } finally {
    for (const relPath of plantedRelPaths) {
      rmSync(join(repoRoot, relPath), { force: true });
    }
  }
});

test("RI production code contains zero connector/provider-specific executable knowledge", () => {
  const violations = scanRepository({ repoRoot });
  assert.deepEqual(violations, [], formatViolationInventory(violations));
});
