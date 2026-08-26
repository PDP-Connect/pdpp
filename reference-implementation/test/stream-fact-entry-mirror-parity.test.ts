// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Field-set parity between the read model's module-private
 * `StoredStreamFactEntry` and every hand-typed mirror of it in the test tree.
 *
 * THE DRIFT THIS PREVENTS. `stream_latest_facts_json` is a JSON blob. It is
 * written by `mergeEventStreamFacts`/`applyRecoveryGapClosureFacts`
 * (`server/connector-summary-read-model.ts`) and read back out through
 * `shapeEvidenceRow`, which types it as `unknown` — `parseEvidenceJson`
 * returns `unknown` by construction, because the column is untyped storage.
 *
 * So the entry envelope has NO compiler check anywhere on the read path. The
 * producer's `StoredStreamFactEntry` is module-private and not exported, and
 * three test files therefore RE-DECLARE it by hand in order to type their
 * assertions:
 *
 *   - `connector-summary-stream-facts.test.ts`
 *   - `connector-summary-stream-facts-reliability.test.ts`
 *   - `connector-summary-stream-facts-monotonic-postgres.test.ts`
 *
 * Each of those is a second, unversioned copy of a producer contract. Unlike
 * an `as unknown as` cast there is no check being switched off — the check
 * never existed. Both sides are valid TypeScript in isolation and no
 * expression anywhere relates them, so the producer can rename or drop an
 * envelope field and all three mirrors keep compiling, keep passing, and keep
 * asserting against a shape the producer no longer writes.
 *
 * Concretely: rename `evidence_as_of` to `evidence_at` in the producer and
 * every one of those suites still goes green. Their fixtures would seed the
 * old key, `requireStreamFact(...).evidence_as_of` would read `undefined`,
 * and any assertion comparing it to another `undefined` would still hold.
 * The freshness provenance the owner reads on /sources is derived from this
 * exact field (`runtime/recovery-decision.ts` reads
 * `stream_latest_facts[stream].evidence_as_of`), so the drift lands as a
 * wrong or missing "last proven" time with no test objecting.
 *
 * WHY FIELD SETS AND NOT TYPES. This guard pins the ENVELOPE
 * (`event_seq`/`evidence_as_of`/`fact`/`run_id`) — the part every mirror
 * shares and the part the producer constructs at a single site. It
 * deliberately does NOT pin the inner `fact`, which is `Row =
 * Record<string, unknown>` on the producer side: the raw runtime fact is an
 * open, connector-authored bag, and each test narrows it to just the keys
 * that file asserts on (`checkpoint`/`collected`, plus
 * `considered`/`covered`/`skipped` where relevant). Narrowing an open bag is
 * legitimate; silently disagreeing about the closed envelope around it is
 * not.
 *
 * THE FALSIFIER. Rename or add an envelope field on `StoredStreamFactEntry`
 * and this test must go red WITHOUT ANY EDIT TO THIS FILE. Both sides are read
 * from source text for that reason — a hand-typed expectation here would make
 * this guard an instance of the class it polices, exactly the defect corrected
 * in `health-verdict-fixture-no-shape-cast.ts`'s round 2.
 *
 * VERIFIED 2026-08-25, not assumed: renaming the producer's `evidence_as_of`
 * to `evidence_at` leaves `connector-summary-stream-facts-reliability.test.ts`
 * passing 7/7 — the blind spot is real — while this guard goes red.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const RI_ROOT = join(TEST_DIR, "..");

const PRODUCER_FILE = join(RI_ROOT, "server", "connector-summary-read-model.ts");

/**
 * The test files that re-declare the producer's entry type by hand. Listed
 * explicitly rather than discovered by grep so that ADDING a fourth mirror is
 * a deliberate act: a new hand-typed copy should have to be named here, which
 * is the moment to ask whether it should exist at all.
 */
const MIRROR_FILES: readonly string[] = [
  "connector-summary-stream-facts.test.ts",
  "connector-summary-stream-facts-reliability.test.ts",
  "connector-summary-stream-facts-monotonic-postgres.test.ts",
];

const TYPE_NAME = "StoredStreamFactEntry";

/** One `name:` / `name?:` declaration at the head of a field line. */
const FIELD_NAME_RE = /^\s*([A-Za-z0-9_]+)\s*\??\s*:/;

/** An object literal with no further nesting inside it. */
const INNERMOST_OBJECT_RE = /\{[^{}]*\}/g;

/** Field declarations are separated by a newline or a semicolon. */
const FIELD_SEPARATOR_RE = /[;\n]/;

/**
 * Reads the top-level field names off an `interface <TYPE_NAME> { ... }`
 * declaration in `source`.
 *
 * Nested object literals (the inline `fact: { ... }` a mirror may write) are
 * collapsed away first, so only the ENVELOPE's own keys are returned. That is
 * the whole point: the envelope is closed and must agree, the inner `fact` is
 * open and deliberately does not.
 */
function envelopeFields(source: string, where: string): string[] {
  const start = source.indexOf(`interface ${TYPE_NAME} {`);
  assert.notEqual(
    start,
    -1,
    `Could not find \`interface ${TYPE_NAME}\` in ${where}. This guard is now blind — fix it.`
  );

  // Take the interface body, balanced at depth 0.
  const bodyStart = source.indexOf("{", start) + 1;
  let depth = 0;
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
      depth -= 1;
    }
  }
  const body = source.slice(bodyStart, bodyEnd);

  // Collapse every NESTED object literal to a placeholder before reading
  // names. A one-line `fact: { checkpoint: string };` would otherwise offer
  // its inner keys to the matcher below; after collapsing, only `fact`
  // remains at the envelope level. Repeat to the innermost nesting.
  let flattened = body;
  let previous = "";
  while (flattened !== previous) {
    previous = flattened;
    flattened = flattened.replace(INNERMOST_OBJECT_RE, "_");
  }

  const fields = flattened
    .split(FIELD_SEPARATOR_RE)
    .map((entry) => entry.match(FIELD_NAME_RE)?.[1])
    .filter((name): name is string => Boolean(name));

  assert.ok(fields.length > 0, `Read zero fields off \`${TYPE_NAME}\` in ${where}. This guard is now blind — fix it.`);
  return fields.sort();
}

function readProducerFields(): string[] {
  return envelopeFields(readFileSync(PRODUCER_FILE, "utf8"), "server/connector-summary-read-model.ts");
}

test("every hand-typed StoredStreamFactEntry mirror matches the producer's envelope", () => {
  const producerFields = readProducerFields();

  for (const mirror of MIRROR_FILES) {
    const mirrorFields = envelopeFields(readFileSync(join(TEST_DIR, mirror), "utf8"), `test/${mirror}`);
    assert.deepEqual(
      mirrorFields,
      producerFields,
      [
        `\`${TYPE_NAME}\` in test/${mirror} has drifted from its producer.`,
        "",
        `  producer (server/connector-summary-read-model.ts): ${producerFields.join(", ")}`,
        `  mirror   (test/${mirror}): ${mirrorFields.join(", ")}`,
        "",
        "`stream_latest_facts_json` is parsed as `unknown`, so nothing else in the",
        "repo compares these two declarations. Update the mirror to match the",
        "producer — do not relax this assertion.",
      ].join("\n")
    );
  }
});

/**
 * Pins the extractor against the producer's real declaration. If a future
 * "simplification" of `envelopeFields` stopped finding fields, the loop above
 * would compare two empty-ish lists and pass; this makes that failure loud.
 *
 * The expectation is written out here ON PURPOSE, and it is the one hand-typed
 * list in this file: it proves the READ WORKS today. The parity test above
 * never consults it.
 */
test("the extractor reads the producer's envelope, not an empty list", () => {
  assert.deepEqual(readProducerFields(), ["event_seq", "evidence_as_of", "fact", "run_id"]);
});

/**
 * ...and that nested `fact: { ... }` literals really are skipped. A mirror
 * spelling its inner fact inline must not leak `checkpoint`/`collected` into
 * the envelope comparison, or every mirror would appear to disagree with the
 * producer's `fact: Row` and this guard would be unusable noise.
 */
test("nested fact literals do not leak into the envelope field set", () => {
  const inlineMirror = [
    `interface ${TYPE_NAME} {`,
    "  event_seq: number;",
    "  evidence_as_of: string | null;",
    "  fact: { checkpoint: string; collected: number; stream?: string };",
    "  run_id: string | null;",
    "}",
  ].join("\n");
  assert.deepEqual(envelopeFields(inlineMirror, "<inline fixture>"), ["event_seq", "evidence_as_of", "fact", "run_id"]);
});
