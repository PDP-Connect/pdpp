// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for forbidden transitions F7 (no transition out of a terminal
 * state) and F5 (no second terminal transition), from design.md (b).
 *
 * Property: after any generated sequence of transition attempts, the run's
 *   observed state is reachable from its initial state by LEGAL transitions
 *   alone, and a terminal state is never left.
 * Generator: random sequences drawn from the full (state x transition)
 *   cross-product, including transitions that are illegal from the current
 *   state. Length 1-20. Seeded and reported on failure so a counterexample is
 *   reproducible.
 * Invariant: the reachable-state check above, plus: the count of terminal
 *   transitions that reported success is at most 1 per run.
 *
 * The legal-transition table is read from the owner module's own declaration,
 * never from a literal copied into this file. A test carrying its own copy of
 * the table stops being able to catch a table change — which is the same
 * defect class (a second declaration that drifts) the module exists to close.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTransition,
  LEGAL_TRANSITIONS,
  legalTargetsFrom,
  type TransitionActor,
} from "../runtime/run-lifecycle.ts";
import { isTerminalRunState, RUN_STATES, type RunState } from "../runtime/run-lifecycle-states.ts";

/**
 * A deterministic PRNG so a failure is reproducible from its seed. Reporting
 * "a random sequence failed" without the seed is not a counterexample.
 */
const LCG_MODULUS = 4_294_967_296;

function makeRandom(seed: number): () => number {
  // Arithmetic rather than bitwise so the state stays a positive integer
  // below 2^32 without relying on `>>> 0` coercion.
  let state = Math.abs(Math.trunc(seed)) % LCG_MODULUS;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % LCG_MODULUS;
    return state / LCG_MODULUS;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) {
    throw new Error("pick from empty list");
  }
  return value;
}

const ACTORS: readonly TransitionActor[] = ["executor", "boot_adjudicator", "planner"];

/**
 * Apply an attempt the way the machine would: a legal attempt moves the
 * state, an illegal one leaves it untouched. This mirrors the CAS outcome
 * (`committed` vs `refused`) without a database, so legality is tested
 * independently of storage.
 */
function applyAttempt(
  state: RunState,
  attempt: { actor: TransitionActor; to: RunState }
): { state: RunState; committed: boolean } {
  const decision = evaluateTransition({ actor: attempt.actor, from: state, to: attempt.to });
  return decision.legal ? { committed: true, state: attempt.to } : { committed: false, state };
}

test("run lifecycle: transition legality", async (t) => {
  await t.test("a generated attempt sequence leaves the run in a legally reachable state", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = makeRandom(seed);
      let state: RunState = "pending";
      const path: RunState[] = [state];
      const length = 1 + Math.floor(random() * 20);

      for (let step = 0; step < length; step += 1) {
        const attempt = { actor: pick(random, ACTORS), to: pick(random, RUN_STATES) };
        const { committed, state: next } = applyAttempt(state, attempt);
        if (committed) {
          path.push(next);
        }
        state = next;
      }

      // Every state actually entered must have been reachable by a legal
      // transition from its predecessor.
      for (let index = 1; index < path.length; index += 1) {
        const from = path[index - 1] as RunState;
        const to = path[index] as RunState;
        assert.ok(
          legalTargetsFrom(from, "executor").includes(to) || legalTargetsFrom(from, "boot_adjudicator").includes(to),
          `seed ${seed}: reached ${to} from ${from}, which no legal transition permits (path ${path.join(" -> ")})`
        );
      }

      // Once terminal, the path must end. A terminal state appearing anywhere
      // but last means something left it.
      const terminalIndex = path.findIndex((entry) => isTerminalRunState(entry));
      if (terminalIndex !== -1) {
        assert.equal(
          terminalIndex,
          path.length - 1,
          `seed ${seed}: left terminal state ${path[terminalIndex]} (path ${path.join(" -> ")})`
        );
      }
    }
  });

  await t.test("no transition succeeds out of a terminal state (F7)", () => {
    const terminals = RUN_STATES.filter((state) => isTerminalRunState(state));
    assert.ok(terminals.length > 0, "the terminal subset must not be empty");

    for (const from of terminals) {
      for (const to of RUN_STATES) {
        for (const actor of ACTORS) {
          const decision = evaluateTransition({ actor, from, to });
          assert.equal(
            decision.legal,
            false,
            `${actor} was permitted ${from} -> ${to}; terminal states have no outgoing transitions`
          );
        }
      }
    }
  });

  /*
   * F7 is provided by two independent mechanisms: the table names no terminal
   * state as a source, AND `evaluateTransition` refuses a terminal source
   * outright. Asserting only the observable outcome cannot tell them apart,
   * so each masks a defect in the other -- verified: disabling the guard and,
   * separately, adding `succeeded` as a legal source for T7 BOTH left the
   * outcome-only assertion green. The next two cases pin each mechanism
   * separately so neither can rot behind the other.
   */

  await t.test("F7 mechanism 1: no table rule names a terminal state as a source", () => {
    for (const rule of LEGAL_TRANSITIONS) {
      for (const from of rule.from) {
        assert.equal(
          isTerminalRunState(from),
          false,
          `${rule.id} names terminal state ${from} as a legal source; terminal means terminal`
        );
      }
    }
  });

  await t.test("F7 mechanism 2: the terminal guard is what refuses, by reason", () => {
    // Asserting the REASON is what makes this independent of the table. If
    // the guard were removed, a terminal source would fall through to the
    // table lookup and be refused as `illegal_transition` instead -- a
    // refusal for the wrong reason, which this catches and an
    // outcome-only assertion cannot.
    for (const from of RUN_STATES.filter((state) => isTerminalRunState(state))) {
      for (const to of RUN_STATES) {
        const decision = evaluateTransition({ actor: "executor", from, to });
        assert.equal(decision.legal, false, `executor was permitted ${from} -> ${to}`);
        assert.equal(
          decision.legal === false ? decision.reason : null,
          "run_already_terminal",
          `${from} -> ${to} must be refused BY THE TERMINAL GUARD, not incidentally by the table`
        );
      }
    }
  });

  await t.test("at most one terminal transition succeeds per run (F5)", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = makeRandom(seed * 7919);
      let state: RunState = "running";
      let terminalCommits = 0;

      for (let step = 0; step < 12; step += 1) {
        const to = pick(
          random,
          RUN_STATES.filter((candidate) => isTerminalRunState(candidate))
        );
        const { committed, state: next } = applyAttempt(state, { actor: pick(random, ACTORS), to });
        if (committed) {
          terminalCommits += 1;
        }
        state = next;
      }

      assert.ok(
        terminalCommits <= 1,
        `seed ${seed}: ${terminalCommits} terminal transitions committed; at most 1 is permitted`
      );
      if (terminalCommits === 1) {
        assert.ok(isTerminalRunState(state), `seed ${seed}: committed a terminal but ended at ${state}`);
      }
    }
  });

  await t.test("the state set is closed: no attempt produces a state outside the declared set", () => {
    // Guards against a writer inventing a status string. There is no CHECK
    // constraint on run_history.status, so nothing at the database layer
    // prevents it — the closed set is the only thing that does.
    for (const rule of LEGAL_TRANSITIONS) {
      assert.ok(
        (RUN_STATES as readonly string[]).includes(rule.to),
        `${rule.id} targets ${rule.to}, which is not a declared run state`
      );
      for (const from of rule.from) {
        assert.ok(
          (RUN_STATES as readonly string[]).includes(from),
          `${rule.id} sources ${from}, which is not a declared run state`
        );
      }
    }

    for (let seed = 1; seed <= 200; seed += 1) {
      const random = makeRandom(seed * 104_729);
      let state: RunState = "pending";
      for (let step = 0; step < 15; step += 1) {
        const { state: next } = applyAttempt(state, {
          actor: pick(random, ACTORS),
          to: pick(random, RUN_STATES),
        });
        state = next;
        assert.ok(
          (RUN_STATES as readonly string[]).includes(state),
          `seed ${seed}: produced ${state}, outside the declared set`
        );
      }
    }
  });

  await t.test("the planner owns no transition in the table (F1)", () => {
    for (const rule of LEGAL_TRANSITIONS) {
      assert.notEqual(
        rule.actor as string,
        "planner",
        `${rule.id} names the planner as a writer; the planner emits intents and never writes run state`
      );
    }
    // And the decision function agrees, for every pair in the cross-product.
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        assert.equal(
          evaluateTransition({ actor: "planner", from, to }).legal,
          false,
          `planner was permitted ${from} -> ${to}`
        );
      }
    }
  });

  await t.test("F1 is refused by the planner guard itself, by reason", () => {
    // Same masking hazard as F7: the planner is ALSO excluded from the table
    // by `TransitionRule.actor`, so deleting the runtime guard leaves the
    // outcome unchanged and an outcome-only assertion green (verified). The
    // reason distinguishes "the planner may not write" from "no rule matched",
    // which matters because a future rule whose actor is widened must not
    // silently hand the planner a write path.
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        const decision = evaluateTransition({ actor: "planner", from, to });
        assert.equal(
          decision.legal === false ? decision.reason : null,
          "actor_may_not_write",
          `planner ${from} -> ${to} must be refused BY THE PLANNER GUARD, not incidentally by the table`
        );
      }
    }
  });
});
