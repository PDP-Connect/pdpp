# What a source's state should tell its owner

**Status:** intake. Terminal model proposed, not owner-ratified. One case
implemented as proof; the rest is unbuilt.
**Date:** 2026-08-18

## The evidence

The owner's goal is every source green, honestly — green only if genuinely
collecting, never by loosening a condition. Today `/sources` shows 23 sources in
five display states, and four of the five lie in a way the owner can catch:

| shown | reality |
|---|---|
| `○ Not measured · Fresh today` | claude-code holds 2,408,082 records and is collecting right now |
| `○ Not measured · Freshness has not been measured yet` | Google Maps Timeline Import holds 299,248 records; the import finished and will never run again |
| `◐ Needs refresh · Review: Resume schedule` | Chase is fine; an operator disabled its schedule to stop an OTP loop |
| `⊘ Can't collect` + `Last successful refresh today` + 2,129 records | USAA, all three simultaneously true |

Verified in production today:

```
claude-code  local_device  2408082  stale     (3 instances: 2.4M, 38k, 20k)
codex        local_device  1299535  fresh
google-maps  manual         299248  fresh
whatsapp     manual         120042  fresh
usaa         account          2129  fresh
```

Both `manual` sources have **zero rows in `run_history` and zero schedules**.
There is nothing to run, and nothing that will ever run.

The four failures have one shape. `isHealthyConditionSet`
(`reference-implementation/runtime/connection-health.ts:1755`) collapses ten
conditions to one boolean, and it requires three of them to be affirmatively
`true`:

```
CollectionSucceeded === true
SourceCoverageComplete === true
Fresh === true
```

Three of those ten are also required *not* to be `false`, and `BacklogClear`
must not be `error`. The predicate has exactly one caller, `classifyHealthy`,
the last of fourteen ordered classification steps.

The collapse is not the bug by itself. The bug is that the predicate cannot
distinguish **"we don't know"** from **"the question doesn't apply here"**, so
it treats both as not-green. A finished import can never produce a freshness
proof, so it can never be green, no matter what the owner does.

## What the code already knows

This codebase already diagnosed this problem and solved it one layer too high.
`ConnectionConditionStatus` (`connection-health.ts:107`) has four values, and
the doc comment on the fourth is worth quoting:

> `not_applicable` : the condition cannot apply to this connection at all,
> because the evidence source it reads does not exist here. This is a *settled*
> answer, not a pending one.
>
> `not_applicable` exists so the projection stops encoding certainty as doubt.

And then, three lines later:

> Classification treats `not_applicable` exactly as it treated the `unknown` it
> replaces: it is never `true` and never `false`, so no headline state, axis, or
> healthy-set predicate changes. **Only presentation changes.**

That last sentence is the decision to revisit. The concept is right and already
shipped; it was deliberately confined to cosmetics. Making it load-bearing in
the healthy predicate is a smaller change than inventing anything new.

Two more pieces already exist:

- **`source_kind`** is a real column with a CHECK constraint over `account`,
  `local_device`, `browser_collector`, `manual`
  (`server/postgres-storage.ts:885`). The two "never measured" sources are
  exactly the two rows with `source_kind = 'manual'`. The manifest already
  carries enough to decide this — nothing new needs to be declared.
- **`COVERAGE_UNKNOWN_STALE_COLLECTOR`** (`connection-health.ts:2716`) already
  says *"This local collector build predates coverage evidence the server now
  requires. Update the collector."* That is the honest sentence for the 2.4M-record
  case. It exists, it is correct, and the sources list does not show it.

## The dimensions, derived from the incidents

Not a taxonomy invented for symmetry — each of these is a distinct axis because
a real source varies on it independently of the others.

1. **Is data arriving?** claude-code: yes, 2.4M records. Independent of whether
   we can prove anything about it.
2. **Is coverage provable?** Separate from (1). The stale collector emits data
   but not the stores that prove coverage. Data flowing and proof complete are
   genuinely orthogonal — that pair is the whole "Not measured · Fresh today"
   contradiction.
3. **Is currency meaningful, and if so, is it current?** Two questions, and the
   model only asks the second. For a finished import the first answer is *no*,
   which makes the second a category error.
4. **Who can resolve the blocker?** Connector maintainer, owner, operator, or
   external provider. USAA's detail page says "Connector code needs a fix"; the
   list says "Can't collect". The useful sentence is the one not shown.
5. **Is this source finished by design?** No state expresses it. There is no
   terminal state at all.

## Is a single green/not-green verdict the right shape?

**Yes — keep the boolean, and fix which conditions are required versus
inapplicable per source.** I considered the alternatives seriously.

**Two-axis (data-flowing × proof-complete)** describes the claude-code case
exactly, and it is the model I most wanted to adopt. I rejected it because it
does not generalize: it has nothing to say about the operator-paused case or
the provider-down case, so those would need a third and fourth axis, and the
owner would be reading a vector. The owner's stated goal is *every source
green*. A goal phrased as a scalar needs a scalar answer.

**A state machine with a terminal Archived/Complete state** is the wrong
primitive because completeness is not a state a source *transitions* into
through the health pipeline — it is a property of the source's kind, known at
creation. Google Maps Timeline Import was complete the moment its import
finished. Modeling it as a reachable state implies a transition that never
fires, and this codebase has already been bitten by exactly that: the
`terminal_facts_historical` exclusion in
`summary-evidence-projection-controller-2026-08-18.md` stranded three
production rows behind an exit condition that was unreachable by construction.

**Keeping the boolean, fixing the required set** wins because the boolean was
never actually the problem. The problem is that "required" is currently a fixed
list of ten conditions applied uniformly to every source, when some conditions
are unanswerable for some source kinds. Green should mean *every condition that
applies to this source is satisfied* — which is what the owner already thinks it
means.

**What it costs.** The predicate stops being a fixed list, so reading it no
longer tells you the whole rule; you must also know which conditions the source
kind marks inapplicable. That is real complexity and I am not going to pretend
otherwise. The mitigation is that inapplicability is derived from `source_kind`
and the manifest — both durable, both already there — rather than from
per-source configuration an operator can get wrong. The failure mode to guard
is a condition marked inapplicable when it is merely unproven, which would
manufacture exactly the false green the owner refuses to accept. Hence the rule
below.

### The rule

> A source is green when every condition that **applies** to it is satisfied.
> `not_applicable` is satisfaction. `unknown` is not.
>
> A condition may be marked `not_applicable` only from durable evidence that the
> question is meaningless for this source — never from the absence of an answer.

The second sentence is the entire safety property. "We couldn't measure it" and
"there is nothing to measure" must never collapse, or this design becomes the
loosening the owner rejected.

## The manual-import case

**Settled: `Fresh` is `not_applicable`, not `false` and not `unknown`, for a
source whose acquisition is complete.**

Not `true`. Claiming a finished 2023 WhatsApp export is "fresh" replaces one lie
with another. The honest statement is that freshness does not apply.

Coverage is deliberately **not** relaxed. A completed import must still prove it
ingested what it claimed. Unknown or gapped coverage keeps it out of green — the
completeness declaration buys exemption from a freshness proof only.

`source_kind = 'manual'` already carries this and is written at exactly one
place (`server/routes/ref-manual-upload-draft-connection.ts:687`). The health
input takes a new `acquisition: { complete: true }` evidence field rather than
reading `source_kind` directly, matching how every other signal reaches
`computeConnectionHealth` — the projection trusts caller-supplied evidence and
never reads storage itself.

## The operator-paused case

**Settled: this is already correct in the health model and wrong only in the
rendering. Do not touch the health model.**

`classifyOwnerPaused` (`connection-health.ts:1356`) runs third of fourteen
steps, before every failure classifier, and routes a disabled schedule to
`idle` — not `degraded`, not `blocked`. `isDegradingCondition` explicitly
excludes `ScheduleEligible`. The model already says an operator pause is not a
source defect.

The damage is done downstream: `idle` + disposition `owner_refresh_due` renders
the amber pill `"Needs refresh"` (`runtime/rendered-verdict.ts:432`), and the
console prefixes the CTA with a hardcoded `"Review: "`
(`apps/console/.../sources/sources-view.tsx:338`). Amber plus "Review" reads as a
defect for a source that has none.

The fix belongs in the pill vocabulary — an operator-paused source is not amber
— and I am explicitly not making it here, because `rendered-verdict.ts` is the
same file the actor vocabulary below would rewrite, and both should land
together.

## The actor vocabulary

"Can't collect" names no actor, so it cannot be acted on. Every state must name
who resolves it. All five derive from evidence that already exists:

| state | meaning | derived from |
|---|---|---|
| **Collecting** | green | the healthy predicate above |
| **Complete** | finished by design, final | `acquisition.complete` (from `source_kind = 'manual'`) |
| **Needs your login** | owner action | `CredentialsValid` false, `CREDENTIAL_REQUIRED` / `CREDENTIAL_REJECTED` |
| **Needs a collector upgrade** | owner action, distinct from the above | `COVERAGE_UNKNOWN_STALE_COLLECTOR` — exists today, unshown |
| **Needs a connector fix** | maintainer action, not the owner's | `terminalCoverageCta`, `audience: "maintainer"` |
| **Paused by operator** | operator action, not a defect | `SCHEDULE_PAUSED` |
| **Provider is down** | nobody's action; wait | `REMOTE_SURFACE_FAILED`, `EXTERNAL_TOOL_UNAVAILABLE` |

Every row maps to a reason code already in `CONNECTION_CONDITION_REASONS`. This
is a presentation vocabulary over existing evidence, not new derivation — which
is why it is cheap, and why it is worth doing before anything more ambitious.

Note "Needs a collector upgrade" is the sentence the owner most needs today: it
covers 2.4M + 1.3M + 38k + 20k records currently labelled "Not measured", and
the string already exists in the codebase.

## Proof of concept

The manual-import case, implemented end to end in
`reference-implementation/runtime/connection-health.ts`. It is the cleanest test
of the model because it is the case with no possible workaround — no owner
action can ever make a finished import fresh.

New test: `reference-implementation/test/connection-health-completed-import.test.ts`.

**Fail before** (against unmodified `connection-health.ts`) — this reproduces
the production symptom exactly:

```
✖ a completed one-time import reports Fresh as not_applicable, not unknown
  + actual 'unknown'  - expected 'not_applicable'
✖ a completed one-time import is healthy without a Fresh=true proof
  'idle' !== 'healthy'
```

**Pass after** — 6/6:

```
✔ a completed one-time import reports Fresh as not_applicable, not unknown
✔ a completed one-time import is healthy without a Fresh=true proof
✔ a completed import still needs complete coverage to be healthy
✔ a completed import with a terminal coverage gap is not healthy
✔ acquisition completeness does not leak into recurring sources
✔ a recurring source that is genuinely stale is never rescued by this path
```

The last three tests are the ones that matter. They prove the change cannot
manufacture a false green: coverage is still required, and a recurring source
without the completeness declaration behaves exactly as before.

The change is 90 lines, of which the load-bearing edit is **one**:

```
-    conditionIsTrue(conditions, "Fresh") &&
+    conditionIsSettledSatisfied(conditions, "Fresh") &&
```

where `conditionIsSettledSatisfied` accepts `true` or `not_applicable`, and
pointedly not `unknown`. The other 89 lines are the new
`ConnectionAcquisitionEvidence` type, one branch in `freshCondition`, and one
branch in `collectionSucceededCondition` that mirrors the existing
`localDeviceCollection.verdict` precedent for sources that legitimately write no
spine run.

**Regression evidence:** 305 existing tests pass unchanged —
`connection-health.test.ts` 151/151, `connection-health-acceptance.test.ts`
70/70, `rendered-verdict.test.ts` 84/84 — and `tsc --noEmit` is clean.

Not wired to the read path. `projectConnectorSummaryConnectionHealth` in
`server/ref-control.ts` would need to pass `acquisition` from the instance's
`source_kind`, and that file is being actively edited by another agent. The
runtime model is proven; the wiring is one line in a file I did not touch.

## What I deliberately left alone

- **The other nine conditions stay required.** Only `Fresh` gained a
  not-applicable path, and only for one source kind. Extending this to coverage
  is where a false green would come from, so it needs its own evidence and its
  own argument.
- **`classifyOwnerPaused` and the classification order.** Already correct. The
  paused-source damage is in the pill vocabulary, not the model.
- **`rendered-verdict.ts`.** The actor vocabulary rewrites it; the paused-pill
  fix rewrites it; doing either piecemeal now means doing it twice.
- **`hasAffirmativePassiveRecoveryEvidence`** (`connection-health.ts:1751`) —
  the scheduler's passive-recovery authority. It independently requires
  `axes.freshness === "fresh"` and `Fresh === "true"`. I did not touch it: a
  completed import has no schedule and no next attempt, so it can never reach
  that path, and relaxing a scheduler predicate to fix a display problem would
  be scope I cannot justify. It is, however, the second place the same
  fixed-required-list assumption lives, and it will need the same treatment if
  this model is adopted.
- **The `dirty`/projection layer.** Orthogonal, and owned by
  `summary-evidence-projection-controller-2026-08-18.md`.
- **Production data.** Nothing deployed, nothing committed, no database written.

## Cost and risk

**What breaks if the predicate changes.** Less than feared — `isHealthyConditionSet`
is private with exactly one caller. The blast radius is `classifyHealthy`, and
from there whatever reads `state === "healthy"`. The real risk is not
mechanical; it is that every future `not_applicable` is a potential false green.
That is why the rule above forbids deriving inapplicability from a missing
answer, and why the proof-of-concept spends half its tests on that boundary.

**The honest residual risk.** `not_applicable` is now load-bearing, so a bug
that marks a condition inapplicable is a bug that turns a source green. Before
this change such a bug was cosmetic. That is a genuine increase in the cost of
being wrong, accepted because the alternative is a permanently dishonest display
on 420k records that are complete and correct.

**Confidence.** That the manual-import fix is right: high — it is proven by
test, and the case admits no other honest answer. That the same shape extends
cleanly to the stale-collector and paused cases: moderate — the evidence exists
and the vocabulary maps, but neither is implemented, and the paused case needs a
pill-vocabulary decision I did not make.

## Related

`upstream-disclosure-window-2026-08-17.md` names the same failure from the other
side — "Imports have no upstream. They need to be first-class *not applicable*,
not zero — the same failure this codebase already has with 'Not measured'." That
note wanted this primitive and could not assume it. This note builds it for
freshness; the boundary case will want it too.
