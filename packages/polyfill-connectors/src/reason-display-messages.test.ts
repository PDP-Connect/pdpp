// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Registry completeness: every connector-emitted reason code has a vetted
 * end-user display message, either declared in THAT SAME connector's OWN
 * manifest (`reason_display_messages`, read per-connector by
 * `connectorReasonDisplayMessages` in this file's sibling module) or covered
 * by the reference implementation's small, closed set of RI-normalized
 * generic recovery codes (`RUNTIME_GENERIC_REASON_CODES` in
 * `reference-implementation/runtime/display-messages.ts`, imported here by
 * relative path — the connector package has no build/runtime dependency on
 * `pdpp-reference-implementation`; this is a test-only cross-reference,
 * mirroring how several `reference-implementation/test/*.ts` files already
 * reach into this package's `src/` the same way). Lookup is scoped by
 * connector: two connectors emitting the same literal reason code are
 * independent facts, each checked against its OWN manifest declaration —
 * connector A's copy for `selector_drift` never counts toward connector B's
 * completeness.
 *
 * This is the completeness authority for the whole reason-code/display-copy
 * contract — it lives HERE, in the connector package, because "does every
 * connector-emitted reason have vetted copy" is fundamentally a question
 * about connector-owned facts, and the reference implementation must not
 * hold connector-specific display copy or drive this scan itself (the
 * zero-connector-knowledge conformance guard, enforced on
 * `reference-implementation`'s production code, is why).
 *
 * The scan (`reason-emission-scan.ts`) is AST-based and whole-connector-directory
 * scoped, not index.ts-only: see that module's doc comment for the real gap
 * this closed (a helper module's SKIP_RESULT reason composed via a template
 * literal was invisible to the prior index.ts-only regex scan — nine live
 * USAA `pdf_download_*` codes were uncovered until that connector was
 * refactored to an explicit literal-per-branch map). A `reason:` value that
 * cannot be statically resolved to a finite literal set FAILS the gate —
 * fail-closed, not silently skipped.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RUNTIME_GENERIC_REASON_CODES } from "../../../reference-implementation/runtime/display-messages.ts";
import { connectorReasonDisplayMessages } from "./reason-display-messages.ts";
import { scanConnectorForReasonEmissions } from "./reason-emission-scan.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

const REGISTRY_URL_PREFIX = "https://registry.pdpp.org/connectors/";

/**
 * A connector's directory name (e.g. `apple_health`) is not always its
 * manifest's `connector_key` (e.g. `apple-health` — the directory name is a
 * filesystem/import-path convention, the manifest's `connector_key` is the
 * canonical public identifier `connectorReasonDisplayMessages()` is keyed
 * by). The manifest filename matches the directory name 1:1, so this reads
 * `manifests/<dirname>.json` to derive the real key rather than assuming
 * they're identical strings.
 */
function manifestKeyForDirName(dirName: string): string {
  const manifestPath = join(MANIFESTS_DIR, `${dirName}.json`);
  if (!existsSync(manifestPath)) {
    return dirName;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    connector_key?: unknown;
    connector_id?: unknown;
  };
  if (typeof manifest.connector_key === "string" && manifest.connector_key.trim()) {
    return manifest.connector_key.trim();
  }
  if (typeof manifest.connector_id === "string" && manifest.connector_id.startsWith(REGISTRY_URL_PREFIX)) {
    return manifest.connector_id.slice(REGISTRY_URL_PREFIX.length);
  }
  return dirName;
}

function listConnectorDirs(): { key: string; dir: string }[] {
  const entries = readdirSync(CONNECTORS_DIR);
  const dirs: { key: string; dir: string }[] = [];
  for (const name of entries) {
    const full = join(CONNECTORS_DIR, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      dirs.push({ key: manifestKeyForDirName(name), dir: full });
    }
  }
  return dirs;
}

test("connector manifests' own reason_display_messages read cleanly per connector (sanity check on the derivation)", () => {
  const byConnector = connectorReasonDisplayMessages();
  const connectorsWithMessages = Object.keys(byConnector);
  assert.ok(
    connectorsWithMessages.length > 0,
    "expected at least one connector manifest to declare reason_display_messages"
  );
});

test("no connector manifest declares an RI-reserved generic reason code in its own reason_display_messages", () => {
  const byConnector = connectorReasonDisplayMessages();
  const collisions: string[] = [];
  for (const [connectorKey, messages] of Object.entries(byConnector)) {
    for (const code of Object.keys(messages)) {
      if (RUNTIME_GENERIC_REASON_CODES.has(code)) {
        collisions.push(`${connectorKey}: ${code}`);
      }
    }
  }
  assert.deepEqual(
    collisions,
    [],
    `connector manifest(s) declared RI-reserved generic reason code(s): ${collisions.join(", ")} — ` +
      "these are normalized recovery-classification concepts the runtime already owns " +
      "(see RUNTIME_GENERIC_REASON_CODES in reference-implementation/runtime/display-messages.ts); " +
      "a manifest must not redeclare them."
  );
});

test("every connector-emitted reason code has a registered display message (that connector's own manifest, OR RI-generic)", () => {
  const dirs = listConnectorDirs();
  assert.ok(dirs.length > 0, "expected at least one connector directory");

  const byConnector = connectorReasonDisplayMessages();
  const missing: { connector: string; reason: string }[] = [];
  const unresolvedByConnector: { connector: string; file: string; line: number; snippet: string }[] = [];

  for (const { key, dir } of dirs) {
    const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
    for (const { file, line, snippet } of unresolved) {
      unresolvedByConnector.push({ connector: key, file, line, snippet });
    }
    const messages = byConnector[key] ?? {};
    for (const reason of literalReasons) {
      if (!(reason in messages || RUNTIME_GENERIC_REASON_CODES.has(reason))) {
        missing.push({ connector: key, reason });
      }
    }
  }

  if (unresolvedByConnector.length > 0) {
    const lines = unresolvedByConnector
      .map(({ connector, file, line, snippet }) => `  ${connector} (${file}:${line}): ${snippet}`)
      .join("\n");
    assert.fail(
      `reason: value(s) that could not be statically resolved to a finite literal set:\n${lines}\n\n` +
        "Refactor to an explicit literal-per-branch mapping (see usaa/index.ts's PDF_DOWNLOAD_SKIP_REASON " +
        "for the pattern) so every emitted reason code is a plain string literal or all-literal ternary."
    );
  }

  if (missing.length > 0) {
    const lines = missing.map(({ connector, reason }) => `  ${connector}: ${reason}`).join("\n");
    assert.fail(
      `Reason codes emitted by connectors but missing a vetted display message:\n${lines}\n\n` +
        "Add an entry to that connector's own manifest's reason_display_messages field " +
        "(packages/polyfill-connectors/manifests/<connector>.json)."
    );
  }
});

test("falsifiability: a shipped connector emitting a reason code absent from its OWN manifest is caught, not silently passed by another connector's coverage", () => {
  // Exercises the exact completeness-check shape the real test above uses
  // (scan a connector dir, look up ITS OWN manifest entry, fall back to
  // RUNTIME_GENERIC_REASON_CODES) against a synthetic connector whose
  // manifest declares unrelated codes only. Proves the gate is scoped
  // per-connector — a sibling connector's manifest declaring the same
  // literal code must NOT count toward this connector's completeness.
  withSyntheticConnectorFile(
    "index.ts",
    [
      "function emitSkip() {",
      "  return { type: 'SKIP_RESULT', reason: 'undeclared_synthetic_reason' };",
      "}",
      "export { emitSkip };",
      "",
    ].join("\n"),
    (dir) => {
      const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
      assert.deepEqual(unresolved, []);
      const declaredByThisConnector: Record<string, string> = { some_other_reason: "Unrelated vetted copy" };
      const declaredBySiblingConnector: Record<string, string> = {
        undeclared_synthetic_reason: "A sibling connector's copy for the SAME literal code",
      };
      const missing = literalReasons.filter(
        (reason) => !(reason in declaredByThisConnector || RUNTIME_GENERIC_REASON_CODES.has(reason))
      );
      assert.deepEqual(
        missing,
        ["undeclared_synthetic_reason"],
        "a reason code emitted by this connector but declared only in a DIFFERENT connector's manifest must still be reported missing"
      );
      assert.ok(
        "undeclared_synthetic_reason" in declaredBySiblingConnector,
        "sanity: the sibling connector's declaration exists but is deliberately never consulted for this connector's completeness"
      );
    }
  );
});

// ─── Falsifiability: the scan must actually catch what it claims to ────────

function withSyntheticConnectorFile<T>(fileName: string, contents: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "reason-emission-scan-falsifiability-"));
  try {
    const filePath = join(dir, fileName);
    writeFileSync(filePath, contents);
    return run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function withSyntheticConnectorFiles<T>(files: Record<string, string>, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "reason-emission-scan-falsifiability-"));
  try {
    for (const [fileName, contents] of Object.entries(files)) {
      writeFileSync(join(dir, fileName), contents);
    }
    return run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("falsifiability: a literal reason: emission in a NON-index.ts helper file is caught (the real USAA gap)", () => {
  // The real gap: a helper module (statement-pdfs.ts, not index.ts) is a
  // production file that can itself contain a SKIP_RESULT-shaped emission
  // literal — an index.ts-only file scope would never see it.
  withSyntheticConnectorFiles(
    {
      "some-helper.ts": [
        "export function emitFromHelper() {",
        "  return { type: 'SKIP_RESULT', reason: 'helper_specific_failure' };",
        "}",
        "",
      ].join("\n"),
      "index.ts": ["export const unrelated = 1;", ""].join("\n"),
    },
    (dir) => {
      const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
      assert.deepEqual(unresolved, []);
      assert.ok(
        literalReasons.includes("helper_specific_failure"),
        "a SKIP_RESULT-shaped reason: literal in a sibling helper file (not index.ts) must be discovered by a whole-directory scan"
      );
    }
  );
});

test("falsifiability: a reason: reached via member access on a same-file classifier function's return value resolves (the real Amazon/H-E-B/Netflix pattern)", () => {
  // Mirrors classifyEmptyListPageDiagnostics (amazon), classifyEmptyListPage
  // (heb), and classifyBySchema (netflix_export): a same-file function
  // returns `{ reason: <literal> }` in some branches and a reason-less
  // shape in others; the emission site reads `.reason` off the call
  // result via a `const` initializer, optionally through a ternary of two
  // such calls.
  withSyntheticConnectorFile(
    "index.ts",
    [
      "function classify(ok: boolean): { ok: true } | { ok: false; reason: string } {",
      "  if (ok) {",
      "    return { ok: true };",
      "  }",
      "  return { ok: false, reason: 'classifier_specific_failure' };",
      "}",
      "function emitSkip(ok: boolean) {",
      "  const outcome = classify(ok);",
      "  return { type: 'SKIP_RESULT', reason: outcome.reason };",
      "}",
      "export { emitSkip };",
      "",
    ].join("\n"),
    (dir) => {
      const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
      assert.deepEqual(unresolved, []);
      assert.ok(
        literalReasons.includes("classifier_specific_failure"),
        "a reason reached via member access on a same-file classifier function's return value must resolve"
      );
    }
  );
});

test("falsifiability: an imported (cross-file) classifier's .reason member correctly fails closed, not silently resolved", () => {
  // The one-hop bound is same-FILE only, by design — resolving across an
  // import would require following module resolution, a different and
  // larger scope than "one hop within this file". A cross-file case must
  // report unresolved, not silently pass or crash.
  withSyntheticConnectorFiles(
    {
      "some-helper.ts": [
        "export function classify(): { ok: false; reason: string } {",
        "  return { ok: false, reason: 'helper_specific_failure' };",
        "}",
        "",
      ].join("\n"),
      "index.ts": [
        "import { classify } from './some-helper.ts';",
        "function emitSkip() {",
        "  const outcome = classify();",
        "  return { type: 'SKIP_RESULT', reason: outcome.reason };",
        "}",
        "export { emitSkip };",
        "",
      ].join("\n"),
    },
    (dir) => {
      const { unresolved } = scanConnectorForReasonEmissions(dir);
      assert.equal(unresolved.length, 1, "a cross-file member-access resolution must fail closed, not silently pass");
    }
  );
});

test("falsifiability: a template-literal-composed reason: is reported as unresolved, not silently dropped or guessed", () => {
  withSyntheticConnectorFile(
    "index.ts",
    [
      "function emitSkip(reason: string) {",
      "  return {",
      "    type: 'SKIP_RESULT',",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this string IS the synthetic fixture's source text — it must stay a plain string, not become a real template literal, which would defeat the fixture.
      "    reason: `pdf_download_${reason}`,",
      "  };",
      "}",
      "export { emitSkip };",
      "",
    ].join("\n"),
    (dir) => {
      const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
      assert.deepEqual(literalReasons, [], "a template-composed reason must not be guessed at as a literal");
      assert.equal(unresolved.length, 1, "a template-composed reason must be reported as unresolved");
      assert.match(unresolved[0]?.snippet ?? "", /pdf_download_\$\{reason\}/);
    }
  );
});

test("falsifiability: an all-literal ternary still resolves both branches (existing behavior preserved)", () => {
  withSyntheticConnectorFile(
    "index.ts",
    [
      "function emitSkip(ok: boolean) {",
      "  return { type: 'SKIP_RESULT', reason: ok ? 'branch_a' : 'branch_b' };",
      "}",
      "export { emitSkip };",
      "",
    ].join("\n"),
    (dir) => {
      const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
      assert.deepEqual([...literalReasons].sort(), ["branch_a", "branch_b"]);
      assert.deepEqual(unresolved, []);
    }
  );
});

test("falsifiability: a .test.ts sibling in the same directory is excluded from the production scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "reason-emission-scan-falsifiability-"));
  try {
    writeFileSync(
      join(dir, "index.test.ts"),
      ['export const fixture = { reason: "test_only_fixture_reason" };', ""].join("\n")
    );
    const { literalReasons } = scanConnectorForReasonEmissions(dir);
    assert.deepEqual(literalReasons, [], "a .test.ts file must not contribute to the production reason-emission scan");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("falsifiability: a DETAIL_GAP-shaped reason: literal resolves (the real gmail/heb/slack/chatgpt buildDetailGap pattern)", () => {
  // buildDetailGap (src/connector-runtime.ts) constructs `{ type: "DETAIL_GAP",
  // ..., reason, ... }` from its caller's `reason` argument. The call site
  // itself never writes the literal `type: "DETAIL_GAP"` object — that's
  // this scanner's synthetic stand-in for the emitted shape a connector's
  // OWN call-site reason expression feeds into.
  withSyntheticConnectorFile(
    "index.ts",
    [
      "function buildGap(reason: string) {",
      "  return { type: 'DETAIL_GAP', reason };",
      "}",
      "function emitGap() {",
      "  return buildGap('detail_gap_specific_reason');",
      "}",
      "export { emitGap };",
      "",
    ].join("\n"),
    (dir) => {
      const { literalReasons, unresolved } = scanConnectorForReasonEmissions(dir);
      assert.deepEqual(unresolved, []);
      assert.ok(
        literalReasons.includes("detail_gap_specific_reason"),
        "a reason: literal passed as an argument feeding a DETAIL_GAP-shaped object must be discovered"
      );
    }
  );
});

test("USAA's real fix: the pdf_download_* codes are now plain literals, discovered from statement-pdfs.ts + index.ts together", () => {
  const usaaDir = join(CONNECTORS_DIR, "usaa");
  assert.ok(existsSync(usaaDir), "expected the real usaa connector directory to exist");
  const { literalReasons, unresolved } = scanConnectorForReasonEmissions(usaaDir);
  assert.deepEqual(unresolved, [], "usaa must have zero unresolved reason: expressions after the fix");
  for (const code of [
    "pdf_download_direct_link_failed",
    "pdf_download_click_failed",
    "pdf_download_empty",
    "pdf_download_timeout",
    "pdf_download_no_download_menuitem",
    "pdf_download_no_options_affordance",
    "pdf_download_row_missing",
    "pdf_download_persist_failed",
  ]) {
    assert.ok(literalReasons.includes(code), `expected ${code} to be discovered as a live literal reason code`);
  }
});
