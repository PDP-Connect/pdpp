// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fleet-wide build-time guardrail: no connector may emit a DETAIL_COVERAGE for
 * a stream its own manifest declares with a static `state_stream` parent.
 *
 * Such a stream is a static single-parent detail stream: its checkpoint status
 * is projected from the declared parent's own commit outcome, so the runtime's
 * `validateDetailCoverageAgainstManifest`
 * (reference-implementation/runtime/index.ts) throws on the emission and fails
 * the ENTIRE run with `runtime_error`. A detail stream inheriting its parent's
 * considered/covered is also asserting a denominator it never earned — the
 * `covered == considered` fabrication this codebase has worked to eliminate.
 *
 * Regression this exists to prevent: commit 160d78c26 added the runtime guard
 * AND connector code violating it, in the same tree. It stayed latent for six
 * days because the guard was not deployed. The moment deploy drain29 shipped
 * it, EVERY run of both violating connectors (gmail `message_bodies`, slack
 * `reactions` + `message_attachments`) began failing with `runtime_error` — a
 * total collection outage, forcing a rollback to drain28. Per-connector tests
 * could not catch this class: each connector's own suite was green, and no
 * test read the fleet as a whole.
 *
 * This test is deliberately STATIC (manifest + source text) rather than
 * behavioral. A behavioral fleet test would have to execute all 45 connectors
 * against live credentials; a static one covers every connector including
 * OTP/owner-gated ones (heb, usaa, chase, amazon, venmo, reddit) that cannot
 * be driven in CI, and covers a stream the day the manifest declares it.
 *
 * It is intentionally CONTRACT-based, not name-based: the manifests are the
 * authority on which streams are state_stream-parented, so a newly-parented
 * stream is covered automatically without editing this file.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");

interface ManifestStream {
  name?: unknown;
  state_stream?: unknown;
  [key: string]: unknown;
}

interface ConnectorManifest {
  streams?: ManifestStream[];
  [key: string]: unknown;
}

/**
 * Mirrors the runtime's `buildManifestStateStreamMap` exactly, INCLUDING its
 * `state_stream !== name` exclusion — a self-referential declaration is a
 * stream proving its own coverage, which is legal and common (see slack's
 * `declareListConsidered`). Diverging from the runtime here would make this
 * test assert a contract the runtime does not enforce.
 */
function stateStreamParentedStreams(manifest: ConnectorManifest): Set<string> {
  const parented = new Set<string>();
  for (const stream of manifest.streams ?? []) {
    const name = stream?.name;
    const parent = stream?.state_stream;
    if (typeof name === "string" && typeof parent === "string" && parent && parent !== name) {
      parented.add(name);
    }
  }
  return parented;
}

/** Every `.ts` source file of one connector, excluding its tests. */
function connectorSourceFiles(connectorDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
  };
  walk(connectorDir);
  return files;
}

/** Comments are stripped so prose naming a stream cannot produce a phantom hit. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, "");
}

/**
 * The DETAIL_COVERAGE construction sites this fleet uses. `buildDetailCoverageMessage`
 * returns the message (caller emits it) and `emitDetailCoverage` emits directly;
 * both take an object literal carrying `stream`. A raw `type: "DETAIL_COVERAGE"`
 * literal is included so a connector bypassing the helpers is still caught.
 */
const COVERAGE_CONSTRUCTORS = ["buildDetailCoverageMessage", "emitDetailCoverage", '"DETAIL_COVERAGE"'];

/**
 * The argument region of a construction: from the call's opening paren to its
 * balanced close. Bounded so a malformed/unbalanced source cannot spin.
 */
function argumentRegion(source: string, callIndex: number): string {
  const open = source.indexOf("(", callIndex);
  if (open === -1) {
    return "";
  }
  let depth = 0;
  const limit = Math.min(source.length, open + 2000);
  for (let i = open; i < limit; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  return source.slice(open, limit);
}

/**
 * Resolves the stream name(s) a DETAIL_COVERAGE construction describes.
 *
 * Two forms occur in this fleet, and BOTH must be resolved — catching only the
 * first is what let the slack defect reach production:
 *
 *  1. Literal   — `stream: "message_bodies"` (gmail's defect).
 *  2. Indirect  — `stream,` shorthand bound by an enclosing
 *                 `for (const stream of ["reactions", ...] as const)`
 *                 (slack's defect). The literal text lives in the loop header,
 *                 so the enclosing loop is consulted only when the argument
 *                 region passes `stream` as a bare identifier.
 *
 * Scoping to the argument region (rather than a raw character window) keeps
 * neighbouring `emitRecord("reactions", ...)` RECORD emissions — perfectly
 * legal for a parented stream — from reading as coverage claims.
 */
function coverageStreamNames(source: string): Set<string> {
  const clean = stripComments(source);
  const names = new Set<string>();
  for (const ctor of COVERAGE_CONSTRUCTORS) {
    let index = clean.indexOf(ctor);
    while (index !== -1) {
      const args = argumentRegion(clean, index + ctor.length);
      const literal = args.match(/\bstream:\s*["']([^"']+)["']/);
      if (literal?.[1]) {
        names.add(literal[1]);
      } else if (/\bstream\s*[,}]/.test(args)) {
        // Shorthand `stream` — resolve it from the nearest enclosing
        // `for (const stream of [ ... ])` above this call.
        const before = clean.slice(Math.max(0, index - 1200), index);
        const loop = [...before.matchAll(/for\s*\(\s*const\s+stream\s+of\s*\[([^\]]*)\]/g)].pop();
        for (const member of loop?.[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
          if (member[1]) {
            names.add(member[1]);
          }
        }
      }
      index = clean.indexOf(ctor, index + ctor.length);
    }
  }
  return names;
}

/**
 * The parent side of the guard. A DETAIL_COVERAGE names BOTH the stream it
 * describes and its `stateStream`; only the former is constrained here. A
 * parented stream legitimately appears as another emission's `stateStream`
 * (gmail's `attachments` names `messages`), so `stateStream:` values are
 * deliberately not collected above — the regex targets `stream:` with a word
 * boundary, which `stateStream:` does not match.
 */
test("fleet: no manifest state_stream-parented stream constructs a DETAIL_COVERAGE", () => {
  const parentedByConnector = new Map<string, Set<string>>();

  for (const filename of readdirSync(MANIFESTS_DIR).sort()) {
    if (!filename.endsWith(".json")) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(MANIFESTS_DIR, filename), "utf8")) as ConnectorManifest;
    const parented = stateStreamParentedStreams(manifest);
    if (parented.size) {
      parentedByConnector.set(filename.replace(/\.json$/, ""), parented);
    }
  }

  // Mutation guard, and the reason this test cannot be silenced by editing a
  // manifest. Deleting a `state_stream` declaration would shrink the parented
  // set and let a violating emission pass unnoticed, so the KNOWN parent/detail
  // relationships are pinned here as facts in their own right. These are real
  // modeling statements about these connectors, not incidental test data:
  // dropping one to quiet a failure destroys a true fact about the data model
  // and must fail loudly rather than silently widen what may claim coverage.
  //
  // Adding a NEW parented stream is expected and needs no edit here — the
  // violation scan below reads the manifests directly. Only REMOVING one of
  // these trips this assertion.
  const KNOWN_PARENTED: Record<string, string[]> = {
    claude_code: ["attachments", "memory_notes", "messages"],
    codex: ["function_calls", "messages"],
    gmail: ["message_bodies"],
    slack: ["message_attachments", "reactions"],
  };
  for (const [connectorKey, expected] of Object.entries(KNOWN_PARENTED)) {
    const actual = [...(parentedByConnector.get(connectorKey) ?? [])].sort();
    for (const stream of expected) {
      assert.ok(
        actual.includes(stream),
        `precondition: ${connectorKey} must still declare '${stream}' with a static state_stream parent. ` +
          "A state_stream declaration was deleted rather than a violating DETAIL_COVERAGE emission removed — " +
          "that relationship is a true modeling fact and removing it to silence this guard is the wrong fix."
      );
    }
  }

  const violations: string[] = [];
  for (const [connectorKey, parented] of [...parentedByConnector].sort()) {
    const connectorDir = join(CONNECTORS_DIR, connectorKey);
    if (!existsSync(connectorDir)) {
      continue;
    }
    for (const file of connectorSourceFiles(connectorDir)) {
      const emitted = coverageStreamNames(readFileSync(file, "utf8"));
      for (const stream of [...emitted].sort()) {
        if (!parented.has(stream)) {
          continue;
        }
        violations.push(
          `${connectorKey}.${stream} (${file.slice(PACKAGE_ROOT.length + 1)}): names this stream at a ` +
            "DETAIL_COVERAGE construction, but the manifest declares it with a static state_stream parent. The " +
            "runtime rejects that emission and fails the whole run with runtime_error. Withhold it — the parent's " +
            "considered/covered were never this stream's to claim."
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `state_stream-parented streams must not emit DETAIL_COVERAGE:\n${violations.join("\n")}`
  );
});
