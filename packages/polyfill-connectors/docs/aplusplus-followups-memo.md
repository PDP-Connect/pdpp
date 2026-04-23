# Memo: Closing the remaining A++ gaps in `polyfill-connectors`

**Author:** Claude (on the owner's behalf)
**Date:** 2026-04-23
**Audience:** anyone with commit rights on `packages/polyfill-connectors/`
**Status:** proposal — seeking ack before execution

## TL;DR

We ran two passes of deep refactoring through this package. The tooling floor
is now legitimately strict: no `any`, no `!`, no `as unknown as`, no
`@ts-ignore`, cognitive complexity ≤ 20 enforced by Biome, 542 tests green,
pre-commit hooks that auto-format + re-stage.

That raised the floor. **It did not raise the ceiling.**

A second honest critique of the codebase surfaced 12 remaining gaps that
keep us at "solid A" rather than "Stripe/Linear A++". This memo proposes a
prioritized plan to close them. None of the proposals are individually large.
Together they're roughly 2-3 focused days of work plus whatever decisions
come out of item #1 (which may be non-trivial to resolve).

I'm not asking for sign-off on all of it in one pass. I'm asking for:

1. Alignment on which items matter vs. which are nits.
2. Owner assignments for the behavioral questions (item #1).
3. A go/no-go on the CI + E2E subproject (items #11 + #4) since those are
   the biggest individual commitments.

## Scoring the current state honestly

Starting point before the two refactor passes:
- Cognitive complexity violators in production code: 30+ functions (range 21-255).
- Test count: 0 unit tests, 0 integration tests.
- `@ts-expect-error` directives: 70.
- Deprecated Playwright API calls: 7.
- Lefthook bypasses via `--no-verify`: 3 commits.
- Known bugs in production code flagged but not fixed: 3 (amazon currency parsing, shipping-address dedup, item-match whitespace).

Current state:
- Zero complexity violators.
- 542 tests (425 parser unit, 93 integration, rest misc).
- 4 `@ts-expect-error` directives, each documented.
- Zero deprecated API calls.
- Zero bypasses.
- The three amazon bugs fixed with regression tests.

That's real progress. It's not A++ yet.

## Why it's not A++

Every gap I list below is something a senior reviewer at Stripe/Linear/Plaid
would flag in the first 90 minutes of review. Not every gap is urgent. Not
every gap requires a code change. But each one is a legitimate reason to
say "this codebase is very good, but not what we'd ship."

---

## Item #1 — Emit-order inversions in gmail and chatgpt (CORRECTNESS)

**Priority: high. Owner decision needed.**

The integration-test pass surfaced that `gmail` and `chatgpt` emit child
records before parent records in a couple of places:

- `gmail/runAllMailPasses` emits `messages` records before the `threads`
  records that aggregate them.
- `chatgpt/processConversationDetail` emits `messages` before the
  `conversations` record they belong to.

Every other connector (amazon, usaa, chase, slack, codex, claude_code)
emits parent-first. Downstream consumers reading the stream can't tell
from protocol whether "parent before child" is a guarantee or just a
coincidence, because our own connectors disagree.

I pinned the current (inverted) behavior in tests to prevent silent
regression. That was the right call for the moment, but it locks in an
inconsistency. A++ says: pick one, migrate.

**Proposal:**

1. **Decide the convention** (one 30-minute meeting, owner: the owner):
   - "Parent emits before children" is the obvious Stripe/Plaid choice. It
     lets consumers do streaming upserts with referential integrity.
   - "Children emit before parent (parent aggregates from observed children)"
     is a legitimate alternative for gmail's thread-aggregation design
     but has no precedent in our other connectors.
2. **Pick parent-first.** Reverse gmail and chatgpt to match the other six.
   Update the pinned tests.
3. **Add a protocol note to `docs/authoring-guide.md`** making the
   convention explicit for connector authors.

**Effort:** 2-4 hours each for gmail and chatgpt to reorder the helper call
sites, plus test updates. The integration tests already describe the
boundary, so the refactor is safe.

**Risk:** consumers that implicitly relied on the current gmail/chatgpt
ordering (unlikely but possible — we haven't audited consumers). Mitigated
by announcing the change in a changelog entry; the protocol doesn't break,
only the temporal ordering does.

## Item #2 — No comparison against pre-decomposition behavior (VERIFICATION)

**Priority: high. Effort: medium.**

The integration tests I added lock in *current* behavior. They catch
future regressions but don't catch the case I was originally worried about:
a subagent silently reordering emits during the big cognitive-complexity
refactor. If the pre-decomposition gmail emitted parents-first, and a
subagent inverted it during the refactor, my tests now *protect the bug*.

**Proposal:**

1. For each connector whose `collect()` was decomposed by a subagent
   (chatgpt, slack, codex, claude_code, gmail, usaa, chase), diff the
   current `collect()` against the last pre-decomposition commit.
2. For each material difference (emit order, stream gating, STATE
   timing, SKIP_RESULT shape), either:
   - Confirm the change is intentional (and comment the decision in
     code).
   - Revert to pre-decomposition behavior.
3. Re-run the integration tests. If anything now fails, we found a real
   regression.

**Effort:** ~30-60 minutes per connector × 7 connectors = half a day.

**Risk:** low. Read-only analysis; no code changes unless a genuine
regression is found.

## Item #3 — `collect-helpers.ts` is a workaround, not an architecture (DESIGN)

**Priority: medium. Effort: small.**

Six connectors now have a `collect-helpers.ts` file whose *sole reason
for existing* is that `index.ts` calls `runConnector({...})` at module
scope — importing `index.ts` in a test keeps the Node event loop alive.

The proper fix is architectural:

```ts
// runConnector only fires when the module is the entry point
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runConnector({ ... });
}
```

With that guard, tests can import `index.ts` directly, the seam lives
where the code lives, and six boilerplate files disappear.

**Proposal:**

1. Add the entry-point guard inside `runConnector` itself (or as a
   caller-side helper in `src/connector-runtime.ts` like `runIfMain()`).
2. Fold each `collect-helpers.ts` back into its `index.ts` and update
   test imports.

**Effort:** ~2 hours. Mechanical once the guard works.

**Risk:** low — the guard pattern is idiomatic Node. Failure mode (guard
never triggers) would be caught immediately by any connector run.

## Item #4 — Integration tests don't exercise the real protocol (VERIFICATION)

**Priority: high if we do this, medium if we don't. Effort: large.**

Current integration tests exercise helpers inside `collect()` with a
mocked `emitRecord`. They DO NOT exercise:
- stdin START parsing
- stdout RECORD/STATE/SKIP_RESULT/PROGRESS/DONE serialization
- zod shape-check (records that would SKIP_RESULT in prod pass silently
  in tests)
- the Playwright browser acquire/release lifecycle
- the fixture-capture lifecycle
- the terminal DONE + flushAndExit

**Proposal:**

Add a subprocess-based test harness (~100 LOC in `src/test-harness.ts`):

```ts
export async function runConnectorSubprocess(
  connector: string,
  start: StartMessage
): Promise<{ messages: EmittedMessage[]; exitCode: number }>;
```

Each connector gets `connectors/<name>/protocol.test.ts` with ~3-5 tests
that:
1. Send a START with scope X.
2. Collect all stdout messages.
3. Assert on the complete (RECORD + STATE + DONE) sequence.

For browser connectors, mock the Page (Playwright's `Page` is trivially
mockable via `chromium.launch` in `headless:true` mode with a stubbed
`ensureSession`).

**Effort:** ~2-3 days. The harness itself is a day. Wiring up one test
per connector is another day. Synthetic fixtures for the non-parser
inputs (e.g. a stubbed gmail IMAP client) add the third.

**Risk:** highest of anything in this memo. Real protocol tests in CI
can be flaky. Mitigation: keep them opt-in via `PDPP_E2E=1` initially;
promote to required once they've been stable for a sprint.

**Alternative:** skip this. Accept that unit + helper-level integration
is the ceiling and document that decision. I don't recommend this, but
it's an honest option.

## Item #5 — `emit` mock doesn't validate record shape (VERIFICATION)

**Priority: low. Effort: tiny.**

Every integration test does:
```ts
emitRecord: (stream, data) => { emitted.push({ stream, data }); return Promise.resolve(); }
```

That records the call but doesn't run the zod shape-check that
`emitRecord` does in production. A record that would SKIP_RESULT in
prod passes the integration test silently.

**Proposal:**

Replace the mock with a helper in `src/test-harness.ts`:

```ts
export function makeRecordingEmit(validateRecord: ValidateRecord) {
  const emitted: EmittedRecord[] = [];
  const skipped: Array<{ stream: string; issues: unknown }> = [];
  const emitRecord: EmitRecordFn = (stream, data) => {
    const result = validateRecord(stream, data);
    if (result.ok) emitted.push({ stream, data: result.data });
    else skipped.push({ stream, issues: result.issues });
    return Promise.resolve();
  };
  return { emit: noop, emitRecord, emitted, skipped };
}
```

Each integration test replaces its hand-rolled mock with
`makeRecordingEmit(validateRecord)`. Tests that care about skipped
records can assert on `skipped`.

**Effort:** ~1-2 hours to write the helper + migrate 8 integration
test files.

**Risk:** low. Likely surfaces latent issues: fixtures that don't match
the zod schema would break tests. That's a *feature* — we'd be catching
real shape drift.

## Item #6 — apple_health parser timeout dismissed without investigation (QUALITY)

**Priority: low. Effort: small.**

The full-suite test run timed out under aggressive `timeout 30`;
apple_health's parser suite took 1.5s. I ran it in isolation, saw 28/28
pass, and assumed first-run tsx compilation. That's a reasonable guess
but I didn't verify.

**Proposal:**

1. Add `--test-timeout 30000` to the `test` script so CI runs don't
   flake under cold-import conditions.
2. Profile the apple_health test suite to confirm: is it tsx warmup,
   or is one specific test pathological?
3. If pathological: fix. If warmup: document and move on.

**Effort:** ~30 minutes.

**Risk:** zero. Either confirms the dismissal or surfaces a real bug.

## Item #7 — `@ts-expect-error` inside `page.evaluate` hides type checking (QUALITY)

**Priority: medium. Effort: small.**

Three of our four remaining `@ts-expect-error` directives are inside
`page.evaluate(() => {...})` callbacks in chatgpt. They suppress the
"document is not defined" error. But that also means TypeScript can't
catch typos like `docuemnt.querySelector(...)` inside the callback —
which would be a production bug that fails at runtime inside the browser.

**Proposal:**

Declare a scoped ambient binding in `types/`:

```ts
// types/page-evaluate.d.ts
// Inside page.evaluate callbacks, Playwright binds globalThis to the
// browser's window. This ambient declares the subset we use so TS
// can typecheck the callback body.
declare global {
  // Scoped to files that import this explicitly? Unfortunately
  // declare global is global. So: only include this .d.ts in
  // tsconfig when we want the browser globals. Alternative: keep
  // DOM lib on and accept that Node code can reference document
  // (caught by ESLint `no-restricted-globals` instead).
}
```

Better alternative: since we already have `"DOM"` in tsconfig `lib`,
the callback bodies SHOULD typecheck. The `@ts-expect-error` was added
before we added DOM lib and is stale. Verify and remove.

**Effort:** ~1 hour investigation + removal.

**Risk:** low. Either the directives are stale (best case — remove
them) or they're hiding a real browser-specific global we didn't
account for. Either finding is a win.

## Item #8 — Parser-heavy test distribution (COVERAGE)

**Priority: low. Effort: depends.**

Of 542 tests, ~425 are parser unit tests. Lots of "currency parsing"
coverage, zero end-to-end protocol coverage. Item #4 addresses the
worst of this; this item is the follow-up.

**Proposal:**

After item #4 lands, audit each connector and ask: which 2-3 tests
would fail in the most embarrassing way if a senior engineer saw the
connector misbehave in demo? Add those. Cap at ~3 per connector to
avoid bloating the suite.

**Effort:** ~1 hour per connector × 9 = 1.5 days.

**Risk:** zero.

## Item #9 — Performance bench only covers amazon (COVERAGE)

**Priority: low. Effort: small.**

We have one bench file proving amazon parsing is <1% of wall-clock.
Extrapolating from one data point to "the whole package is
performance-neutral" is the shortcut. USAA's PDF parser, codex's
rollout walker, and claude_code's project-dir scanner could have
pathological cases we'd only find in production.

**Proposal:**

Add bench scripts for the three file-based connectors with the largest
potential cost:
- `bench/usaa-statement-pdfs.ts` — run against a sample statement PDF.
- `bench/codex-walk-rollouts.ts` — against a ~100-file synthetic
  rollout tree.
- `bench/claude-code-scan-projects.ts` — against a ~500-file synthetic
  project tree.

Each follows the amazon bench pattern. Document findings in each
bench's header comment.

**Effort:** ~1 hour per bench × 3 = half a day.

**Risk:** zero. Either confirms perf is fine everywhere or finds a real
hotspot.

## Item #10 — Lefthook auto-format loses unstaged changes in edge cases (UX)

**Priority: low. Effort: medium.**

Our lefthook `format` job uses `stage_fixed: true` to re-stage Biome's
auto-repairs. If a user has both staged and unstaged changes in the same
file, the hook formats + stages the formatted-staged version, but the
user's unstaged delta becomes ambiguous relative to the new staged
content. context-gateway's husky equivalent uses `git merge-file` to
reconcile three-way. Ours doesn't.

**Proposal:**

Port context-gateway's merge-file logic from
`/home/user/code/context-gateway/.husky/pre-commit` into
`lefthook.yml` as a script step. Or: scope our hook to only format
files with no unstaged content (refuse to format partial stages).

The latter is simpler and safer.

**Effort:** ~2 hours.

**Risk:** medium. Hook logic bugs are annoying because they silently
corrupt commits. Test with a staged+unstaged scenario before shipping.

## Item #11 — No CI runs any of this (BLOCKER for "truly A++")

**Priority: highest. Effort: medium.**

Every claim in this memo was verified on my dev machine. "Tests green"
and "verify clean" mean nothing until CI says so. A GitHub Actions
workflow is the difference between "it works on Claude's session" and
"this is a project the team can trust."

**Proposal:**

Add `.github/workflows/polyfill-connectors.yml` that:
1. Runs on every PR touching `packages/polyfill-connectors/`.
2. Runs `pnpm install`, `pnpm --dir packages/polyfill-connectors verify`
   and `pnpm --dir packages/polyfill-connectors test`.
3. Required status check to merge.

**Effort:** ~2 hours including getting the runner config right for our
monorepo.

**Risk:** zero technical. Political: CI costs money and failing CI
blocks merges. Both are features.

## Item #12 — Noisy commit history (AESTHETICS)

**Priority: lowest. Effort: small.**

~50 `polyfill-connectors:` commits in a row. Each is individually
clean, but a reviewer scrolling branch history sees a wall of similar
subjects. Stripe-grade would squash within each connector into
~10 coherent commits.

**Proposal:**

Leave as-is. Rewriting local history is cheap, but we've already
pushed some of it (`origin/main..HEAD` has 100+ commits). Force-push
to `main` would be rude even if we could. Accept the noise.

**Alternative if you really want clean history:** create a
`refactor/aplusplus` branch, cherry-pick logical commits, push THAT as
the canonical narrative, and leave `main` as-is. That's overkill.

**Effort:** 0 (status quo) or ~4 hours (branch cleanup).

**Risk:** history-rewrite fallout if anyone downstream has a fork.

---

## Proposed execution sequence

If you give me the go-ahead on all of this, I'd sequence it:

**Week 1 (unblock + measure):**
- Item #2 (compare against pre-decomp behavior) → may reshape everything.
- Item #11 (CI) → lets every subsequent claim be verified.
- Item #3 (entry-point guard) → removes 6 files of workaround.

**Week 2 (correctness):**
- Item #1 (fix emit-order inversions) — depends on owner decision.
- Item #7 (verify `@ts-expect-error` for DOM is still needed).
- Item #5 (emit mock validates shape).

**Week 3 (depth + polish):**
- Item #4 (E2E protocol tests) — biggest single chunk.
- Item #9 (more benches).
- Item #6 (apple_health timeout investigation).
- Item #10 (lefthook merge-file) — optional.

**Never:**
- Item #12 (commit squash). Not worth the history-rewrite cost.
- Item #8 (more tests) — wait for item #4 to finish first; it may
  subsume this.

## What I'm asking for

1. **Ack on item #1's decision path** — parent-first is the obvious
   choice. Unless someone has context I'm missing, I'd like to just go
   do it.
2. **Go/no-go on item #4** (E2E protocol tests). This is the single
   biggest chunk. If we decide "no", I'll document the decision and
   move on; if "yes", I'll start with the harness.
3. **Go/no-go on item #11** (CI). Cheap, but requires someone with
   repo admin to enable required status checks.
4. **Ack on the rest being within scope** to land without individual
   approvals.

If you're aligned on everything above, I can start immediately. If you
want to carve out a subset, tell me which and I'll execute that.
