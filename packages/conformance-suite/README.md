<!--
Copyright The PDP-Connect Contributors
SPDX-License-Identifier: Apache-2.0
-->

# PDPP conformance suite

An executable, role-based conformance suite for PDPP Core v0.1 Section 9.

Core §9 says a formal suite "is planned but is not defined in v0.1". This package is
tooling toward that, built against the requirements Section 9 already numbers. It
changes no spec text and no programme rule.

## What this is not

- **Not a certification.** No output confers status. GOVERNANCE.md §5 makes conferring
  status the technical committee's act, and §4 opens Verified Operator on the suite's
  publication, not on a passing run. The report has no `certified` field at any level,
  and a test asserts the rendered report never uses the word.
- **Not a claim about any deployment.** A report describes one target at one moment.
- **Not complete.** It covers a minority of Section 9 (see Coverage below). That is
  stated in every report rather than left for a reader to discover.

## Design

**Black-box and adapter-driven.** Target cases speak HTTP to a target's `baseUrl`
through [`TargetAdapter`](./src/harness/adapter.ts), which supplies the two things a
black-box client cannot do for itself: obtain credentials (Core §8 leaves owner-token
acquisition out of scope) and seed known records (grant enforcement against an empty
store passes vacuously). Client cases use [`ClientUnderTest`](./src/harness/client-adapter.ts)
against a local AS + RS fixture and inspect its inbound request log. No case imports
the target implementation. The bundled reference target under `src/targets/`
implements the target contract and holds no privilege.

**Traceable to the clauses, not just the item numbers.** Section 9's 45 items are
summaries; a pass on one says nothing about which of the normative sentences it
summarizes was exercised. [`matrix.ts`](./src/requirements/matrix.ts) enumerates
those sentences for Core sections 4-8 and 10 — 131 clauses at v0.1, each with its
verbatim text, level, role, observable boundary, the items that roll it up, the
cases that exercise it, and for every uncovered MUST the exact missing hook.
[`docs/reference/conformance-normative-matrix.md`](../../docs/reference/conformance-normative-matrix.md)
is the generated view; regenerate it with `pnpm matrix:md`. Every report now
lists each requirement's clauses and names the MUST clauses its cases did not
reach, so a `PASS` cannot be read as covering the whole item.

**Traceable to numbered requirements.** [`catalog.ts`](./src/requirements/catalog.ts)
transcribes all 45 numbered Section 9 items — AS 1–21, RS 1–16, Client 1–8 — keeping
the spec's own numbering, so `RS-9` is Section 9 "Resource Server conformance" item 9.
Each carries its normative level, applicability, and spec anchor. Every report records
the spec document, version, and section it was judged against.

**Negative oracles first.** A server that ignores grants entirely still returns records
on the happy path. The cases that decide whether enforcement is real are the ones that
exceed the grant: an ungranted stream, a field outside the projection, a revoked grant,
a foreign subject, metadata disclosing current capability. Each pairs with a positive
control on the same surface, so "refuses everything" does not pass either.

**Oracles are proven to fail.** An assertion that can never fire certifies nothing.
[`oracle-discrimination.test.ts`](./test/oracle-discrimination.test.ts) runs every
negative case twice against a real HTTP server — once clean (must pass), once with the
one defect that violates its requirement (must fail). A case that passes both is
reported as broken.

[`case-proof-coverage.test.ts`](./test/case-proof-coverage.test.ts) enforces the rule:
every registered case must have an entry in
[`fixtures/proof-registry.ts`](./test/fixtures/proof-registry.ts) (a defect row, a
hook-gated row, a client defect row, or a named bespoke proof). Adding a case
without a proof fails that test.

## Regression cases

Nine behaviours a reference implementation once got wrong, each now pinned by a
case with an injected-defect proof in `oracle-discrimination.test.ts`. The
implementation fixes are PDP-Connect/data-connect PR #450 (rows 1, 6, 7, 8, 9;
merged) and PR #454 (rows 2-5; open).

| # | Divergence | Case IDs | What the case asserts |
| --- | --- | --- | --- |
| 1 | A sparse `fields=` read mangled tombstones | `RS-7/tombstone-envelope-survives-sparse-fields` | After one deletion, the same resume token read with `fields=id` and with `fields=<non-key field>` still yields `{object, id, stream, deleted: true, deleted_at, emitted_at}` and no `data`. |
| 2 | `limit` applied per instance, then concatenated | `RS-1/list-page-size-bounded-by-limit-across-instances` | With a grant listing two instances of one stream, no page exceeds `limit` (100 and 30), and walking every page returns each record exactly once. |
| 3 | Multi-instance records not in `(cursor_field, primary_key)` order | `RS-1/list-sort-order-across-instances` | The walk (`order=asc`) matches the order computed from the adapter's own records: interleaved instances, equal cursors broken by key, absent cursors last. |
| 4 | `has_more: true` with no `next_cursor` on multi-instance reads | `RS-1/list-has-more-carries-next-cursor-across-instances` | Every page with `has_more: true` carries a `next_cursor`, and following them returns all records. |
| 5 | `changes_since` rejected on a multi-instance `mutable_state` grant | `RS-7/changes-since-accepted-on-multi-instance-grant` | The request is accepted (200) and the terminal page carries `next_changes_since`. |
| 6 | Owner sparse read dropped schema-required fields | `RS-1/owner-sparse-fields-keep-required-fields` | An owner read with `fields=<non-required field>` still includes each schema-required field the record carries. Client tokens are not tested here. |
| 7 | Malformed `limit` coerced instead of rejected | `RS-10/malformed-limit-rejected` | `limit=abc`, `-1`, `1.5` and `1junk` each return 400. The over-max clamp case is unchanged; `limit=0` is not asserted. |
| 8 | Ungranted stream answered 401 | `RS-6/ungranted-stream-error-classification` (existing, unchanged) | A valid client token on a stream outside its grant gets 403 `grant_stream_not_allowed`. |
| 9 | 401 for a rejected token lacked `error="invalid_token"` | `RS-16/401-carries-resource-metadata-challenge` (existing; new defect row) | A 401 for a presented, rejected token carries `WWW-Authenticate: Bearer` with `error="invalid_token"` and `resource_metadata`. A request with no token is only required to be 401. |

Rows 2-5 need a grant that lists two instance handles for one stream. A target
supplies it through the optional `issueMultiInstanceGrant` adapter hook
(`MultiInstanceFixture` in `src/harness/adapter.ts`); a target without the hook
reports those four cases `skip`, naming it. Rows 2-5 and 6 map to no
keyword-bearing clause in `matrix.ts`, because the sentences they exercise carry
no RFC 2119 keyword and no Section 9 item restates them; the cases roll up under
Section 9 RS item 1 (list records).

## Outcomes

Six, not two. `pass` and `fail` are MUST-level judgments, `advisory` records a
SHOULD-level observation on an otherwise conformant target, and the rest record an
**absence of evidence**. Only `fail` is a conformance failure.

Keeping `advisory` distinct matters more than it looks. Reporting an RFC "SHOULD
NOT" as a failed MUST tells an implementer their conforming server is
non-conformant, on a clause the specification never made binding — and a reader
has no easy way to check the citation. A root review caught the suite doing
exactly that; `test/report-honesty.test.ts` now locks the distinction.

| Outcome | Meaning |
| --- | --- |
| `pass` | The target demonstrated the required behaviour. |
| `fail` | The target violated a MUST-level requirement. Always carries captured evidence. |
| `advisory` | Every MUST the case checks was met, but a SHOULD-level recommendation the case also observed was not. Counted as passing for conformance; surfaced separately so the observation is not lost. |
| `unsupported` | The target declares the optional capability absent, so the requirement does not apply. |
| `skip` | A precondition could not be arranged. Signals an incomplete run. |
| `not-tested` | No case exists in this suite version. Generated from the catalogue. |

The denominator is the catalogue, not the executed tests: a requirement with no case
appears as `not-tested` rather than vanishing. Coverage is reported as
tested/applicable per role.

## Running it

```sh
# Against the bundled target (the suite's self-test)
pnpm --filter @pdpp/conformance-suite exec tsx src/cli.ts --target reference

# Against the PDP-Connect reference implementation: one command
PDPP_DC_REF=/path/to/data-connect \
  pnpm --filter @pdpp/conformance-suite conformance:ri
# or: PDPP_DC_REF=... packages/conformance-suite/scripts/reference-target.sh run --out ./out
```

`conformance:ri` (`scripts/reference-target.sh run`) installs the checkout if needed
(this step needs the network; it rebuilds whenever the checkout's HEAD differs from
the last build, and always for a dirty checkout), then does boot, seed, suite and
stop inside **one** `test-sandbox --net none` invocation (loopback-only network
namespace plus cgroup limits). It writes `report.json`, `report.md`,
`requirements.json`, `target.json`, `server.log`, `suite.stdout`, `suite.stderr`
and, when sandboxed, `sandbox-receipt.json` to `--out` (or `$PDPP_CONF_OUT`) and exits with the suite's exit
code. Without either, each run writes to its own fresh `./conformance-ri-out/run.XXXXXX`
(the path is printed). A named directory is locked for the run (a second run on it is
refused) and only the files a run writes are cleared from it first, so a stale report
cannot survive a failed run. If `test-sandbox` is not
on `PATH` the script says so and runs the same sequence without network isolation or
limits.

The lifecycle is one supervised run. The server is a direct child of the script, its
PID is held in memory (never a PID file) beside its kernel start time, which is re-checked
before every signal so a recycled PID is never signalled, and the exit trap stops exactly
that child;
where `setpriv` exists the kernel also stops it if the script is SIGKILLed. Each run
gets its own state directory under `$PDPP_REF_STATE_DIR` (default
`~/.tmp/pdpp-ref-target`), locked for the run and deleted on exit, so concurrent
runs cannot share a database. Ports are free ports unless `PDPP_REF_AS_PORT` /
`PDPP_REF_RS_PORT` are set (refused if in use). The committed
`targets/reference-implementation.json` is a template: each run writes `target.json`
with that run's URLs and the actual data-connect version, and the suite uses it.

**Changed:** the standalone `up`, `seed`, `status` and `stop` subcommands are gone.
They kept a server alive across invocations and trusted a PID file to stop it, which
could signal an unrelated process after PID reuse. `install` and `run` remain.

`PDPP_DC_REF` must be a data-connect checkout at the pinned commit (`PDPP_DC_PIN` in
the script; `targetVersion` in `targets/reference-implementation.json`); any other
HEAD is refused unless `PDPP_DC_ALLOW_UNPINNED=1`. The report's target version always
names the commit actually run: `data-connect@<sha10> reference-implementation`,
followed by `(UNPINNED override; pin is <sha10>)` and/or `+dirty` when that applies.
`scripts/check-expectations.ts` compares the target id and the `spec-core.md` SHA-256
before it compares outcomes.

Target configs never carry credentials. A field written as `${VAR}` resolves from
the environment at run time and fails loudly if unset: a server that mints a fresh
owner token per boot cannot have a correct value committed, and a real deployment's
credential committed by habit is a leak.

`--target` takes `reference` for the bundled target, a `.json` config describing a
deployment over HTTP, or a module whose default export returns a `TargetAdapter`.
A third-party target supplies its own adapter module via `--target <module>`. Where
an adapter cannot produce what a case needs — a field-narrowed grant, a second
subject's owner token — that case reports `skip` naming the gap rather than
passing vacuously.

**A step that fails to arrange a precondition is a `skip`, never a verdict.** An
adapter method that cannot revoke, mint a token, or issue the requested grant
throws `PreconditionFailed` (`src/harness/adapter.ts`); the runner reports the case
as `skip` with `Precondition not arranged: <step> was refused: HTTP <status>
<body excerpt>`. Returning normally from `revokeGrant` asserts the grant is revoked.
`test/precondition-honesty.test.ts` locks this with a stub target whose revoke
endpoint answers 401.

`--requirements-json FILE` writes one result per spec clause: every v0.1 MUST
clause, and the SHOULD clauses under a separate key. Each entry carries the clause
text, its `spec-core.md` line, the Section 9 items it rolls up to, the outcome of
each case that exercises it, and one `result`: `pass`, `partial` (every case passed but they exercise only part of the clause; the reason names the gap), `fail`, `not-applicable`
(the target declared the capability absent), `untestable` (review-only), `skip` (a
case could not be arranged) or `not-tested` (no case exists yet). The roll-up is
`rollUpClauseResult` in `src/report/requirements.ts`; the file's types are exported
as `@pdpp/conformance-suite/requirements-report`.

Set `SOURCE_DATE_EPOCH` to fix run timestamps for a byte-reproducible report; the
report records whether that held.

Exit codes are three-valued, because a run with no failures and partial coverage is not
a complete pass and must not be scriptable as one:

| Code | Meaning |
| --- | --- |
| `0` | Every applicable Section 9 requirement passes AND every applicable MUST clause rolls up to `pass`. A `partial`, `skip` or `not-tested` clause blocks it; review-only clauses cannot be executed and are listed in `summary.untestableMustClauses` instead. |
| `1` | At least one requirement failed. |
| `2` | No failures, but coverage is incomplete. |

## Coverage

The bundled target run tests 27 of 47 applicable requirements
(RS 15/22, AS 12/25), measured against the revised catalogue. All 27 tested
requirements pass. The target reports one resource-server skip, six
authorization-server skips, and three unsupported authorization-server
requirements. Gaps remain explicit rather
than hidden:

- **Client role (CL-1…CL-8):** Client cases use a separate `ClientUnderTest`
  contract backed by a local AS + RS fixture and an inbound request log. The
  package tests include injected-defect receipts for eleven client behaviors,
  plus a null-oracle check that no client case passes without a request. CL-1
  (the envelope-only case) and CL-6 (retention lifecycle) remain untested. The
  bundled CLI target declares only the AS and RS roles, so client cases do not
  contribute to its 23-of-34 run. External clients can provide their own adapter.
- **Authorization-code replay (AS-19).** The case remains registered, and its
  injected-response oracle test remains in the package. No bundled `TargetAdapter`
  can redeem the same authorization code twice at a live token endpoint, so a
  target without its own `replayLastCode` hook reports `skip`.
- **Consent-surface AS requirements.** What the owner is actually *shown* — requester
  identity and client-claim attribution (AS-7), AI-training consent (AS-14), and
  declaration-snapshot retention across the whole journey (AS-16) — is not observable
  from outside. A case can see what the server bound, not what it rendered, and
  asserting on a rendered surface would be testing a deployment's HTML rather than
  the protocol. These stay `not-tested` rather than being approximated.
- **Views (AS-12, AS-13) and access-mode requirements (AS-10, AS-20 on targets
  without refresh tokens)** report `unsupported` where a target declares the
  capability absent, not as passes.
- **Persisted-state and introspection-timing requirements (AS-21, RS-3)** describe
  what a server must do internally — refuse unsupported persisted state before
  handling a request, consult introspection exactly once. Both are about ordering
  and internal calls, which black-box observation cannot distinguish from a correct
  result reached differently.

Some requirements are also not black-box observable in principle. RS-9 requires
rejection "before the RS consults declaration metadata"; the suite asserts the status
and error code, and does not claim to test the ordering.


## Status against the PDP-Connect reference implementation

Measured with `conformance:ri` in `test-sandbox --net none`. One run takes about
10-15 s wall and 10 CPU-s, with a peak of about 670 MB.

| data-connect commit | MUST clauses (119) | Failing cases |
| --- | --- | --- |
| `59a3fb480e` (pinned main) | 46 pass, 4 fail, 15 skip, 18 not-applicable, 30 untestable, 6 not-tested | `AS-16/declaration-equivocation-refused-and-prior-content-retained`, `AS-17/unsupported-version-rejected`, the three `RS-1/...-across-instances` cases, `RS-7/changes-since-accepted-on-multi-instance-grant` |
| `661962dabe` (PR #454 head) | 48 pass, 2 fail, 15 skip, 18 not-applicable, 30 untestable, 6 not-tested | `AS-16/...`, `AS-17/...` |
| `0c71fbeba3` (before PR #450) | not tabulated | additionally rows 1, 7, 8 and 9 of the regression table, and `RS-10/unsupported-bracketed-shape-rejected` |

- `AS-16`: `POST /connectors` accepts different content under the same connector key
  and version and replaces the accepted content (Core Section 5, Declaration
  acceptance).
- `AS-17`: the authorization server ignores an unsupported `PDPP-Version` on PAR.
  Section 9 AS item 17 requires the AS to refuse it, while Section 8 describes
  `PDPP-Version` as part of the resource server's API contract only.
- The one advisory is `AS-8/revoked-token-introspects-inactive`: the inactive
  introspection response also discloses `subject_id`, `client_id` and `grant_id`, which
  RFC 7662 Section 2.2 says an AS SHOULD NOT do.
- The skips name the adapter hook the reference implementation cannot support black-box
  (for example an aged sync cursor or a forged introspection result).

`targets/reference-implementation.expected.json` records every case outcome and MUST
clause result at the pinned commit. `scripts/check-expectations.ts <out-dir>
targets/reference-implementation.expected.json` compares a run with it; `--update`
rewrites it. The `conformance` workflow runs the suite against the pinned commit on
every pull request that changes this package or `spec-core.md`, and fails on any
difference, so a fix or a regression appears as a reviewed change to that file.

`spec-core.md` on the `testeng/conformance-lock-v2` branch is the
`review/v0.1.0-revisions` candidate, not the adopted text. The table and
`reference-implementation.expected.json` describe the pinned commit against the
adopted spec and are not regenerated here. Regenerate them when the candidate is
adopted.

Expect coverage to differ per target: one implementing views, incremental sync, or
single-use grants moves requirements out of `unsupported` and into the tested
denominator.

## Spec revisions

`pnpm --filter @pdpp/conformance-suite spec:delta <path/to/spec-core.md>` lists the
MUST-family sentences of a candidate spec text that no clause quotes yet, and the
clauses whose text it no longer contains. The completeness test runs the same check
against this checkout's `spec-core.md` and fails on any gap.
