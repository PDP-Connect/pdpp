// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bans `as unknown as ConnectionHealthSnapshot` / `as unknown as RenderedVerdict`
 * in the reference test tree.
 *
 * THE DRIFT THIS PREVENTS. A test that hand-builds one of these types is keeping
 * a second, unversioned copy of a producer's contract
 * (`computeConnectionHealth`, `runtime/connection-health.ts`;
 * `synthesizeRenderedVerdict`, `runtime/rendered-verdict.ts`). The compiler is
 * the only thing that keeps that copy honest, and `as unknown as` switches it
 * off — the double cast erases the shape check entirely, so a fixture can invent
 * axes that do not exist and omit the ones the renderer actually reads while
 * still compiling and still passing.
 *
 * That is not theoretical. `rendered-verdict-proof-age.test.ts` was born drifted
 * in `345e6672d`: it supplied invented `credential`/`runtime` axes and omitted
 * `attention`/`outbox`. Measured through the real renderer, its self-described
 * "green, fresh, fully-covered connection" produced `pill: {}` — no label, no
 * tone — and `channel: "attention"`. The suite passed 10/10 for the whole time,
 * because every assertion read only the freshness annotation.
 *
 * Three owner-visible defects have already shipped through this class of blind
 * spot in the status pipeline:
 *   - `8c85a2261` — the freshness sentence printed twice on 22 of 28 owner-visible rows.
 *   - `1231479d7` — archived sources rendered a green "Healthy" line.
 *   - the 2026-08-19 live defect — 299,248 retained records displayed as "Holding 0 records".
 *
 * WHAT THIS IS NOT. This is a boundary-specific ban, not a style rule about
 * casts. `as unknown as` stays legitimate everywhere else in this tree (wire
 * payloads, structural stand-ins for driver types, deliberately malformed input),
 * and this test does not touch those. It bans the cast at exactly the seam where
 * it destroys producer-drift detection.
 *
 * WHAT IT DOES NOT CATCH. Type checking proves SHAPE, not COHERENCE: a fixture
 * can still pair `state: "healthy"` with `outbox: "stalled"`, a tuple the real
 * projection never emits. Removing the cast is the floor, not the ceiling — the
 * ceiling is asserting on the projection the owner actually reads (see the
 * control test at the top of `rendered-verdict-proof-age.test.ts`).
 *
 * IT ALSO DOES NOT CATCH A HAND-TYPED UNION. A mirror that RE-DECLARES a
 * producer's closed union has no cast to ban and no check to switch off. That
 * is a different door to the same room, and it is held by
 * `apps/console/src/app/(console)/lib/ref-client-union-parity.test.ts`, not by
 * this file.
 *
 * FIXED 2026-08-25 — two defects in this guard's own construction, both of
 * which made it an instance of the class it polices:
 *   1. `BANNED_CAST_PATTERN` hand-typed the two producer names, so a rename
 *      would have left it matching nothing while still passing. The names are
 *      now read off `computeConnectionHealth` / `synthesizeRenderedVerdict`.
 *   2. It walked only the reference test tree and could not see the console app
 *      at all — the tree where the drifts actually shipped. Both trees are
 *      walked now, and the subscripted `T["axes"]` form is no longer a bypass.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..");

const TEST_FILE_RE = /\.test\.tsx?$/;

/**
 * The producer output types whose hand-built fixtures must stay compiler-checked.
 *
 * DERIVED, NOT HAND-TYPED — and that is a correction, not a flourish. This list
 * used to be the literal string `(ConnectionHealthSnapshot|RenderedVerdict)`,
 * which made this guard an instance of the very class it polices: a second,
 * unversioned copy of a producer's name. If `computeConnectionHealth`'s return
 * type were renamed, the ban would silently stop matching anything and this
 * suite would still pass, green and useless.
 *
 * So read the names off the producers' own signatures. If either function is
 * renamed or its return type changes, this throws instead of quietly narrowing.
 */
function bannedTypeNames(): string[] {
  const sources: readonly { readonly file: string; readonly fn: string }[] = [
    { file: "reference-implementation/runtime/connection-health.ts", fn: "computeConnectionHealth" },
    { file: "reference-implementation/runtime/rendered-verdict.ts", fn: "synthesizeRenderedVerdict" },
  ];
  return sources.map(({ file, fn }) => {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const match = source.match(new RegExp(`export function ${fn}\\([\\s\\S]*?\\)\\s*:\\s*([A-Za-z0-9_]+)`));
    assert.ok(
      match?.[1],
      `Could not read the return type of \`${fn}\` from ${file}. This guard is now blind — fix it.`
    );
    return match[1];
  });
}

/**
 * `as unknown as` is matched with flexible whitespace so a reformat cannot
 * smuggle one past. The trailing `\b` deliberately allows a subscripted form
 * (`as unknown as ConnectionHealthSnapshot["axes"]`) to match, because casting
 * to a slice of the producer's type erases the same check as casting to all of
 * it — with ONE exemption, documented at the call site below.
 */
function bannedCastPattern(): RegExp {
  return new RegExp(`as\\s+unknown\\s+as\\s+(${bannedTypeNames().join("|")})\\b`);
}

/**
 * SCOPE. Round 1 walked only the reference test tree, so the console app — the
 * other consumer of these exact producer types, and the one where the
 * `RefActionRemediationCause` and `RefVerdictPill.label` drifts actually
 * shipped — was entirely outside this guard's reach. Both trees are walked now.
 *
 * The console mirrors these types under a `Ref` prefix, so the ban is applied
 * to `RefConnectionHealthSnapshot` / `RefRenderedVerdict` there as well; see
 * `bannedCastPatternFor`.
 */
const SCANNED_TREES: readonly { readonly label: string; readonly dir: string; readonly prefix: string }[] = [
  { dir: TEST_DIR, label: "reference-implementation/test", prefix: "" },
  { dir: join(REPO_ROOT, "apps", "console", "src"), label: "apps/console", prefix: "Ref" },
];

function bannedCastPatternFor(prefix: string): RegExp {
  return prefix === ""
    ? bannedCastPattern()
    : new RegExp(`as\\s+unknown\\s+as\\s+${prefix}(${bannedTypeNames().join("|")})\\b`);
}

function listTestFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "fixtures") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (TEST_FILE_RE.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

/**
 * The ONE justified exemption, stated per-site rather than as a silent hole.
 *
 * `connection-evidence.test.ts` casts to `RefConnectionHealthSnapshot["axes"]`
 * in order to inject axis values the current producer CANNOT emit
 * (`"future_gap"`, `"future_outbox"`) and assert that `summarizeAxisChips`
 * degrades them to neutral chips instead of crashing. That is the exact
 * OPPOSITE of assuming a contract: the test is proving the consumer survives
 * values the producer has not invented yet, which is only expressible by
 * escaping the current type. Verified 2026-08-25 that both sites are
 * forward-compat degradation tests and neither omits a field the consumer reads.
 */
const EXEMPT_SITES: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: "apps/console/src/app/(console)/lib/connection-evidence.test.ts",
    why: "injects deliberately novel axis values to test forward-compatible degradation",
  },
];

test("no test casts around the health/verdict producer types, in either tree", () => {
  const offenders: string[] = [];
  for (const tree of SCANNED_TREES) {
    const pattern = bannedCastPatternFor(tree.prefix);
    for (const file of listTestFiles(tree.dir)) {
      // This file names the banned pattern in order to ban it.
      if (file === fileURLToPath(import.meta.url)) {
        continue;
      }
      const relative = file.slice(REPO_ROOT.length + 1);
      if (EXEMPT_SITES.some((exempt) => relative === exempt.file)) {
        continue;
      }
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    [
      "A hand-built health/verdict fixture must stay compiler-checked against its producer.",
      "`as unknown as` erases that check and lets the fixture invent or omit axes.",
      "Build the fixture with every field present and no cast — see",
      "`connector-verdict-input-mappers.test.ts` for the shape to mirror.",
      "",
      ...offenders,
    ].join("\n")
  );
});

/**
 * The guard is only worth its line count if the pattern it bans is the pattern
 * that actually shipped. This pins the regex against the exact text of the
 * original defect, so a future "simplification" of the regex cannot quietly
 * stop matching it.
 */
test("the ban matches the exact cast that hid the empty-pill defect", () => {
  const pattern = bannedCastPattern();
  assert.match("  } as unknown as ConnectionHealthSnapshot;", pattern);
  assert.match("  } as unknown as RenderedVerdict;", pattern);
  assert.match("} as  unknown  as  RenderedVerdict;", pattern);
  // The subscripted form erases the same check and must not slip past — this is
  // the second of round 1's two documented blind spots.
  assert.match('} as unknown as ConnectionHealthSnapshot["axes"];', pattern);
  // ...and the console's prefixed mirror of the same types.
  assert.match('} as unknown as RefConnectionHealthSnapshot["axes"];', bannedCastPatternFor("Ref"));
});

/**
 * The derivation is the whole point of the fix, so pin it: these names must
 * come from the producers' signatures, not from a literal in this file. If a
 * future edit re-hardcodes them, the assertion below still passes — but the
 * `bannedTypeNames()` call is what proves the read works today.
 */
test("the banned type names are read from the producers, not hand-typed here", () => {
  assert.deepEqual(bannedTypeNames(), ["ConnectionHealthSnapshot", "RenderedVerdict"]);
});

/**
 * ...and that it stays narrow. These are the legitimate neighbouring casts
 * already in this tree; the ban must not creep into a blanket style rule.
 */
test("the ban does not touch legitimate casts elsewhere in the tree", () => {
  const pattern = bannedCastPattern();
  for (const legitimate of [
    "  } as unknown as ComputeConnectionHealthInput;",
    "} as unknown as Parameters<typeof liveRetainedRecordsOrNull>[0];",
    "const resultRecord = result as unknown as Record<string, unknown>;",
    "approved.grant.streams as unknown as ResolvedStream[];",
    "  const snapshot: ConnectionHealthSnapshot = build();",
  ]) {
    assert.doesNotMatch(legitimate, pattern);
  }
});
