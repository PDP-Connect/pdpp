// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * D6: successor adjudication is a legal TRANSITION, not a sibling job.
 *
 * "New epoch owner marks predecessor-epoch non-terminal runs abandoned" was
 * implemented three times over — `lib/controller-boot.ts`'s two abandon
 * projections (one per backend) and `scripts/repair/adjudicate-orphaned-runs.ts`
 * — each hand-writing its own UPDATE. All three fenced on `status = 'running'`
 * and none on `owner_epoch`, because until the previous commit no writer set
 * that column.
 *
 * The mechanism was already correct in the sense that mattered most: all three
 * pick the orphan set by EPOCH COMPARISON, never by an age threshold. What
 * they lacked was the fence on the write itself, so a stale predecessor that
 * woke up mid-adjudication could still land a terminal write. D2 says a stale
 * controller's write must fail AT THE DATABASE.
 *
 * What this file pins
 * -------------------
 *  1. The projection is the machine's statement (`buildAdjudicationStatement`),
 *     not a hand-written copy. Asserted structurally, because a duplicated
 *     statement that happens to agree today is exactly how the terminal-set
 *     declaration reached twelve copies with ten divergent.
 *  2. The transition is LEGAL under the table: `boot_adjudicator` may move a
 *     non-terminal run to `abandoned` (T10/T11) and may not do anything else.
 *  3. Observable behavior is unchanged (D14): same terminal status, same
 *     terminal reason, and `records_emitted` is never revised down.
 *
 * Point 3 is why this is a formalization rather than a rewrite. The reasons
 * (`controller_terminated_before_run_finished` /
 * `controller_terminated_while_awaiting_owner_interaction`) and the
 * `abandoned` status are preserved exactly; only the fence is added.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAdjudicationStatement, evaluateTransition, legalTargetsFrom } from "../runtime/run-lifecycle.ts";
import { NON_TERMINAL_RUN_STATES, RUN_STATES, TERMINAL_RUN_STATES } from "../runtime/run-lifecycle-states.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  type RunLifecycleBackend,
  readRun,
  resetRuns,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const REFERENCE_IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A hand-written abandon UPDATE's opening shape. Hoisted per Biome's rule. */
const HAND_WRITTEN_UPDATE = /UPDATE run_history\s+SET status/u;
/** The same shape, matched greedily through its `status = 'running'` fence. */
const HAND_WRITTEN_ABANDON_UPDATE = /UPDATE run_history\s+SET status =[\s\S]*?AND status = 'running'/gu;
/** Distinguishes an abandon write from the terminal drift repair. */
const ABANDON_WRITE = /abandoned/iu;
const CURRENT_EPOCH = "epoch-current-2026-08-21T12:00:00.000Z";
const RETIRED_EPOCH = "epoch-retired-2026-08-20T00:00:00.000Z";
const ABANDONED_AT_BOOT_REASON = "controller_terminated_before_run_finished";

/**
 * Every abandon-projecting FUNCTION, named individually.
 *
 * Per-function rather than per-file, and that distinction is not cosmetic —
 * a file-level check let a real mutant survive during development. Reverting
 * ONLY the SQLite projection to its old hand-written UPDATE kept the file
 * passing, because the PostgreSQL projection still imported the builder and
 * satisfied a file-wide `source.includes(...)`. Two mechanisms masked each
 * other, which is the same shape as the two mutants that survived tranche 1
 * and the same shape as the reconciler pair whose defects hid each other.
 *
 * There are three abandon projections across two files, and every one of
 * them has to be checked where it lives.
 */
const ABANDON_PROJECTIONS: readonly { declaration: string; file: string; label: string }[] = [
  {
    declaration: "async function projectAbandonedRunHistoryPostgres(",
    file: "lib/controller-boot.ts",
    label: "boot reconciler (postgres)",
  },
  {
    declaration: "function projectAbandonedRunHistorySqlite(",
    file: "lib/controller-boot.ts",
    label: "boot reconciler (sqlite)",
  },
  {
    declaration: "export async function adjudicateOrphans(",
    file: "scripts/repair/adjudicate-orphaned-runs.ts",
    label: "operator repair script",
  },
];

/**
 * Extract a function BODY by brace matching, so each assertion is local to
 * one function.
 *
 * The parameter list is skipped by walking the declaration's parentheses to
 * their close first. Naively taking the first `{` after the declaration finds
 * the DESTRUCTURED PARAMETER OBJECT on a signature like
 * `adjudicateOrphans({ pool, rows, apply })` — I hit exactly that while
 * writing this file, and it extracted a 46-character "body" that of course
 * contained no builder call, reporting a failure that was entirely the
 * oracle's own bug. An oracle that can fail for a reason unrelated to the
 * property it tests is worse than no oracle.
 */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find: ${declaration}`);
  // Walk the parameter list to its closing paren.
  const parenOpen = source.indexOf("(", start);
  let parenDepth = 0;
  let cursor = parenOpen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") {
      parenDepth += 1;
    } else if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        break;
      }
    }
  }
  const open = source.indexOf("{", cursor);
  assert.notEqual(open, -1, `no body brace after the parameter list of: ${declaration}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces: ${declaration}`);
}

const ADJUDICATING_WRITERS: readonly { file: string; label: string }[] = [
  { file: "lib/controller-boot.ts", label: "boot reconciler" },
  { file: "scripts/repair/adjudicate-orphaned-runs.ts", label: "operator repair script" },
];

test("D6: every abandon projection renders its UPDATE from the machine", () => {
  for (const projection of ABANDON_PROJECTIONS) {
    const source = readFileSync(join(REFERENCE_IMPL_DIR, projection.file), "utf8");
    const body = bodyOf(source, projection.declaration);
    assert.ok(
      body.includes("buildAdjudicationStatement("),
      `${projection.label} (${projection.file}) must render its abandon projection from ` +
        "buildAdjudicationStatement rather than hand-writing an UPDATE. Checked inside " +
        "the function body, not file-wide: a sibling projection that still uses the " +
        "builder would otherwise mask this one."
    );
    assert.ok(
      !HAND_WRITTEN_UPDATE.test(body),
      `${projection.label} still contains a hand-written UPDATE. The old path must be ` +
        "DELETED in the same change that adds the new one (D5), never left beside it."
    );
  }
});

test("D6: no adjudicating writer hand-writes an unfenced ABANDON UPDATE", () => {
  // The companion to the check above. Importing the builder while ALSO
  // keeping the old statement would satisfy the previous assertion and leave
  // the parallel writer in place, which is precisely what D5 forbids.
  //
  // Scope note, and it is a real distinction rather than a convenience: this
  // targets statements that write the ABANDONED status specifically. The
  // terminal DRIFT REPAIR in lib/controller-boot.ts also issues
  // `UPDATE run_history SET status = ... AND status = 'running'`, and it is
  // deliberately NOT cut over.
  //
  // Drift repair is not adjudication. It copies an ALREADY-TERMINAL spine
  // event onto a projection that still says `running`, adopting that event's
  // own status — which may be `succeeded`, `failed`, `cancelled`, or
  // `surface_failed`. `buildAdjudicationStatement` hardcodes `abandoned` by
  // construction, so routing drift repair through it would overwrite a
  // succeeded run's projection with `abandoned`: a data-corrupting change
  // wearing a refactor's clothes. It also has no epoch to claim; the
  // authority it defers to is the terminal event, not a boot identity.
  //
  // The `status = 'abandoned'` filter below is what keeps this assertion
  // honest about that difference instead of matching every UPDATE shaped
  // vaguely like the one it cares about.
  for (const writer of ADJUDICATING_WRITERS) {
    const source = readFileSync(join(REFERENCE_IMPL_DIR, writer.file), "utf8");
    const matches = source.match(HAND_WRITTEN_ABANDON_UPDATE) ?? [];
    const unfencedAbandons = matches.filter(
      (statement) => ABANDON_WRITE.test(statement) && !statement.includes("owner_epoch")
    );
    assert.deepEqual(
      unfencedAbandons,
      [],
      `${writer.label} (${writer.file}) still contains ${unfencedAbandons.length} hand-written ` +
        "abandon UPDATE(s) with no owner_epoch fence. The old path must be DELETED in " +
        "the same change that adds the new one (D5), never left beside it."
    );
  }
});

test("D6: abandoning is a legal transition for the boot adjudicator, and nothing else is", () => {
  for (const from of NON_TERMINAL_RUN_STATES) {
    assert.deepEqual(
      legalTargetsFrom(from, "boot_adjudicator"),
      ["abandoned"],
      `the boot adjudicator's ONLY legal move from ${from} is to abandoned (T10/T11)`
    );
  }
  // F4: the boot path may not record an interrupted run as `failed`.
  // Interruption is not observed failure and the two carry different
  // remedies — of 134 production runs recorded as failed/controller_restarted,
  // 55 had staged a cursor and 34 had durably ingested a batch.
  const decision = evaluateTransition({ actor: "boot_adjudicator", from: "running", to: "failed" });
  assert.equal(decision.legal, false);
  assert.equal(
    decision.legal === false ? decision.reason : null,
    "actor_may_not_perform_transition",
    "refusing for the RIGHT reason: the transition exists, this actor may not perform it"
  );

  for (const from of TERMINAL_RUN_STATES) {
    assert.deepEqual(
      legalTargetsFrom(from, "boot_adjudicator"),
      [],
      `terminal means terminal: nothing is reachable from ${from}`
    );
  }
});

function defineBackendCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`D6: adjudication preserves observable behavior [${label}]`, async (t) => {
    const backend = await makeBackend();
    const dialect = backend.name === "postgres" ? "postgres" : "sqlite";
    try {
      await t.test("an orphan becomes abandoned with the boot reason, keeping its yield", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_orphan",
          ownerEpoch: RETIRED_EPOCH,
          runId: "run_orphan",
          status: "running",
        });

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T13:00:00.000Z",
            connectorInstanceId: "cin_orphan",
            expectedState: "running",
            myEpoch: CURRENT_EPOCH,
            runId: "run_orphan",
            terminalReason: ABANDONED_AT_BOOT_REASON,
          },
          dialect
        );
        assert.equal(await backend.exec(statement.sql, statement.params), 1);

        const after = await readRun(backend, "run_orphan", "cin_orphan");
        assert.equal(after?.status, "abandoned", "same terminal status as the hand-written projection");
        assert.equal(after?.owner_epoch, CURRENT_EPOCH, "and the adjudicator claims the row");
        // The behavior-preservation clause that matters most: records
        // durably ingested before the interruption stay committed. An
        // abandon must never rewrite a committed yield down to zero.
        // `seedRun` seeds 7; the assertion is that adjudication left it
        // alone, which is why `records_emitted` is absent from the
        // statement's SET list.
        assert.equal(after?.records_emitted, 7, "an abandon must never revise records_emitted down");
      });

      await t.test("a live run in the CURRENT epoch is never adjudicated", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_live",
          ownerEpoch: CURRENT_EPOCH,
          runId: "run_live",
          status: "running",
        });

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T13:00:00.000Z",
            connectorInstanceId: "cin_live",
            expectedState: "running",
            myEpoch: CURRENT_EPOCH,
            runId: "run_live",
            terminalReason: ABANDONED_AT_BOOT_REASON,
          },
          dialect
        );
        assert.equal(
          await backend.exec(statement.sql, statement.params),
          0,
          "eligibility is decided by epoch comparison; live work must survive its own boot"
        );
        const after = await readRun(backend, "run_live", "cin_live");
        assert.equal(after?.status, "running");
      });

      await t.test("adjudication is idempotent: a second pass claims nothing", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_twice",
          ownerEpoch: RETIRED_EPOCH,
          runId: "run_twice",
          status: "running",
        });
        const build = () =>
          buildAdjudicationStatement(
            {
              completedAt: "2026-08-21T13:00:00.000Z",
              connectorInstanceId: "cin_twice",
              expectedState: "running",
              myEpoch: CURRENT_EPOCH,
              runId: "run_twice",
              terminalReason: ABANDONED_AT_BOOT_REASON,
            },
            dialect
          );
        const first = build();
        assert.equal(await backend.exec(first.sql, first.params), 1);
        const second = build();
        assert.equal(
          await backend.exec(second.sql, second.params),
          0,
          "the row is no longer `running` and now carries the adjudicator's own epoch"
        );
      });
    } finally {
      await backend.teardown();
    }
  });
}

defineBackendCases(createSqliteBackend, "sqlite");

if (POSTGRES_URL) {
  const url = POSTGRES_URL;
  defineBackendCases(() => createPostgresBackend(url), "postgres");
} else {
  test("D6: adjudication preserves observable behavior [postgres]", {
    skip: "PDPP_TEST_POSTGRES_URL not configured",
  }, () => {
    // Skipped rather than absent: a single-backend pass is a failure.
  });
}

test("D6: the state set has no member outside the declared nine", () => {
  assert.equal(RUN_STATES.length, 9);
  assert.ok(TERMINAL_RUN_STATES.has("abandoned"), "abandoned is terminal and distinct from failed");
  assert.ok(!TERMINAL_RUN_STATES.has("running"));
});
