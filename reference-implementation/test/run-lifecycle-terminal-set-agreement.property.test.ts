// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The terminal set must have ONE declaration, and every consumer must agree.
 *
 * Property: for every terminal state, every consumer of the terminal set
 *   classifies a run in that state as terminal, and both backends agree.
 * Generator: the cross-product of (terminal state) x (consumer of the
 *   terminal set) x (storage backend).
 * Invariant: unanimous classification.
 *
 * This failed by construction on live divergences. `lib/spine.ts` declared the
 * canonical five and its own comment said "All run-status projection code must
 * read from this set; never hardcode subset checks" — and did not export it,
 * so other declarations did exactly that:
 *
 *   omitting `run.abandoned`:
 *     server/connector-summary-read-model.ts, server/db.ts (x4 — one of which
 *     the design inventory missed, plus a partial index and a trigger),
 *     server/postgres-storage.ts (x4),
 *     server/connector-summary-evidence-engine.ts (x2)
 *   omitting `run.browser_surface_failed`:
 *     lib/postgres-spine.ts, server/postgres-storage.ts
 *
 * The design brief inventoried six. This scan found more: three further
 * `run.abandoned` omissions in server/db.ts (an index predicate and a trigger
 * condition among them) and two correct-but-duplicate copies in
 * server/stores/run-history-backfill-stage.ts. That gap is the argument for
 * the structural case below — a hand-counted inventory of copies is itself a
 * copy, and it drifted.
 *
 * The SQLite-side and PostgreSQL-side omissions differ, so the two backends
 * disagreed about what "terminal" means. Consequence: an abandoned run was
 * invisible to the connector-summary fold, and the 121 runs the sibling
 * owner-epoch change adjudicated are exactly that hidden population.
 *
 * The structural case below (the source scan) is the one that keeps this
 * closed. Asserting only that today's constants agree would go stale the
 * moment someone writes the seventh copy — which is how the first six
 * happened.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  TERMINAL_RUN_EVENT_TYPE_LIST,
  TERMINAL_RUN_EVENT_TYPES,
  terminalRunEventTypesSqlGroup,
  terminalRunEventTypesSqlList,
  TERMINAL_RUN_STATES,
  terminalStateForEventType,
} from "../runtime/run-lifecycle-states.ts";

const REPO_DIRS = ["server", "lib", "runtime", "operations", "scripts"];
/** The single declaration site, exempt from the no-second-copy scan. */
const DECLARATION_MODULE = "runtime/run-lifecycle-states.ts";

/**
 * `.sql` query artifacts cannot import TypeScript, so they are the one place
 * the members must still be typed out. They are allowlisted by exact path
 * rather than by extension, and the case below asserts their contents equal
 * the declaration -- so they are pinned, not merely excused. A NEW .sql file
 * with a terminal set fails the scan until it is added here deliberately.
 */
const SQL_ARTIFACTS_WITH_TERMINAL_SET: readonly string[] = [
  "server/queries/spine/check-run-terminal.sql",
  "server/queries/spine/get-run-terminal-event.sql",
];
const SOURCE_ROOT = new URL("..", import.meta.url).pathname;

/**
 * A hand-typed terminal-set literal, in either SQL or array form. Matches a
 * run of at least three `run.*` terminal members, which is narrow enough not
 * to fire on an ordinary single-event comparison and wide enough to catch a
 * four- or five-member copy.
 */
const HANDTYPED_SET = /(['"]run\.(?:completed|failed|cancelled|abandoned|browser_surface_failed)['"]\s*,\s*){2,}['"]run\./u;

function* walkSourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const stats = statSync(full);
    if (stats.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".sql")) && !entry.includes(".test.")) {
      yield full;
    }
  }
}

test("run lifecycle: the terminal set has one declaration", async (t) => {
  await t.test("every consumer classifies every terminal state as terminal", () => {
    // Consumers are enumerated from the declaration itself, so a consumer
    // that drifts is caught rather than a hardcoded list going stale.
    for (const eventType of TERMINAL_RUN_EVENT_TYPE_LIST) {
      assert.ok(TERMINAL_RUN_EVENT_TYPES.has(eventType), `${eventType} missing from the canonical set`);

      const state = terminalStateForEventType(eventType);
      assert.ok(state, `${eventType} maps to no run state`);
      assert.ok(TERMINAL_RUN_STATES.has(state), `${eventType} maps to ${state}, which is not terminal`);

      // The SQL renderings are the form the divergent copies took.
      assert.match(
        terminalRunEventTypesSqlList(),
        new RegExp(`'${eventType.replace(".", "\\.")}'`, "u"),
        `${eventType} missing from the rendered SQL list`
      );
      assert.match(
        terminalRunEventTypesSqlGroup(),
        new RegExp(`'${eventType.replace(".", "\\.")}'`, "u"),
        `${eventType} missing from the rendered SQL group`
      );
    }

    // Both historically-omitted members are present. These two assertions are
    // the specific defects: four declarations dropped `run.abandoned` and two
    // dropped `run.browser_surface_failed`.
    assert.ok(TERMINAL_RUN_EVENT_TYPES.has("run.abandoned"), "run.abandoned must be terminal");
    assert.ok(
      TERMINAL_RUN_EVENT_TYPES.has("run.browser_surface_failed"),
      "run.browser_surface_failed must be terminal"
    );
    assert.equal(TERMINAL_RUN_EVENT_TYPES.size, 5, "the canonical terminal set has exactly five members");
  });

  await t.test("SQLite and PostgreSQL agree on terminal classification", () => {
    // The two backends previously omitted DIFFERENT members. Both now render
    // from one function, so the rendered SQL is byte-identical by
    // construction -- which is the only way "the backends agree" can be a
    // property rather than a hope.
    const group = terminalRunEventTypesSqlGroup();
    assert.equal(group, `(${terminalRunEventTypesSqlList()})`);
    for (const eventType of TERMINAL_RUN_EVENT_TYPE_LIST) {
      assert.ok(group.includes(`'${eventType}'`), `${eventType} missing from the shared rendering`);
    }
  });

  await t.test("an abandoned run is visible to the terminal fold", () => {
    // The specific observable consequence of the omission: the
    // connector-summary fold reads the terminal set, so an omitted
    // `run.abandoned` made every adjudicated run invisible to it.
    assert.ok(TERMINAL_RUN_EVENT_TYPES.has("run.abandoned"));
    assert.equal(terminalStateForEventType("run.abandoned"), "abandoned");
    assert.ok(TERMINAL_RUN_STATES.has("abandoned"));
  });

  await t.test("adding a terminal state requires exactly one edit", () => {
    // The structural property. A comment asking two constants to stay in sync
    // is not a mechanism; the absence of a second copy is.
    const offenders: string[] = [];
    for (const dir of REPO_DIRS) {
      for (const file of walkSourceFiles(join(SOURCE_ROOT, dir))) {
        const relative = file.slice(SOURCE_ROOT.length);
        // The declaration module is the ONE place the members may be typed
        // out. Exempting it by exact path (rather than by a general
        // "declaration-looking" heuristic) is what keeps the rule from
        // quietly re-admitting a second copy.
        if (relative === DECLARATION_MODULE || SQL_ARTIFACTS_WITH_TERMINAL_SET.includes(relative)) {
          continue;
        }
        const contents = readFileSync(file, "utf8");
        if (HANDTYPED_SET.test(contents)) {
          offenders.push(relative);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `hand-typed terminal-set literals found; these must derive from runtime/run-lifecycle-states.ts:\n${offenders.join("\n")}`
    );
  });

  await t.test("the allowlisted SQL artifacts match the declaration exactly", () => {
    // A .sql file cannot import the constant, so the allowlist above would be
    // a hole if it only excused those files. Pin their contents instead: each
    // must contain every member, so adding a terminal state and forgetting
    // these fails here rather than silently in production.
    for (const relative of SQL_ARTIFACTS_WITH_TERMINAL_SET) {
      const contents = readFileSync(join(SOURCE_ROOT, relative), "utf8");
      for (const eventType of TERMINAL_RUN_EVENT_TYPE_LIST) {
        assert.ok(
          contents.includes(`'${eventType}'`),
          `${relative} omits ${eventType}; allowlisted SQL must carry the full terminal set`
        );
      }
    }
  });
});
