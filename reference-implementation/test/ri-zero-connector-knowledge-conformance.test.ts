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
  manifestDerivedValidationKinds,
  productionFiles,
  scanFile,
  scanRepository,
  scanSharedLibraryKindDispatchFile,
  scanSharedLibraryKindDispatchRoot,
  sharedLibraryKindDispatchScanFiles,
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
// real production file.
//
// `SANCTIONED_POLICY_RESOURCES` (ri-zero-connector-knowledge-data-load-
// scan.ts) is EMPTY as of `ri-zero-knowledge-terminal-revise-0810` — both
// production files that used to load a sibling RI-owned JSON registry
// through it (compact-record-history.ts, version-disposition.ts) now read
// their connector-fact half from a real manifest and their owner-judgment
// half from operator runtime state instead (see that constant's own doc
// comment). There is accordingly no longer a real allowlisted relPath to
// exercise end-to-end, so the `withSyntheticContentAtRealPath` helper this
// section previously used ONLY for that one test has been removed along with
// the test — if a future change adds a genuine `SANCTIONED_POLICY_RESOURCES`
// entry, re-add an equivalent real-relPath falsifiability test alongside it.

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

// ─── Regression mutation tests: the real violation this guard originally
// missed (manual-upload-final-redteam-0810, finding 2/6) ────────────────
//
// `ref-manual-upload-draft-connection.ts` shipped a
// `validateWhatsAppChatExportArtifactFromFile` import plus a
// `kind === "whatsapp_chat_export"` branch in RI production code — real
// connector knowledge, invisible to every rule that existed at the time
// (rule (1) only matches `connector_key`/`connector_id` values like
// `"whatsapp"`, not a `validation.kind` value like `"whatsapp_chat_export"`;
// no rule inspected import specifiers at all). These tests reproduce that
// EXACT shape as a synthetic fixture and prove the two new rules this
// pass adds (6: hardcoded-validation-kind-literal, 7: connector-module-import)
// catch it — a scanner-hardening mutation test, not just a code fix.

test("manifest-derived validation-kind set is non-trivial and includes the real WhatsApp kind", () => {
  const kinds = manifestDerivedValidationKinds({ repoRoot });
  assert.ok(kinds.size > 0, `expected at least one manifest-declared validation.kind, got ${kinds.size}`);
  assert.ok(kinds.has("whatsapp_chat_export"), "expected the real WhatsApp manifest's validation.kind to be derivable");
});

test("falsifiability (final-redteam #2): the scanner detects a synthetic hardcoded validation.kind branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-validation-kind.ts");
    writeFileSync(
      badFile,
      [
        "export function requiresFileBackedValidation(kind: string | null): boolean {",
        '  return kind === "whatsapp_chat_export";',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(
      badFile,
      "synthetic-validation-kind.ts",
      new Set(),
      repoRoot,
      new Set(["whatsapp_chat_export"])
    );
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-validation-kind-literal"),
      "scanner failed to detect a synthetic validation.kind literal branch — the exact shape that shipped undetected"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability (final-redteam #2): a bare `kind === <unrelated string>` comparison, not a manifest-derived kind, is NOT flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-unrelated-kind.ts");
    writeFileSync(
      goodFile,
      [
        "export function isRecordKind(kind: string | null): boolean {",
        '  return kind === "record" || kind === "collection";',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(
      goodFile,
      "synthetic-unrelated-kind.ts",
      new Set(),
      repoRoot,
      new Set(["whatsapp_chat_export"])
    );
    assert.ok(
      violations.every((v) => v.rule !== "hardcoded-validation-kind-literal"),
      `an unrelated 'kind' discriminator (not a manifest-derived validation.kind value) must not be flagged, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability (final-redteam #2): the scanner detects a synthetic connector-module import specifier", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-connector-import.ts");
    writeFileSync(
      badFile,
      [
        'import { validateWhatsAppChatExportArtifactFromFile } from "../../../packages/polyfill-connectors/connectors/whatsapp/validation.ts";',
        "export { validateWhatsAppChatExportArtifactFromFile };",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-connector-import.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "connector-module-import"),
      "scanner failed to detect a direct import of a connector's own module — the exact shape that shipped undetected"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability (final-redteam #2 counterweight): importing the shared connector-agnostic dispatcher (packages/polyfill-connectors/src/...) is NOT flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-shared-dispatcher-import.ts");
    writeFileSync(
      goodFile,
      [
        'import { validateManualUploadArtifactFromFileByKind } from "../../../packages/polyfill-connectors/src/manual-upload-validation.ts";',
        "export { validateManualUploadArtifactFromFileByKind };",
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-shared-dispatcher-import.ts", new Set(), repoRoot);
    assert.ok(
      violations.every((v) => v.rule !== "connector-module-import"),
      `importing the shared, connector-agnostic dispatcher module must not be flagged, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability (final-redteam #2 counterweight): RI's own reference-implementation/connectors/seed/ deterministic fixture import is NOT flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const goodFile = join(dir, "synthetic-seed-fixture-import.ts");
    writeFileSync(
      goodFile,
      ['import { SUPPORTED_SEED_CONNECTOR_KEYS } from "../../connectors/seed/index.ts";', "", ""].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-seed-fixture-import.ts", new Set(), repoRoot);
    assert.ok(
      violations.every((v) => v.rule !== "connector-module-import"),
      `RI's own deterministic seed-fixture connector (not a third-party provider) must not be flagged, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ─── manual-upload-terminal-redteam-0810 finding #3: packages/polyfill-connectors/src/
// trusted-root scanner extension ────────────────────────────────────────────
//
// The red team's own live (uncommitted) probe: a SECOND file dropped in
// `packages/polyfill-connectors/src/` — the one root RI is allowed to import
// shared, connector-agnostic infrastructure from — that internally
// hardcodes a `kind === <manifest-declared kind>` branch or imports a
// connector's own module, but exports it under a generic name, was invisible
// to every existing rule: rule (6)/(7) only ever scanned RI's OWN files
// (`PRODUCTION_SCAN_ROOTS`), never the shared root those RI files import
// FROM. These tests plant that exact synthetic shape as a real file inside
// `packages/polyfill-connectors/src/` (removed in `finally`) and prove
// `scanSharedLibraryKindDispatchRoot` now catches it.

function withSyntheticSharedLibraryFile<T>(fileName: string, contents: string, run: (relPath: string) => T): T {
  const relPath = `packages/polyfill-connectors/src/${fileName}`;
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

test("falsifiability (terminal-redteam-0810 #3): a synthetic second generic-named helper in packages/polyfill-connectors/src/ with a hidden validation.kind branch is caught", () => {
  withSyntheticSharedLibraryFile(
    "synthetic-second-generic-dispatch-helper.ts",
    [
      "// Deliberately generic export name -- no 'connector' or 'kind' in the",
      "// identifier itself, mirroring the red team's exact evasion shape.",
      "export function process_upload(kind: string | null, bytes: Uint8Array): boolean {",
      '  if (kind === "whatsapp_chat_export") {',
      "    return bytes.length > 0;",
      "  }",
      "  return false;",
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanRepository({ repoRoot });
      const hit = violations.find((v) => v.file === relPath);
      assert.ok(
        hit && hit.rule === "hardcoded-validation-kind-literal",
        `scanner failed to detect a hidden validation.kind branch in a second, generically-named packages/polyfill-connectors/src/ helper -- the exact evasion the red team demonstrated live. Violations: ${JSON.stringify(violations)}`
      );
    }
  );
});

test("falsifiability (terminal-redteam-0810 #3): a synthetic second generic-named helper in packages/polyfill-connectors/src/ with a hidden connector-module import is caught", () => {
  withSyntheticSharedLibraryFile(
    "synthetic-second-generic-import-helper.ts",
    [
      'import { validateWhatsAppChatExportArtifactFromFile } from "../connectors/whatsapp/validation.ts";',
      "export function handle(fd: number, filePath: string, fileSize: number): unknown {",
      '  return validateWhatsAppChatExportArtifactFromFile(fd, filePath, fileSize, { fileName: "x", fileSha256: "y" });',
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const violations = scanRepository({ repoRoot });
      const hit = violations.find((v) => v.file === relPath && v.rule === "connector-module-import");
      assert.ok(
        hit,
        `scanner failed to detect a hidden connector-module import in a second, generically-named packages/polyfill-connectors/src/ helper. Violations: ${JSON.stringify(violations)}`
      );
    }
  );
});

test("falsifiability (terminal-redteam-0810 #3 counterweight): every real allowlisted registry/self-reference file is excluded from the scan's own file set and never appears in its violations", () => {
  // Four real, legitimate files -- not one. Auditing the actual tree (not
  // just the file this task set out to fix) surfaced collector-registry.ts
  // (a second, pre-existing connector-importing registry, same shape as
  // manual-upload-validation.ts but for the collector-definition pattern),
  // auto-login/heb.ts (imports only ITS OWN connector's sibling
  // parsers.ts -- self-referential, not cross-connector knowledge), and
  // provider-auth-adapters.ts (a deterministic, eagerly-loaded, opaque-
  // exchanger_kind registry reached via dynamic `import()` rather than a
  // static specifier -- the AST-authority pass (ast-authority-0810) is the
  // first version of this scanner to see dynamic-import call sites at all,
  // and this is the one real pre-existing file that shape newly surfaces).
  // Treating any of these as a violation would have been a false positive
  // on real, unrelated production code, not a fix.
  const allowlistedRelPaths = [
    "packages/polyfill-connectors/src/manual-upload-validation.ts",
    "packages/polyfill-connectors/src/collector-registry.ts",
    "packages/polyfill-connectors/src/auto-login/heb.ts",
    "packages/polyfill-connectors/src/provider-auth-adapters.ts",
  ];
  for (const relPath of allowlistedRelPaths) {
    assert.ok(existsSync(join(repoRoot, relPath)), `expected ${relPath} to exist as a real fixture`);
  }
  const files = sharedLibraryKindDispatchScanFiles({ repoRoot });
  for (const relPath of allowlistedRelPaths) {
    assert.ok(!files.includes(relPath), `${relPath} must be excluded from the shared-library scan's own file set`);
  }
  const violations = scanSharedLibraryKindDispatchRoot({ repoRoot });
  for (const relPath of allowlistedRelPaths) {
    assert.ok(
      violations.every((v) => v.file !== relPath),
      `${relPath} must never appear in shared-library scan violations, got: ${JSON.stringify(violations.filter((v) => v.file === relPath))}`
    );
  }
});

test("falsifiability (terminal-redteam-0810 #3 counterweight): packages/polyfill-connectors/src/'s legitimate connector-aware modules (orchestrator, auto-login, static-secret-injection) are NOT flagged by the narrow shared-library scan", () => {
  // These files are the shared/polyfill layer's WHOLE PURPOSE: they legitimately
  // hardcode every connector's identity, login URL, and credential env-var
  // name. Confirms the shared-library scan is scoped to rules (6)/(7) only
  // (never (1)/(3)/(4)) -- running the full rule set here would be ~100 false
  // positives on exactly the code this package exists to contain.
  const violations = scanSharedLibraryKindDispatchRoot({ repoRoot });
  const legitimateFiles = [
    "packages/polyfill-connectors/src/orchestrator.ts",
    "packages/polyfill-connectors/src/static-secret-injection.ts",
    "packages/polyfill-connectors/src/auto-login/usaa.ts",
  ];
  for (const relPath of legitimateFiles) {
    assert.ok(
      existsSync(join(repoRoot, relPath)),
      `expected ${relPath} to exist as a real fixture for this counterweight`
    );
  }
  assert.ok(
    violations.every((v) => !legitimateFiles.includes(v.file)),
    `legitimate connector-aware shared-library modules must not be flagged by the narrow (rules 6/7 only) scan, got: ${JSON.stringify(violations.filter((v) => legitimateFiles.includes(v.file)))}`
  );
});

test("falsifiability (terminal-redteam-0810 #3): scanSharedLibraryKindDispatchFile in isolation detects the same synthetic violation shape as the full-repo scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-falsifiability-"));
  try {
    const badFile = join(dir, "synthetic-isolated-check.ts");
    writeFileSync(
      badFile,
      ["export function dispatch(kind) {", '  return kind === "whatsapp_chat_export";', "}", ""].join("\n")
    );
    const violations = scanSharedLibraryKindDispatchFile(
      badFile,
      "packages/polyfill-connectors/src/synthetic-isolated-check.ts",
      new Set(["whatsapp_chat_export"]),
      repoRoot
    );
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-validation-kind-literal"),
      "scanSharedLibraryKindDispatchFile must detect the same violation shape as the full-repo scan"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("RI shared-library trust boundary (packages/polyfill-connectors/src/, excluding the allowlisted registry file) contains zero validation-kind branches or connector-module imports outside that registry", () => {
  const violations = scanSharedLibraryKindDispatchRoot({ repoRoot });
  assert.deepEqual(violations, [], formatViolationInventory(violations));
});

// ─── ri-zero-knowledge-ast-authority-0810: AST-based identity scan (rules
// (1)/(6)/(7), plus new rule (4b)) — mutation/evasion tests for ordinary
// indirection the prior regex scanner missed, plus legitimate counterweights
// that must stay green. Each test writes a synthetic fixture via `scanFile`
// directly (the same unit-level pattern the original falsifiability tests
// above use) so these are exercised in isolation, independent of whatever
// real production code happens to exist today. ──────────────────────────────

test("AST authority: a validation-kind literal assigned to a variable, then compared, is caught (value-flow bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-kind-var-indirection.ts");
    writeFileSync(
      badFile,
      [
        'const TARGET_KIND = "whatsapp_chat_export";',
        "export function isTargetKind(kind: string | null): boolean {",
        "  return kind === TARGET_KIND;",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(
      badFile,
      "synthetic-kind-var-indirection.ts",
      new Set(),
      repoRoot,
      new Set(["whatsapp_chat_export"])
    );
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-validation-kind-literal"),
      `a kind literal reached through one hop of const indirection must still be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: a connector-key array built as a const, then checked via .includes(), is caught (membership bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-includes-membership.ts");
    writeFileSync(
      badFile,
      [
        'const FIRST_PARTY_CONNECTORS = ["gmail", "slack"];',
        "export function isFirstParty(connectorId: string): boolean {",
        "  return FIRST_PARTY_CONNECTORS.includes(connectorId);",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-includes-membership.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `array-literal membership via .includes() must be caught even though there is no bare === next to an identity-shaped identifier, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: a connector-key Set checked via .has() is caught (Set-membership bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-has-membership.ts");
    writeFileSync(
      badFile,
      [
        'const KNOWN = new Set(["gmail", "slack"]);',
        "export function isKnown(id: string): boolean {",
        "  return KNOWN.has(id);",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-has-membership.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `Set-literal membership via .has() must be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: a switch statement dispatching on an aliased validation-kind value is caught (switch-case bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-switch-alias.ts");
    writeFileSync(
      badFile,
      [
        "export function dispatch(rawKind: string | null): string {",
        "  const kind = rawKind;",
        "  switch (kind) {",
        '    case "whatsapp_chat_export":',
        '      return "file-backed";',
        "    default:",
        '      return "unknown";',
        "  }",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(
      badFile,
      "synthetic-switch-alias.ts",
      new Set(),
      repoRoot,
      new Set(["whatsapp_chat_export"])
    );
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-validation-kind-literal"),
      `a switch case testing a manifest-derived kind value must be caught even though the regex scanner's old identity-context window never looked at switch cases, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: a template-literal identity string with no interpolation resolves exactly like a plain literal (template-composition bypass, static case)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-template-literal-identity.ts");
    writeFileSync(
      badFile,
      ["export function isGmail(connectorId: string): boolean {", "  return connectorId === `gmail`;", "}", ""].join(
        "\n"
      )
    );
    const violations = scanFile(
      badFile,
      "synthetic-template-literal-identity.ts",
      new Set(["gmail", "slack"]),
      repoRoot
    );
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `a backtick template with no interpolation is a plain string value and must be treated identically to a quoted literal, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: dynamic import() of a connector's own module is caught (dynamic-import bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-dynamic-import-connector.ts");
    writeFileSync(
      badFile,
      [
        "export async function loadWhatsAppValidator() {",
        '  return import("../../../packages/polyfill-connectors/connectors/whatsapp/validation.ts");',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-dynamic-import-connector.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "connector-module-import"),
      `a dynamic import() reaching a connector's own module must be caught the same as a static import, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: a require(...) reaching a connector's own module is caught (CommonJS-require bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-require-connector.ts");
    writeFileSync(
      badFile,
      [
        'const { validateWhatsAppChatExportArtifactFromFile } = require("../../../packages/polyfill-connectors/connectors/whatsapp/validation.ts");',
        "export { validateWhatsAppChatExportArtifactFromFile };",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-require-connector.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "connector-module-import"),
      `a CommonJS require(...) reaching a connector's own module must be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('AST authority: a re-export (`export { x } from "connector module"`) is caught (re-export bypass)', () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-reexport-connector.ts");
    writeFileSync(
      badFile,
      [
        'export { validateWhatsAppChatExportArtifactFromFile } from "../../../packages/polyfill-connectors/connectors/whatsapp/validation.ts";',
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-reexport-connector.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "connector-module-import"),
      `a barrel re-export of a connector's own module must be caught the same as a direct import, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('AST authority: a wildcard re-export (`export * from "connector module"`) is caught (re-export bypass)', () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const badFile = join(dir, "synthetic-wildcard-reexport-connector.ts");
    writeFileSync(
      badFile,
      ['export * from "../../../packages/polyfill-connectors/connectors/whatsapp/validation.ts";', ""].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-wildcard-reexport-connector.ts", new Set(), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "connector-module-import"),
      `a wildcard re-export (export * from) of a connector's own module must be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority: importing a connector manifest JSON directly and reading .setup.manual_or_upload.validation.kind off it is caught (manifest-import-then-extract bypass, rule 4b)", () => {
  withSyntheticProductionFile(
    "synthetic-manifest-import-extract-kind.ts",
    [
      'import whatsappManifest from "../manifests/whatsapp-manifest-import-probe.json" with { type: "json" };',
      "export function isWhatsAppKind(kind: string | null): boolean {",
      "  return kind === whatsappManifest.setup.manual_or_upload.validation.kind;",
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const fakeManifestPath = join(repoRoot, "reference-implementation/manifests/whatsapp-manifest-import-probe.json");
      writeFileSync(
        fakeManifestPath,
        JSON.stringify({
          connector_id: "synthetic-whatsapp-probe",
          setup: { manual_or_upload: { validation: { kind: "whatsapp_chat_export" } } },
        })
      );
      try {
        const violations = scanFile(join(repoRoot, relPath), relPath, new Set(), repoRoot, new Set());
        assert.ok(
          violations.some((v) => v.rule === "hardcoded-connector-manifest-import"),
          `importing a connector manifest JSON directly and reading its .kind field must be caught as the same knowledge rule (6) forbids, reached via a different seam, got: ${JSON.stringify(violations)}`
        );
      } finally {
        rmSync(fakeManifestPath, { force: true });
      }
    }
  );
});

test("AST authority: importing a connector manifest JSON and reading .connector_key off it is caught (manifest-import-then-extract bypass, rule 4b)", () => {
  withSyntheticProductionFile(
    "synthetic-manifest-import-extract-connector-key.ts",
    [
      'import gmailManifest from "../manifests/gmail-manifest-import-probe.json" with { type: "json" };',
      "export function isGmail(): string {",
      "  return gmailManifest.connector_key;",
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const fakeManifestPath = join(repoRoot, "reference-implementation/manifests/gmail-manifest-import-probe.json");
      writeFileSync(
        fakeManifestPath,
        JSON.stringify({ connector_id: "synthetic-gmail-probe", connector_key: "gmail" })
      );
      try {
        const violations = scanFile(join(repoRoot, relPath), relPath, new Set(), repoRoot, new Set());
        assert.ok(
          violations.some((v) => v.rule === "hardcoded-connector-manifest-import"),
          `importing a connector manifest and reading .connector_key off it must be caught, got: ${JSON.stringify(violations)}`
        );
      } finally {
        rmSync(fakeManifestPath, { force: true });
      }
    }
  );
});

// --- Terminal invariant (ri-zero-knowledge-terminal-revise-0810): every
// literal-bearing AST position, not an enumerated list of consumption
// shapes -------------------------------------------------------------------

test("terminal invariant: an object-literal VALUE equal to a connector key is caught, with no comparison or membership call anywhere in the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-object-value-dispatch.ts");
    writeFileSync(
      badFile,
      [
        "export const DEFAULT_CONNECTOR_FOR_TEST_FIXTURE: Record<string, string> = {",
        '  canonicalId: "gmail",',
        "};",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-object-value-dispatch.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `an object-literal VALUE equal to a connector key must be caught even with zero comparison/membership shapes in the file, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: an object-literal KEY equal to a validation kind is caught when the object is used as a bracket-lookup dispatch table", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-object-key-dispatch.ts");
    writeFileSync(
      badFile,
      [
        "const PARSERS: Record<string, (buf: Buffer) => string> = {",
        "  whatsapp_chat_export: (buf) => buf.toString(),",
        "};",
        "export function parse(kind: string, buf: Buffer): string | null {",
        "  const fn = PARSERS[kind];",
        "  return fn ? fn(buf) : null;",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(
      badFile,
      "synthetic-object-key-dispatch.ts",
      new Set(),
      repoRoot,
      new Set(["whatsapp_chat_export"])
    );
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-validation-kind-literal"),
      `an object-literal KEY equal to a validation kind, on a table proven bracket-accessed, must be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: an object-literal KEY dispatch table wrapped in Object.freeze(...) is still caught (this codebase's own idiom)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-frozen-key-dispatch.ts");
    writeFileSync(
      badFile,
      [
        "const PROFILES: Readonly<Record<string, number>> = Object.freeze({",
        "  gmail: 8,",
        "});",
        "export function resolve(connectorId: string): number {",
        "  return PROFILES[connectorId] ?? 12;",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-frozen-key-dispatch.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `an Object.freeze(...)-wrapped dispatch table's key must still be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: an array-literal element equal to a connector key is caught even when the array is never queried", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-unused-array-literal.ts");
    writeFileSync(badFile, ['export const KNOWN_CONNECTORS = ["gmail", "slack"];', ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-unused-array-literal.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `an array literal containing a connector key must be caught even if never checked against anything, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: a let-bound variable initialized to a connector-key literal is caught, independent of any later use", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-let-declaration.ts");
    writeFileSync(
      badFile,
      ["export function pick(): string {", '  let canonicalKey = "gmail";', "  return canonicalKey;", "}", ""].join(
        "\n"
      )
    );
    const violations = scanFile(badFile, "synthetic-let-declaration.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `a let declaration initialized to a connector-key literal must itself be the violation site, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: a const declaration initialized to a connector-key literal is caught even if never read", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-unused-const.ts");
    writeFileSync(badFile, ['const UNUSED_CANONICAL_KEY = "gmail";', "export {};", ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-unused-const.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `an unread const initialized to a connector-key literal must be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: a destructured property KEY equal to a connector key is caught (destructuring-source-literal bypass)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-destructuring-key.ts");
    writeFileSync(
      badFile,
      [
        "export function extractGmailHandler(registry: Record<string, () => void>): (() => void) | undefined {",
        "  const { gmail: handler } = registry;",
        "  return handler;",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-destructuring-key.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `a destructured property key equal to a connector key must be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: bounded string-concatenation folding resolves a split connector-key literal (const + const)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-concat-folding.ts");
    writeFileSync(
      badFile,
      [
        'const PART_ONE = "gm";',
        'const PART_TWO = "ail";',
        "export function isGmail(connectorId: string): boolean {",
        "  return connectorId === PART_ONE + PART_TWO;",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-concat-folding.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `"gm" + "ail" must fold to "gmail" and be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant: bounded string-concatenation folding resolves inline literal concatenation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-concat-inline.ts");
    writeFileSync(
      badFile,
      [
        "export function isGmail(connectorId: string): boolean {",
        '  return connectorId === "gm" + "ail";',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-concat-inline.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `inline "gm" + "ail" must fold to "gmail" and be caught, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// --- Counterweights: legitimate code the AST authority must NOT flag -------

test('terminal invariant counterweight: an object-literal key that is a generic vocabulary collision ("meta") is not flagged, even on a bracket-accessed dispatch table', () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-meta-envelope-key.ts");
    writeFileSync(
      badFile,
      [
        "interface Acc { meta: { warnings: string[] } | null }",
        "export function buildEnvelope(acc: Acc) {",
        "  const { meta } = acc;",
        "  return { data: [], meta };",
        "}",
        "export function lookup(table: Record<string, unknown>, key: string) {",
        "  return table[key];",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-meta-envelope-key.ts", new Set(["meta"]), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `"meta" used as a generic JSON-envelope field/destructuring key must not be flagged (reviewed vocabulary collision), got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant counterweight: an object-literal key equal to a connector key is NOT flagged when the object is never used as a lookup table (record, not dispatch)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-record-not-dispatch.ts");
    writeFileSync(
      badFile,
      [
        "// `gmail` here is an ordinary object property NAME on a one-off record,",
        "// never looked up by a runtime key -- not a connector-identity dispatch table.",
        "export const EXAMPLE_PAYLOAD_SHAPE = { gmail: { threads: 3 } };",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-record-not-dispatch.ts", new Set(["gmail"]), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `an object key equal to a connector key must not be flagged unless the object is proven used as a dispatch table, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant counterweight: a computed object-property key is not flagged (runtime expression, not a literal position)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-computed-key.ts");
    writeFileSync(
      badFile,
      [
        "export function build(dynamicKey: string, value: unknown): Record<string, unknown> {",
        "  return { [dynamicKey]: value };",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-computed-key.ts", new Set(["gmail"]), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `a computed property key is a runtime expression, not a literal position, and must not be flagged, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("terminal invariant counterweight: string concatenation with a non-literal operand is unresolvable and not flagged (disclosed residual)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-terminal-"));
  try {
    const badFile = join(dir, "synthetic-concat-with-runtime-value.ts");
    writeFileSync(
      badFile,
      ["export function suffix(runtimeSuffix: string): string {", '  return "gm" + runtimeSuffix;', "}", ""].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-concat-with-runtime-value.ts", new Set(["gmail"]), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `"gm" concatenated with an unresolvable runtime value must not fold to "gmail" or falsely flag "gm" alone, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority counterweight: an unrelated switch discriminator (not a manifest-derived kind) is not flagged, even with a variable alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const goodFile = join(dir, "synthetic-unrelated-switch-alias.ts");
    writeFileSync(
      goodFile,
      [
        "export function classify(rawGranularity: string): string {",
        "  const granularity = rawGranularity;",
        "  switch (granularity) {",
        '    case "daily":',
        '      return "day";',
        '    case "weekly":',
        '      return "week";',
        "    default:",
        '      return "unknown";',
        "  }",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(
      goodFile,
      "synthetic-unrelated-switch-alias.ts",
      new Set(),
      repoRoot,
      new Set(["whatsapp_chat_export"])
    );
    assert.deepEqual(
      violations,
      [],
      `an unrelated switch discriminator whose case literals are not manifest-derived kinds must not be flagged just because the value flows through a variable, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority counterweight: .includes()/.has() on an array/Set of NON-connector strings is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const goodFile = join(dir, "synthetic-unrelated-membership.ts");
    writeFileSync(
      goodFile,
      [
        'const ALLOWED_STATUSES = ["pending", "complete", "failed"];',
        'const ALLOWED_ROLES = new Set(["owner", "viewer"]);',
        "export function isAllowedStatus(status: string): boolean {",
        "  return ALLOWED_STATUSES.includes(status) || ALLOWED_ROLES.has(status);",
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-unrelated-membership.ts", new Set(["gmail", "slack"]), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `membership checks whose collection literal contains no manifest-derived connector key must not be flagged, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority counterweight: re-exporting the shared connector-agnostic dispatcher module is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const goodFile = join(dir, "synthetic-reexport-shared-dispatcher.ts");
    writeFileSync(
      goodFile,
      [
        'export { validateManualUploadArtifactFromFileByKind } from "../../../packages/polyfill-connectors/src/manual-upload-validation.ts";',
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-reexport-shared-dispatcher.ts", new Set(), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `re-exporting the shared, connector-agnostic dispatcher module must not be flagged, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority counterweight: a dynamic import() whose specifier cannot be statically resolved (runtime-interpolated) is not flagged (disclosed residual, not a silent pass of a proven violation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-ast-authority-"));
  try {
    const goodFile = join(dir, "synthetic-unresolvable-dynamic-import.ts");
    writeFileSync(
      goodFile,
      [
        "export async function loadPlugin(pluginName: string) {",
        `  return import(\`./plugins/${DOLLAR}{pluginName}.ts\`);`,
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-unresolvable-dynamic-import.ts", new Set(), repoRoot);
    assert.ok(
      violations.every((v) => v.rule !== "connector-module-import"),
      `a genuinely runtime-interpolated import specifier that cannot be proven to reach a connector module must not be flagged as connector-module-import (it is never proven to be one) — this is the module's disclosed residual, not a bypass, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("AST authority counterweight: importing a manifest for a legitimate generic purpose (reading display_name, not identity/kind) is not flagged", () => {
  withSyntheticProductionFile(
    "synthetic-manifest-import-generic-read.ts",
    [
      'import connectorManifest from "../manifests/generic-display-name-probe.json" with { type: "json" };',
      "export function displayName(): string {",
      "  return connectorManifest.display_name;",
      "}",
      "",
    ].join("\n"),
    (relPath) => {
      const fakeManifestPath = join(repoRoot, "reference-implementation/manifests/generic-display-name-probe.json");
      writeFileSync(
        fakeManifestPath,
        JSON.stringify({ connector_id: "synthetic-generic-probe", display_name: "Synthetic Probe" })
      );
      try {
        const violations = scanFile(join(repoRoot, relPath), relPath, new Set(), repoRoot, new Set());
        assert.ok(
          violations.every((v) => v.rule !== "hardcoded-connector-manifest-import"),
          `reading a non-identity/kind field (display_name) off an imported manifest must not be flagged — rule (4b) is scoped to connector_key/connector_id/kind extraction specifically, got: ${JSON.stringify(violations)}`
        );
      } finally {
        rmSync(fakeManifestPath, { force: true });
      }
    }
  );
});

test("AST authority counterweight: the allowlisted provider-auth-adapters.ts dynamic-import registry is not flagged by the shared-library scan", () => {
  const violations = scanSharedLibraryKindDispatchRoot({ repoRoot });
  assert.ok(
    violations.every((v) => v.file !== "packages/polyfill-connectors/src/provider-auth-adapters.ts"),
    `the real, legitimate provider-auth-adapters.ts dynamic-import registry (allowlisted after being newly discovered by this AST pass) must not appear in violations, got: ${JSON.stringify(violations.filter((v) => v.file === "packages/polyfill-connectors/src/provider-auth-adapters.ts"))}`
  );
});

// --- Universal revise (ri-zero-knowledge-universal-revise-0810): every node
// is a candidate position, not an enumerated shape list. Table-driven so
// each attack from the independent gate report is a single explicit row. ---

const UNIVERSAL_POSITION_ATTACKS: Array<{ name: string; fileName: string; source: string }> = [
  {
    fileName: "attack-call-argument.ts",
    name: 'call-argument position (scheduleConnectorPoll("gmail"))',
    source: ["function scheduleConnectorPoll(connectorKey: string) {}", 'scheduleConnectorPoll("gmail");', ""].join(
      "\n"
    ),
  },
  {
    fileName: "attack-bare-call-argument.ts",
    name: 'bare call argument to an arbitrary function (logger-shaped: doSomething("gmail"))',
    source: ['doSomething("gmail");', ""].join("\n"),
  },
  {
    fileName: "attack-computed-member-read.ts",
    name: 'computed member-expression read off a registry (CONNECTOR_HANDLERS["gmail"])',
    source: ['const handler = CONNECTOR_HANDLERS["gmail"];', "handler.run();", ""].join("\n"),
  },
  {
    fileName: "attack-return-statement.ts",
    name: 'return statement argument (return "gmail")',
    source: ["function getProvider(): string {", '  return "gmail";', "}", ""].join("\n"),
  },
  {
    fileName: "attack-class-static-field.ts",
    name: 'class static field (static provider = "gmail")',
    source: ["class Foo {", '  static provider = "gmail";', "}", "export { Foo };", ""].join("\n"),
  },
  {
    fileName: "attack-ts-enum.ts",
    name: 'TS enum member initializer (enum Providers { Gmail = "gmail" })',
    source: ["export enum Providers {", '  Gmail = "gmail",', "}", ""].join("\n"),
  },
  {
    fileName: "attack-default-parameter.ts",
    name: 'default parameter value ((provider = "gmail") => provider)',
    source: ['export const f = (provider = "gmail") => provider;', ""].join("\n"),
  },
  {
    fileName: "attack-tagged-template.ts",
    name: "tagged template literal (sql`...gmail...`)",
    source: ["declare function sql(strings: TemplateStringsArray): string;", "sql`gmail`;", ""].join("\n"),
  },
];

for (const attack of UNIVERSAL_POSITION_ATTACKS) {
  test(`universal revise attack: ${attack.name} is caught`, () => {
    const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-universal-"));
    try {
      const badFile = join(dir, attack.fileName);
      writeFileSync(badFile, attack.source);
      const violations = scanFile(badFile, attack.fileName, new Set(["gmail", "slack"]), repoRoot);
      assert.ok(
        violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
        `${attack.name} must be caught by the universal per-node walk, got: ${JSON.stringify(violations)}`
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
}

test("universal revise counterweight: an object-literal KEY that collides with the generic vocabulary is not flagged, but the SAME name used as a VALUE elsewhere in the same object is still flagged (values are never exempt)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-universal-"));
  try {
    const badFile = join(dir, "synthetic-meta-key-vs-value.ts");
    writeFileSync(
      badFile,
      [
        "export function buildEnvelope(acc: { meta: unknown }) {",
        "  const { meta } = acc;",
        '  return { data: [], meta, canonicalId: "meta" };',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-meta-key-vs-value.ts", new Set(["meta"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `a VALUE equal to "meta" must still be flagged even though the KEY-position collision carve-out exists, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('universal revise counterweight: a string-literal "x in obj" membership check against an unknown registry is NOT exempted, even for a generic-collision name (membership is a dynamic identity check, not a key declaration)', () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-universal-"));
  try {
    const badFile = join(dir, "synthetic-in-membership-dispatch.ts");
    writeFileSync(
      badFile,
      [
        "export function hasHandler(registry: Record<string, unknown>): boolean {",
        '  return "gmail" in registry;',
        "}",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-in-membership-dispatch.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `"gmail" in registry must be caught as an ordinary value position -- "in" membership checks get no carve-out, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('universal revise counterweight: a generic-collision name used in an "x in obj" membership check is ALSO still flagged (no blanket exemption for that expression position)', () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-universal-"));
  try {
    const badFile = join(dir, "synthetic-meta-in-membership.ts");
    writeFileSync(
      badFile,
      ["export function hasMeta(obj: Record<string, unknown>): boolean {", '  return "meta" in obj;', "}", ""].join(
        "\n"
      )
    );
    const violations = scanFile(badFile, "synthetic-meta-in-membership.ts", new Set(["meta"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `"meta" in obj must still be caught -- the key-collision carve-out is scoped to literal key DECLARATIONS only, never membership checks, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ─── ri-parse-closure-0810: fail-open parse-error closure ───────────────────
//
// `scanFileIdentity`'s parser previously had two independent gaps that both
// resolved to the same silent "report nothing" outcome: (a) the standard
// `decorators` Babel plugin was never enabled, so any real, valid (erasable,
// per this repo's `tsconfig.json`) decorator syntax threw a parse error, and
// (b) that parse error — for ANY cause, not just decorators — was swallowed
// by a bare `catch { return []; }`, certifying an unparseable production file
// as carrying zero connector knowledge rather than flagging it. These tests
// prove both: a decorator argument carrying real connector identity is now
// parsed and caught (closing gap (a) as a prerequisite), a genuinely
// malformed file now emits a typed `unparseable-production-file` violation
// instead of silently passing (closing gap (b)), and a generic decorator
// with no connector identity stays clean (counterweight: enabling the
// `decorators` plugin must not itself start flagging ordinary code).

test("parse closure: a decorator argument carrying a connector-identity literal is caught", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-parse-closure-"));
  try {
    const badFile = join(dir, "synthetic-decorator-identity.ts");
    writeFileSync(
      badFile,
      [
        "class ConnectorRegistration {",
        '  @Register("gmail")',
        "  static configure(): void {}",
        "}",
        "export { ConnectorRegistration };",
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-decorator-identity.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "hardcoded-connector-identity-literal"),
      `a connector-identity literal inside a decorator call argument must be caught -- if this fails with zero violations, the file failed to parse at all (the decorators plugin isn't enabled) and was silently swallowed rather than genuinely scanned, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("parse closure counterweight: valid generic decorator syntax with no connector identity is not flagged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-parse-closure-"));
  try {
    const goodFile = join(dir, "synthetic-decorator-generic.ts");
    writeFileSync(
      goodFile,
      [
        "function Logged(target: unknown, propertyKey: string): void {",
        "  // generic, manifest-agnostic decorator -- no connector/provider knowledge",
        "}",
        "class RecordProcessor {",
        "  @Logged",
        "  process(): void {}",
        "}",
        "export { RecordProcessor };",
        "",
      ].join("\n")
    );
    const violations = scanFile(goodFile, "synthetic-decorator-generic.ts", new Set(["gmail"]), repoRoot);
    assert.deepEqual(
      violations,
      [],
      `valid decorator syntax carrying no connector identity must parse cleanly and produce zero violations, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("parse closure: a malformed production file emits a typed parse-failure violation instead of silently passing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-parse-closure-"));
  try {
    const badFile = join(dir, "synthetic-malformed.ts");
    // Genuinely unparseable: an unclosed brace with no valid recovery.
    writeFileSync(badFile, ["export function broken(kind: string) {", "  if (kind === {{{", ""].join("\n"));
    const violations = scanFile(badFile, "synthetic-malformed.ts", new Set(["gmail"]), repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "unparseable-production-file" && v.file === "synthetic-malformed.ts"),
      `a file this scanner cannot parse must emit a typed unparseable-production-file violation (with file/location/reason), never silently pass with zero findings, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// ─── ri-parse-all-0810: close the remaining zero-knowledge parse fail-open ──
//
// The identity scanner (rules 1/6/7/4b) was fixed above to fail closed on a
// parse error. Rule (5)'s data-load scanner (`scanFileDataLoads`) had its
// own, independent `catch { return []; }` — the exact same fail-open shape,
// on a DIFFERENT scanner entirely: a malformed or unsupported-syntax
// production file containing a hidden `readFileSync`/`require`/dynamic
// `import()` sibling-JSON data load would silently pass rule (5) even though
// rule (1)/(6)/(7)/(4b) now correctly flag the same file as unparseable.
// Both scanners now report the identical typed `unparseable-production-file`
// violation through the one shared `parseFailureViolation` contract in
// `ri-zero-connector-knowledge-ast-shared.ts`, so there is no second,
// independently-drifting parse-error shape. These tests prove: (a) the
// data-load scanner alone no longer returns clean on a malformed file that
// hides a real connector-identity-carrying data load, and (b) the composer
// (`scanFile`, which runs both AST scanners over the same file) reports the
// resulting duplicate parse failure as exactly ONE actionable violation, not
// two — a human fixing the file should see one entry, not one per scanner.

test("parse closure (rule 5): a malformed production file hiding a connector data load cannot return clean from the data-load scanner alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-parse-closure-dataload-"));
  try {
    const badFile = join(dir, "synthetic-malformed-data-load.ts");
    // Genuinely unparseable (unclosed brace, no valid recovery) AND, if it
    // had parsed, would carry a real rule-5 violation: a readFileSync call
    // reaching an unsanctioned sibling JSON path. Proves the scanner cannot
    // parse far enough to see the call at all -- if this returned `[]`, a
    // production file could hide arbitrary connector-identity data loads
    // behind any syntax the parser rejects.
    writeFileSync(
      badFile,
      [
        "export function loadHiddenPolicy() {",
        '  const raw = readFileSync("../connectors/gmail/policy.json", "utf8");',
        "  if (raw === {{{",
        "",
      ].join("\n")
    );
    const violations = scanFileDataLoads(badFile, "synthetic-malformed-data-load.ts", repoRoot);
    assert.ok(
      violations.some((v) => v.rule === "unparseable-production-file" && v.file === "synthetic-malformed-data-load.ts"),
      `scanFileDataLoads must fail closed on a parse error instead of returning [] -- a malformed file cannot be proven free of a hidden connector data load, got: ${JSON.stringify(violations)}`
    );
    assert.notDeepEqual(
      violations,
      [],
      "a malformed file containing a hidden connector-identity data load must never resolve to a clean (empty) rule-5 scan"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("parse closure: a malformed production file reports exactly ONE actionable parse-failure violation, not one per AST scanner", () => {
  const dir = mkdtempSync(join(tmpdir(), "ri-zero-knowledge-parse-closure-dedup-"));
  try {
    const badFile = join(dir, "synthetic-malformed-dedup.ts");
    writeFileSync(
      badFile,
      [
        "export function loadHiddenPolicy(kind: string) {",
        '  const raw = readFileSync("../connectors/gmail/policy.json", "utf8");',
        '  return kind === "gmail" && raw === {{{',
        "",
      ].join("\n")
    );
    const violations = scanFile(badFile, "synthetic-malformed-dedup.ts", new Set(["gmail"]), repoRoot);
    const parseFailures = violations.filter((v) => v.rule === "unparseable-production-file");
    assert.equal(
      parseFailures.length,
      1,
      `both the identity scanner (rules 1/6/7/4b) and the data-load scanner (rule 5) independently fail closed on the same parse error for this file; scanFile must collapse them to one actionable violation, not double-report the same unparseable file once per scanner, got: ${JSON.stringify(violations)}`
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("RI production code still contains zero connector/provider-specific executable knowledge after the universal per-node rewrite (regression, not just the synthetic attacks above)", () => {
  const violations = scanRepository({ repoRoot });
  assert.deepEqual(violations, [], formatViolationInventory(violations));
});
