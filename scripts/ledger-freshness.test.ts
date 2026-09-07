#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the ledger freshness checker: row splitting, reference
// extraction with repo attribution, status classification, the disagreement
// rules, and the offline behaviour of the resolver.
//
// The offline tests exist because a green suite over the pure parts once hid a
// real defect in the resolver: `--offline` skipped `ls-remote`, then reported a
// branch as "absent from origin" and quoted the skipped command as proof. A
// checker that invents evidence is worse than one that says nothing, so the
// rule is now tested directly — offline never concludes remote absence, and
// never prints a command it did not run.
//
// Run: node --test scripts/ledger-freshness.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyStatus,
  disagrees,
  extractReferences,
  parseLedger,
  parseRow,
  resolve,
  type LedgerRow,
  type Reference,
  type Resolution,
} from "./ledger-freshness.ts";

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    line: 1,
    num: "1",
    date: "08-30",
    text: "a commitment",
    status: "OPEN",
    statusAndEvidence: "OPEN | evidence",
    ...overrides,
  };
}

function resolution(
  over: Omit<Partial<Resolution>, "ref"> & { ref?: Partial<Reference> } = {},
): Resolution {
  const { ref: refOver, ...rest } = over;
  const ref: Reference = {
    kind: "pr-or-issue",
    raw: "#1",
    value: "1",
    candidates: ["PDP-Connect/pdpp"],
    attribution: "test",
    ...refOver,
  };
  return { ref, state: "OPEN", detail: "", command: "", ...rest };
}

describe("parseRow", () => {
  it("splits a well-formed row", () => {
    const parsed = parseRow("| 7 | 08-30 | do the thing | OPEN | lane-x |", 12);
    assert.equal(parsed?.num, "7");
    assert.equal(parsed?.date, "08-30");
    assert.equal(parsed?.text, "do the thing");
    assert.equal(parsed?.status, "OPEN");
    assert.equal(parsed?.line, 12);
  });

  it("keeps pipes that appear inside the evidence cell", () => {
    // Splitting from the right would put "b" in the status column.
    const parsed = parseRow("| 7 | 08-30 | thing | DONE | a | b |", 1);
    assert.equal(parsed?.status, "DONE");
    assert.match(parsed?.statusAndEvidence ?? "", /a \| b/);
  });

  it("tolerates a row with no evidence cell", () => {
    const parsed = parseRow("| 9 | 09-01 | thing | OPEN |", 1);
    assert.equal(parsed?.status, "OPEN");
  });

  it("ignores non-rows", () => {
    assert.equal(parseRow("| # | Date | Commitment | Status | Evidence |", 1), null);
    assert.equal(parseRow("Rules: every agreement gets a row", 1), null);
    assert.equal(parseRow("|---|------|---|---|---|", 1), null);
  });

  it("keys rows by line, because row numbers repeat in the real ledger", () => {
    const rows = parseLedger("| 58 | a | x | OPEN | e |\n| 58 | b | y | DONE | e |");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.line),
      [1, 2],
    );
  });
});

describe("extractReferences", () => {
  it("attributes a number to the repo named nearest to its left", () => {
    const refs = extractReferences(
      row({
        text: "#238 signed off",
        statusAndEvidence: "MERGED | #238 merged; data-connect#36 merged as `b70dda89a`",
      }),
    );
    const pr238 = refs.find((r) => r.raw === "#238");
    const pr36 = refs.find((r) => r.raw === "#36");
    assert.deepEqual(pr36?.candidates, ["PDP-Connect/data-connect"]);
    // #238 must NOT inherit data-connect from a mention that follows it.
    assert.notDeepEqual(pr238?.candidates, ["PDP-Connect/data-connect"]);
  });

  it("marks a bare number ambiguous when the row names no repo", () => {
    const refs = extractReferences(
      row({ text: "close out #42", statusAndEvidence: "OPEN | nobody driving it" }),
    );
    const ref = refs.find((r) => r.raw === "#42");
    assert.equal(ref?.candidates.length, 3);
  });

  it("finds branches backticked and bare, and skips file paths", () => {
    const refs = extractReferences(
      row({
        text: "fix on `waspflow/gmail-connect-retry-0813`",
        statusAndEvidence: "OPEN | see docs/registers.md and fix/webpush-urgency-high",
      }),
    );
    const branches = refs.filter((r) => r.kind === "branch").map((r) => r.raw);
    assert.ok(branches.includes("waspflow/gmail-connect-retry-0813"));
    assert.ok(branches.includes("fix/webpush-urgency-high"));
    assert.ok(!branches.includes("docs/registers.md"));
  });

  it("takes shas only from backticks, so prose numbers are not probed", () => {
    const refs = extractReferences(
      row({
        text: "landed",
        statusAndEvidence: "DONE | commit `a932674f8`; container started 20260831 at 1930",
      }),
    );
    const shas = refs.filter((r) => r.kind === "sha").map((r) => r.raw);
    assert.deepEqual(shas, ["a932674f8"]);
  });

  it("does not emit the same reference twice", () => {
    const refs = extractReferences(
      row({ text: "#50 and #50 again", statusAndEvidence: "OPEN | still #50" }),
    );
    assert.equal(refs.filter((r) => r.raw === "#50").length, 1);
  });

  it("keeps the qualified and unqualified readings of one number apart", () => {
    // "#50 ... pdpp #50" is genuinely two claims: an unattributed mention and a
    // pdpp-qualified one. Collapsing them would silently adopt the qualifier.
    const refs = extractReferences(
      row({ text: "#50 is stuck", statusAndEvidence: "OPEN | pdpp #50 reviewed" }),
    );
    const fifties = refs.filter((r) => r.raw === "#50");
    assert.equal(fifties.length, 2);
    assert.ok(fifties.some((r) => r.candidates.length === 1));
    assert.ok(fifties.some((r) => r.candidates.length === 3));
  });
});

describe("classifyStatus", () => {
  it("reads the claim a reader would take from the prose", () => {
    assert.equal(classifyStatus("OPEN"), "open");
    assert.equal(classifyStatus("UNACCOUNTED"), "open");
    assert.equal(classifyStatus("DONE"), "done");
    assert.equal(classifyStatus("CLOSED (lean-in)"), "done");
  });

  it("lets a leading completion word govern a trailing caveat", () => {
    // The row asserts the merge and defers only the deploy. Reading it as open
    // would flag the merged PR it cites as contradicting itself.
    assert.equal(classifyStatus("MERGED — deploy still pending"), "done");
    assert.equal(classifyStatus("GATE CLEARED, still OPEN"), "done");
    // ...but a caveat that comes first still governs.
    assert.equal(classifyStatus("DONE-PENDING-RATIFY"), "done");
    assert.equal(classifyStatus("blocked on the merged upstream"), "open");
  });

  it("treats a row that has already been marked stale as acknowledged", () => {
    assert.equal(classifyStatus("STALE"), "acknowledged-stale");
  });

  it("treats a pushed-but-not-merged claim as its own thing", () => {
    // This row shape is why: "UNACCOUNTED — pushed, no PR" asserts a live
    // branch, so a missing branch is a contradiction even though it reads open.
    assert.equal(classifyStatus("UNACCOUNTED — pushed, no PR"), "pushed");
  });
});

describe("disagrees", () => {
  it("flags an open row whose PR is merged", () => {
    const why = disagrees(row({ status: "OPEN" }), resolution({ state: "MERGED" }));
    assert.match(why ?? "", /MERGED/);
  });

  it("flags a pushed row whose branch is gone", () => {
    const why = disagrees(
      row({ status: "UNACCOUNTED — pushed, no PR" }),
      resolution({ state: "ABSENT", ref: { kind: "branch", raw: "waspflow/x" } }),
    );
    assert.match(why ?? "", /absent from the remote/);
  });

  it("flags a done row whose PR is still a draft", () => {
    const why = disagrees(row({ status: "DONE" }), resolution({ state: "DRAFT" }));
    assert.match(why ?? "", /DRAFT/);
  });

  it("flags a commit whose files shipped on another repo's main", () => {
    const why = disagrees(
      row({ status: "UNACCOUNTED" }),
      resolution({ state: "SUPERSEDED-ELSEWHERE", ref: { kind: "sha", raw: "304e70222" } }),
    );
    assert.match(why ?? "", /tracking a location the work has left/);
  });

  it("stays quiet when the ledger is right", () => {
    assert.equal(disagrees(row({ status: "OPEN" }), resolution({ state: "OPEN" })), null);
    assert.equal(disagrees(row({ status: "DONE" }), resolution({ state: "MERGED" })), null);
    assert.equal(
      disagrees(
        row({ status: "UNACCOUNTED — pushed, no PR" }),
        resolution({ state: "ON-REMOTE", ref: { kind: "branch", raw: "waspflow/x" } }),
      ),
      null,
    );
  });

  it("flags a supersession regardless of what the row claims", () => {
    // The location signal does not depend on the status wording: a row still
    // pointing at a commit the work has left is mis-filed whether it reads
    // OPEN, DONE, or STALE.
    for (const status of ["OPEN", "DONE", "STALE", "UNACCOUNTED — pushed, no PR"]) {
      const why = disagrees(
        row({ status }),
        resolution({ state: "SUPERSEDED-ELSEWHERE", ref: { kind: "sha", raw: "a932674f8" } }),
      );
      assert.match(why ?? "", /tracking a location the work has left/, status);
    }
  });

  it("never guesses from an unresolvable reference", () => {
    assert.equal(disagrees(row({ status: "OPEN" }), resolution({ state: "UNKNOWN" })), null);
  });

  it("reports an uncheckable citation as a finding in its own right", () => {
    const why = disagrees(row({ status: "OPEN" }), resolution({ state: "AMBIGUOUS" }));
    assert.match(why ?? "", /cannot be checked/);
  });
});

describe("resolve --offline", () => {
  const offline = { offline: true };

  function branchRef(value: string, candidates = ["PDP-Connect/pdpp"]): Reference {
    return { kind: "branch", raw: value, value, candidates, attribution: "test" };
  }

  it("never concludes remote absence for a branch that exists only locally", async () => {
    // `tools/ledger-freshness` is local-only in pdpp: the exact shape that used
    // to produce "absent from origin" without ever asking origin.
    const res = await resolve(branchRef("tools/ledger-freshness"), offline);
    assert.equal(res.state, "UNKNOWN");
    assert.doesNotMatch(res.detail, /\babsent\b/i);
    assert.match(res.detail, /NOT checked \(--offline\)/);
  });

  it("never quotes a command it did not run", async () => {
    const res = await resolve(branchRef("tools/ledger-freshness"), offline);
    // ls-remote is the network call offline skips; it must not appear as proof.
    assert.doesNotMatch(res.command, /ls-remote/);
    assert.doesNotMatch(res.command, /\(empty\)/);
  });

  it("does not manufacture a pushed-vs-local disagreement offline", async () => {
    const res = await resolve(branchRef("tools/ledger-freshness"), offline);
    const why = disagrees(row({ status: "PUSHED" }), res);
    assert.equal(why, null);
  });

  it("stays UNKNOWN for a branch missing everywhere, rather than ABSENT", async () => {
    // Unattributed, so it goes through the multi-repo narrowing path.
    const res = await resolve(
      branchRef("waspflow/no-such-branch-ever-0907", [
        "PDP-Connect/pdpp",
        "PDP-Connect/data-connect",
        "PDP-Connect/data-connectors",
      ]),
      offline,
    );
    assert.equal(res.state, "UNKNOWN");
    assert.doesNotMatch(res.command, /ls-remote/);
    assert.equal(disagrees(row({ status: "UNACCOUNTED — pushed, no PR" }), res), null);
  });

  it("reports a PR as unchecked, with no gh command as proof", async () => {
    const res = await resolve(
      { kind: "pr-or-issue", raw: "#9", value: "9", candidates: ["PDP-Connect/pdpp"], attribution: "test" },
      offline,
    );
    assert.equal(res.state, "UNKNOWN");
    assert.equal(res.command, "");
    assert.equal(disagrees(row({ status: "OPEN" }), res), null);
  });

  it("still resolves a sha offline, because that needs no network", async () => {
    // origin/main's own tip is reachable from origin/main by definition.
    const res = await resolve(
      { kind: "sha", raw: "7acd4bac24", value: "7acd4bac24", candidates: ["PDP-Connect/pdpp"], attribution: "test" },
      offline,
    );
    assert.equal(res.state, "IN-MAIN");
    assert.match(res.command, /merge-base --is-ancestor/);
  });
});
