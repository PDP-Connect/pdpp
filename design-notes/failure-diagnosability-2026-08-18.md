# A failure must not destroy its own cause

**Status:** intake. No requirement proposed. Written from five production
failures observed on 2026-08-18, two of them fixed the same day.
**Date:** 2026-08-18

## Why this note exists

Five failures in about one day. All five have the same shape: **something went
wrong, and the evidence needed to act on it was destroyed by the code that
handled it.** In four cases the failure itself may well have been transient and
harmless. What made them cost a day was that nothing downstream could tell.

1. **`[object Object]`.** `packages/polyfill-connectors/src/reference-blob-uploader.ts`
   built its error text with `String(body.error ?? statusText)`. The RI host
   always shapes `error` as an object — `pdppError` in
   `reference-implementation/server/request-helpers.ts:92` writes
   `{code, message, type}` — so `String()` produced the literal
   `"[object Object]"` for every host-side failure. That discarded the cause of
   24 quarantined Gmail attachment gaps, each recorded as
   `blob upload failed (503): [object Object]`. Fixed in `457e23e93`.
2. **Silent statement_timeout.** `observeConnectorSummaryEvidence`'s outer catch
   treated a typed `PostgresStatementTimeoutError` like any other error and
   routed it to `markAllConnectorSummaryEvidenceDiscoveryFailed`, durably
   writing `record_snapshot_state='failed'` across every row in scope. Neither
   that path nor `repairCandidatePostgres` logged anything. 25 of 29 evidence
   rows degraded in production with **zero** log output. Fixed in `1d8995b0f`.
3. **Empty `failure_reason`.** A failed ChatGPT run (`run_1787075769450`) wrote
   zero log lines matching its own `run_id`, and `run_history.failure_reason` is
   empty on every failed row. Only `terminal_reason` and a
   `connector_error_json` blob survived. Not fixed.
4. **`[REDACTED]`.** HEB connection `cin_c875ca3ec8b6ce2c283a4288` failed with
   `connector_error_json = {"code": null, "message": "heb_session_failed: [REDACTED]", "retryable": false}`.
   The cause is literally the string `[REDACTED]`. Partly fixed same-day in
   `46887c2e8`, which populates the `code` channel; the `message` channel is
   the subject of the proof-of-concept below.
5. **Unpublished dependency.** Every published `@pdpp/local-collector`
   (1.5.1–1.5.4) has `import ... from "@pdpp/reference-contract/common"` as line
   1 of `dist/polyfill-connectors/src/local-device-client.js`, but that package
   is not in `dependencies` and does not exist on npm. Every install crashes
   with `ERR_MODULE_NOT_FOUND` on any invocation, including `--version`. It
   works in the monorepo because pnpm resolves it through the workspace link.

Numbers 1–4 are error handling. Number 5 is packaging, and it belongs to a
different family; it is addressed separately at the end.

## First, the scale numbers are wrong

The intake for this note claimed ~246 bare catches and ~282 stringified-error
coercions. Both were re-measured. The raw catch count is **higher** than
claimed and the story is **much smaller**.

| metric | intake claim | measured |
|---|---|---|
| bare `catch {` (non-test) | ~246 | **439** |
| bare `catch {` (tests, separate) | — | 207 |
| `catch (e) {}` empty body (non-test) | — | **0** |
| `String(err)`-style on error-named values | ~282 | **173** |
| `REDACTED` (non-test, in scope) | ~58 | 35 |

The original grep almost certainly used `catch\s*\{`, which also matches
`catch (e) {`. It conflated two populations while undercounting the one it
named.

Then 55 of the 439 bare catches were read and classified, one per file, across
55 distinct files:

| class | count | share |
|---|---|---|
| benign cleanup | 8 | 15% |
| benign optional parse | 24 | 44% |
| benign probe | 21 | 38% |
| **fault-swallowing** | **0** | **0%** |
| **degrades durably** | **2** | **3.6%** |

**About 97% of bare catches are benign, and the fault-swallowing class is
empty.** The dominant patterns are `JSON.parse` → `return null` on stored
manifests and cursors, `new URL(x)` → `return false` in SSRF validators, and
telemetry taps explicitly commented "must never break the streaming path."
Several carry a comment justifying the swallow. This is a deliberate house
style, not neglect. **There is no catch-block crisis here, and a campaign to
migrate 439 call sites would be almost entirely waste.**

What the sample did find is three real defects, verified end-to-end to their
persistence points:

- `packages/polyfill-connectors/src/statement-content-fingerprint.ts:142` —
  any PDF text-extraction failure returns the all-null fingerprint, which is
  then persisted as statement `content`. The record durably says "no extractable
  content" whether the PDF is genuinely empty or the extractor crashed. USAA's
  sibling path at `statement-pdfs.ts:502` shows the fix: it emits `onSkip` with
  `structuralErrorDiagnostic(err)`.
- `packages/polyfill-connectors/connectors/gmail/index.ts:1418` — an IMAP body
  fetch failure returns null bodies and the message is emitted anyway, with no
  `DETAIL_GAP` and no coverage marker. Given the measured ~4.65 KB/s IMAP
  throttle on this connector, transient failures are expected, so bodyless
  messages land durably with nothing distinguishing them from empty mail.
- `reference-implementation/server/routes/as-grant-revoke.ts:157` —
  `String(e?.message ?? hookErr)`, where the catch neither rethrows nor changes
  the response. A failed grant-revoke side effect vanishes into one unreadable
  log line while the caller gets a success envelope.

Both durable-degradation sites are the same shape: **a fail-closed default that
is indistinguishable from a legitimate empty result.** Neither needs a `try`
restructured; each needs one extra field saying why the value is null.

The `457e23e93` archetype has **no surviving siblings** — a targeted search for
`String(...)` over parsed-JSON HTTP error bodies returns zero hits. And all 35
`REDACTED` occurrences are redaction *mechanism* (regex constants, scrub tables,
sanitizers), not a bare `message: "[REDACTED]"` standing in for a lost cause.

So the honest headline is **three fixes, not 246.** The rest of this note is
about why those three happened and what makes the next one impossible.

## What this codebase already gets right

There is a good, half-built convention here, and it is worth naming precisely
because the answer is to finish it rather than import something foreign.

**Two channels with opposite disciplines.** Stated outright in
`packages/polyfill-connectors/src/terminal-error.ts:44-57` and implemented once,
correctly, in `buildTerminalConnectorFields`
(`reference-implementation/runtime/index.ts:2846`):

- `code` is a **typed** channel. It is *validated, never redacted*, and fails
  closed to null. `boundConnectorErrorCode` tests it against
  `/^[a-z][a-z0-9_]{1,63}$/` and drops anything malformed.
- `message` is a **prose** channel. It is *redacted and truncated*, never
  trusted — `boundConnectorErrorMessage` runs `redactStderrTail` then caps at
  500 characters.

The security argument for the asymmetry is explicit in the source: `code` is
exempt from redaction *only because* the charset makes it incapable of carrying
a credential, a URL, or a stack trace. That is a genuinely good design, and it
is the thing to generalize.

Three more pieces are already right:

- **`recovery_hint` is a closed vocabulary** of 8 actions
  (`runtime/connector-gap-bounding.ts:117`), with the design intent stated
  well: *"a connector requests an ACTION this way; it never gets to pick one by
  shaping its `code` or free-form `message` text."*
- **Structured failure evidence on the row.** `search_index_dirty` records
  `last_error`, `attempts`, and `next_attempt_at` atomically
  (`queries/search/index-dirty/record-failure.sql`), with the comment
  *"observable evidence, not just a console.warn line."* This is the right
  instinct and the right place to put it.
- **The typed-error → reason-code mapping** the `1d8995b0f` fix introduced:
  `err instanceof PostgresStatementTimeoutError ? REASON_CODES.STATEMENT_TIMEOUT : default`.
  That is exactly the shape the terminal design needs, written once.

### Where the convention is only half-built

The pattern exists. Its *closure* does not.

- **Closure is upheld by hand-copied `Set`s and tests, not by types.**
  `RECOVERY_ACTIONS` is a `Set<string>`. Both `REASON_CODES` objects are
  unexported `as const` with no derived type. `codeToStatus`
  (`routes/ref-error-status.ts:89`) is `Record<string, number>`, so an
  unregistered error code compiles fine and silently becomes a 500. Only
  `SharedConnectionConditionReason` is a real derived union — and it is the one
  vocabulary with a single producer and a single consumer.
- **It has already drifted.** `scripts/stream-health-audit/authority.ts`
  maintains duplicate `Set`s that omit `repair_statement_timeout` and contain
  `"summary_evidence_unavailable"`, which exists in no const.
  `"update_connector"` is emitted at `runtime/connection-health.ts:1982,2747`
  and is not in `RECOVERY_ACTIONS`.
- **~170 error subclasses, no shared base.** The de-facto common field is
  `code: string`, but the HTTP-status carrier is variously `statusCode`,
  `httpStatus`, and `status`. Discrimination splits three ways: 134 `instanceof`
  sites, 74 `.code ===` sites, and 3 fragile `.name === "..."` string
  comparisons.
- **The typed channel degrades into prose-sniffing.** When a recovery hint is
  absent or invalid, `inferRecoveryAction`
  (`runtime/connector-gap-bounding.ts:739`) regex-matches the free-form message
  to guess an action. `connector-coverage-policy.ts:167` matches connector
  reason strings by substring. These are the seams where a structured design
  silently becomes a guess.
- **There is no logger.** No module exports a log API. Pino exists but is wired
  to exactly one call site (`transport.ts:335`) and is never exported, so no
  library module can reach it. Everything else is `console.*` with a
  `[module-tag]` prefix — **19 calls in the entire server, none carrying
  `run_id`.** That is the mechanical reason incident 3 produced zero lines
  matching its own run id: there is no facility that would have written one.
  The real correlation channel is the spine (`lib/spine.ts:483`), which carries
  `run_id`, `trace_id`, `request_id`, and `grant_id`, and hard-rejects a
  malformed event. `packages/polyfill-connectors/src/` has no spine access at
  all, which makes it the least observable surface in the system.

## The invariant

The candidate invariant from intake was:

> A failure must never lose the information needed to act on it. Every failure
> that crosses a durability boundary carries a machine-readable code, a
> human-readable cause that is not a stringified object, and a PII-safe
> diagnostic detail. A catch that discards a fault is a bug, not a style choice.

The last sentence should go. The measurement says the fault-swallowing class is
empty and 97% of bare catches are correct, so "a catch that discards a fault is
a bug" indicts a house style that is not what broke. It would also push toward
a 439-site migration that buys nothing.

The rest is close but describes a payload rather than a property. What actually
failed in all four cases is narrower and more testable:

> **A failure that crosses a durability boundary must carry a cause that is
> reconstructable from what is written down.** Every failure persisted to a row,
> returned to a caller, or shown to the owner carries (a) a machine-readable
> code from a closed vocabulary, and (b) a human-readable cause. Any transform
> applied on the way out — coercion, redaction, truncation, classification —
> must be **category-preserving**: it may drop detail, but it may never leave a
> value whose failure class can no longer be told apart from a different one.

The operative word is *category-preserving*. `[object Object]`, `[REDACTED]`,
`''`, and `record_snapshot_state='failed'` with no reason are all the same
defect under this rule: each is a value that survived the boundary while
becoming indistinguishable from every other failure that produced the same
placeholder.

### Testing it against the five incidents

| # | prevented? | why |
|---|---|---|
| 1 `[object Object]` | **yes** | The coercion is not category-preserving: every distinct host error maps to one string. Caught by the rule directly. |
| 2 silent timeout | **yes** | A cancelled read and a genuinely bad row both wrote `failed`. Distinguishing them is exactly what `1d8995b0f` added, and it is what the rule requires. |
| 3 empty `failure_reason` | **partly** | The rule forces the field to be populated. It does **not** by itself produce a correlated log line — that needs a logger this codebase does not have. |
| 4 `[REDACTED]` | **yes** | Redaction that collapses distinct reasons to one token is not category-preserving. |
| 5 unpublished dep | **no** | Nothing was mishandled. No failure crossed a boundary; the artifact never ran. Different family. |

**Where it would not have helped, honestly:**

- It would not have prevented incident 5 at all.
- For incident 3 it fixes the durable row but not the missing log. Someone
  debugging by `grep run_id` still finds nothing until a logger exists.
- It says nothing about failures that are never caught in the first place, or
  about a correct code attached to a wrong diagnosis.
- It does not address the two durable-degradation sites found by measurement
  (`statement-content-fingerprint.ts:142`, `gmail/index.ts:1418`). Those write a
  *successful-looking record* with a silently-null field; no failure crosses a
  boundary, so the invariant never engages. They need a different rule — a
  fail-closed default must be distinguishable from a real empty result — and
  that rule is worth stating separately rather than stretching this one.

## The mechanism

One small thing, not a framework. The two-channel design already exists and is
already correct; what is missing is that its vocabularies are open and its
transforms are not category-preserving. Three changes, in order of leverage.

**1. Close the vocabularies with types, not `Set`s.** Every reason vocabulary
becomes an exported `as const` with a derived union:

```ts
export const RECOVERY_ACTIONS = {
  RETRY_BY_RUNTIME: "retry_by_runtime",
  // ...
} as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[keyof typeof RECOVERY_ACTIONS];
```

This is a mechanical change with immediate payoff: `"update_connector"` and the
drifted audit `Set`s become type errors rather than silent divergence, and
`codeToStatus` stops turning an unregistered code into a 500 by default. It
requires no call-site migration — only the declarations move.

**2. Make redaction category-preserving.** This is the subject of the
proof-of-concept below, and the finding there is the most interesting result in
this note.

**3. Populate `failure_reason` from the terminal event.** The empty field in
incident 3 is not a bug in the ordinary sense. It is a hardcoded literal, in
both backends, with a comment explaining why:

```ts
// reference-implementation/server/stores/run-history-writer.ts:275 and :366
const terminalReason = typeof event.data.reason === "string" ? event.data.reason : null;
const failureReason: string | null = null;
```

The comment says `failure_reason` is a scheduler-only classification and is
"left null rather than fabricated, since no Slice A reader depends on it for
non-scheduled runs." That reasoning was sound when written and is now false —
`ref-spine-correlations-list` and the console both read it. **This is worth
dwelling on: the information was dropped deliberately, on a reader-side
assumption that later stopped holding.** No lint rule catches that. It is an
argument for making the *durable schema* carry the classification unconditionally,
so a writer cannot decide on a reader's behalf that a cause is not worth keeping.

### The gate that makes regression impossible

This repo already has the right mechanism, used twice, and it is better than a
linter rule for this purpose. `lefthook.yml` runs
`check-direct-prepare-conformance.ts`, which pins grandfathered sites at exact
`(path, line)` in a checked-in allowlist and fails on three divergences: a
**new** hit not in the allowlist, a **stale** row whose site moved or was
migrated, and a **duplicate** row. The polyfill-connectors `noAwaitInLoops` gate
has the same shape. The comment states the property that matters:

> The rule still fires on any NEW direct-prepare anywhere, INCLUDING a new one
> inside an already-allowlisted file, and additionally fails on a STALE
> allowlist row so exceptions cannot be carried silently.

That is precisely the migration mechanism this design needs, and it already
exists. A new `check-error-envelope-conformance.ts` in the same shape would
enforce the one defect worth banning outright: **`String(...)` applied to a
caught value or a parsed HTTP error body.** That is a real, narrow, mechanically
detectable pattern with exactly one known instance left
(`as-grant-revoke.ts:157`), so the allowlist starts at ~1 entry rather than 439.

Biome cannot express this. It is version 2.5.6 extending `ultracite`, and the
repo already works around missing rules with grep gates — the `no-double-cast`
job exists because "Biome/Ultracite has no equivalent to typescript-eslint's
`consistent-type-assertions` yet." A `String()`-on-caught-value rule needs type
information about the argument, which is why the grep gate is the honest answer
here rather than a stopgap.

**What should not be banned:** empty `catch {}`. The measurement says 97% are
correct and the fault-swallowing class is empty. A lint rule there would
generate 439 suppression comments and teach people to ignore the gate.

## Proof of concept: category-preserving redaction

Incident 4 was chosen over incident 3 because another agent is already working
in `run-history-writer.ts`, and because it turned out to have the more
interesting answer.

While this note was being written, `46887c2e8` landed a **complementary** fix
for the same incident from the other side: it populates `TerminalError.code` on
the session-establishment path, so the *typed* channel carries the reason even
when the prose channel is destroyed. That is the right first move and it
confirms the two-channel design is the one to generalize. It does not restore
the `message`, which is what an owner reads and what `inferRecoveryAction`
consumes, so the two fixes stack rather than compete. The proof-of-concept below
touches `runtime/stderr-redact.ts`, which `46887c2e8` does not; both were
verified green together.

**The defect, reproduced exactly.** `LONG_OPAQUE_RE`
(`runtime/stderr-redact.ts:43`) is `/\b[A-Za-z0-9_-]{24,}\b/g` — an **entropy**
heuristic, aimed at unlabelled API keys in stack traces. Categorical reason
tokens match it too:

```
"heb_session_failed: login_form_never_appeared"   -> "heb_session_failed: [REDACTED]"
"usaa_session_failed: source_unavailable"         -> "usaa_session_failed: source_unavailable"
```

`login_form_never_appeared` is 25 characters and carries no PII whatsoever.
`source_unavailable` is 18 and survives. **Whether a failure stayed diagnosable
was decided by the length of its reason token.** Run through the real production
boundary, `boundConnectorErrorMessage` reproduces the exact production string
`heb_session_failed: [REDACTED]`.

There is a second half to this. Once the message is destroyed,
`inferRecoveryAction` regex-matches the *redacted* text to choose a recovery
action, and returns `"unknown"`. So the redaction did not just cost a human
reader the cause — it silently degraded the machine-actionable output too.

**The finding: shape cannot fix this.** The obvious fix is a smarter pattern —
preserve alphabetic `snake_case`, redact anything with entropy. Tested against
real secret shapes, it separates cleanly:

```
login_form_never_appeared            kept      sk_live_<redacted-example>   redacted
heb_verification_code_not_provided   kept      eyJhbGciOiJIUzI1NiIsInR5cCI6...  redacted
two_factor_challenge_unrecognized    kept      a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 redacted
```

And then it fails, in the way that matters:

```
tim_nunamaker_gmail_com              kept      <- a personal name
```

**A name is alphabetic snake_case too.** No regex distinguishes a declared
reason token from a person's name, because the difference is not spelling — it
is *provenance*. That is the load-bearing conclusion, and it is why the
mechanism is an allowlist rather than a better pattern.

So: a token survives only if the connector **declared** it in advance. The
declaration is reviewable in the connector's source, where a human reading
`login_form_never_appeared` can see it is a constant, and would see a name for
what it is.

```ts
// reference-implementation/runtime/stderr-redact.ts
next = next.replace(LONG_OPAQUE_RE, (match) => (declared?.has(match) ? match : "[REDACTED]"));
```

The full change is 36 lines, most of it the comment explaining why shape does
not work. Six tests in
`reference-implementation/test/stderr-redact-declared-reasons.test.ts` pin the
four properties the fix must have, including the two that say what it
deliberately does not do:

```
✔ regression: the production defect — a declared reason token is destroyed by length alone
✔ a declared reason token survives redaction, so the owner sees the real cause
✔ secrets are still redacted even when a declaration set is supplied
✔ an UNdeclared reason token still redacts — declaration is the safety property, not spelling
✔ callers that do not opt in are byte-identical to the previous behaviour
✔ disclosed pre-existing gap: this redactor is not a PII control
```

**Verification.** 18/18 tests pass across the new file and the existing
`stderr-redact` suite; 20/20 across `connector-gap-bounding` and
`device-exporter-sanitize` consumers; 16/16 on the systemic-failure redaction
and stderr-tail oracles. `tsc --noEmit` clean, `biome check` clean. The
declaration set is optional and defaults to empty, so every existing call site
is byte-identical — pinned by its own test, since a redaction change that
silently widened what escapes would be much worse than the bug it fixes.

**Disclosed while building it.** Today's redactor already passes
`tim.nunamaker@example.com` and `tim_nunamaker_example` through untouched, with
no options involved — both are under the 24-character threshold. This is
pre-existing and independent of the change, but it should be recorded plainly:
`LONG_OPAQUE_RE` is an entropy heuristic and **is not a PII control**, though
its name and position invite reading it as one. The declared-token change can
only ever reduce what escapes, never widen it. Whether a real PII boundary is
needed here is a separate question this note does not answer.

## Incident 5 is a different family

Nothing was mishandled. No failure crossed a boundary. The artifact simply never
ran anywhere except where it was built — the same shape already recorded in
`connector-sidecar-packaging-2026-08-17.md`, which put it well:

> Whatever ships must be verified against the runtime it will execute on, at
> build time, by executing it.

The pleasant surprise is that **the smoke test already exists and is already
correct.** `packages/local-collector/scripts/pack-install-run.ts` packs the
tarball, installs it into a clean temp npm project outside the workspace with an
isolated `HOME` and cache, and then *executes the installed binary* — `advertise`,
`enroll`, and `run --connector codex` against an in-process reference server. It
asserts forbidden packages are absent and the bin is executable. An `npm install`
of a package whose dependency does not exist on npm fails at the install step.
**It would have caught this.**

It is wired to `pnpm --filter @pdpp/local-collector run verify`, and `verify` is
`pnpm test && pnpm validate:package`. `pack-install-run` is not in it. CI calls
`verify` at `.github/workflows/semantic-release.yml:130`.

So the fix is one line — add `pack-install-run` to `verify` — and the rule is:

> **A package's release gate must install the packed artifact in a clean
> environment and execute it.** Not "the build passed," not "the types check" —
> those both passed while every published version was unstartable.

The right place is the existing `verify` script, so it runs in
`semantic-release.yml` before publish and stays available locally. The same gap
should be checked for `@pdpp/cli` and `@pdpp/mcp-server`, which have sibling
`verify` scripts. Worth noting separately: `pnpm` workspace linking is what
*hid* this, so any check that resolves through the workspace is structurally
incapable of finding it. That is the same lesson as the sidecar note, one layer
up the stack.

## Cost, and what stays broken

Hundreds of call sites cannot and should not be migrated. The measurement is
what makes this affordable — the real work is small:

1. **Close the vocabularies** (types only, no call-site changes). Highest
   leverage, lowest risk. Turns existing drift into compile errors.
2. **Wire `pack-install-run` into `verify`** for all three published packages.
   One line each; closes incident 5 permanently.
3. **Land the redaction change** and give connectors a place to declare reason
   tokens. Already proven; needs the declaration plumbed from the manifest.
4. **Populate `failure_reason`** in `run-history-writer.ts` for non-scheduler
   runs. Needs coordination — another agent is in that file.
5. **Add the conformance gate** for `String()` on caught values, starting from a
   ~1-entry allowlist.
6. **Fix the three measured defects** — `statement-content-fingerprint.ts:142`,
   `gmail/index.ts:1418`, `as-grant-revoke.ts:157`.

New code is forced onto the new path by step 5, which is the only step that has
to be right the first time; the rest are additive.

**What stays broken in the meantime:**

- There is still no logger, so incident 3's "zero lines matching the run_id"
  stays true even after `failure_reason` is populated. A structured logger with
  correlation fields is a real piece of work and is not scoped here. The spine
  is the closest existing thing and connectors cannot reach it.
- `inferRecoveryAction`'s prose-sniffing fallback and
  `connector-coverage-policy.ts`'s substring matching both stay. They are the
  seams where the typed design degrades into a guess, and closing them means
  deciding what happens when a connector supplies no hint at all.
- The ~170 error classes keep their three discrimination styles and their
  `statusCode`/`httpStatus`/`status` drift. The duck-typed `.code` convergence at
  the HTTP boundary works well enough that a base-class migration is hard to
  justify on today's evidence.
- The two fail-closed-null sites are real but need their own rule; the invariant
  in this note does not reach them.

## Open questions

- Where do connectors declare their reason vocabulary? The manifest is the
  obvious home, and `reason-display-messages.ts` already keys on
  `(connector_key, reason_code)` with an anti-parrot rule — but its
  exhaustiveness is enforced only by an AST-scanning test, which is the same
  open-vocabulary weakness described above.
- Should `failure_reason` be a closed union rather than free text? There is
  already an unexported closed union in `runtime/classify-runtime-failure.ts:14`
  that never returns empty. Exporting it may be most of the answer.
- Is a real PII boundary needed where `redactStderrTail` currently sits, given
  it passes plain email addresses through today?
- Do `@pdpp/cli` and `@pdpp/mcp-server` have the same unpublished-dependency
  defect? Only `local-collector` was checked.

## Provenance

Written from five production failures on 2026-08-18. Incidents 1 and 2 fixed
same-day in `457e23e93` and `1d8995b0f`. Scale numbers re-measured against
`deploy/prod-plus-fixes-0817`; the catch classification is a 55-site sample
across 55 files (12.5% of 439), so the two durable-degradation sites are
verified end-to-end but any extrapolation from them should be treated as an
order-of-magnitude hint, not a census. The redaction proof-of-concept and its
six tests are working code, not a sketch.

Related: `connector-sidecar-packaging-2026-08-17.md` (incident 5 is the same
"verified where it was built, not where it runs" shape) and
`summary-evidence-projection-controller-2026-08-18.md`, whose subject is the
sweep that produced incident 2.
