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

**Black-box and adapter-driven.** Cases speak HTTP to a target's `baseUrl`. The only
seam is [`TargetAdapter`](./src/harness/adapter.ts), which supplies the two things a
black-box client cannot do for itself: obtain credentials (Core §8 leaves owner-token
acquisition out of scope) and seed known records (grant enforcement against an empty
store passes vacuously). No case imports an implementation. The bundled reference
target under `src/targets/` implements the same contract and holds no privilege.

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

## Outcomes

Five, not two. `pass` and `fail` are judgments; the rest record an **absence of
evidence** and are never folded into a numerator.

| Outcome | Meaning |
| --- | --- |
| `pass` | The target demonstrated the required behaviour. |
| `fail` | The target demonstrated a violation. Always carries captured evidence. |
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

# Against the real reference implementation (AS + RS)
pnpm --filter @pdpp/conformance-suite exec tsx src/cli.ts \
  --target targets/reference-implementation.json \
  --json report.json --markdown report.md
```

`--target` takes `reference` for the bundled target, a `.json` config describing a
deployment over HTTP, or a module whose default export returns a `TargetAdapter`.
The JSON form means pointing the suite at a real implementation is a config change
rather than a code change: see `targets/reference-implementation.json`. Where an
adapter cannot produce what a case needs — a field-narrowed grant, a second
subject's owner token — that case reports `skip` naming the gap rather than
passing vacuously.

Set `SOURCE_DATE_EPOCH` to fix run timestamps for a byte-reproducible report; the
report records whether that held.

Exit codes are three-valued, because a run with no failures and partial coverage is not
a complete pass and must not be scriptable as one:

| Code | Meaning |
| --- | --- |
| `0` | Every applicable MUST was tested and passed. |
| `1` | At least one requirement failed. |
| `2` | No failures, but coverage is incomplete. |

## Coverage

Against the bundled target, this version tests 11 of 33 applicable requirements
(RS 10/16, AS 1/17). Four AS requirements report `unsupported` because that target
is co-located and exposes no RFC 7662 introspection endpoint, so they leave the
applicable denominator rather than counting as passes. The gaps are deliberate and
recorded rather than hidden:

- **Client role (CL-1…CL-8): entirely untested.** Client conformance requires driving
  a client under test and observing its outgoing requests. The adapter has no reverse
  channel — it only lets the suite call *into* a target. Closing this needs a
  client-adapter hook, a harness change rather than a test-authoring one. Every client
  case returns `skip` with the specific missing hook named. The reference target does
  not declare the client role, so those requirements are scoped out of its report
  entirely; they appear only for a target that claims the role.
- **Most AS requirements.** Consent-surface rendering (AS-7), snapshot retention
  (AS-16), and approval-revision binding (AS-15) are not observable over the record
  query interface. They need an AS-side adapter surface. Four AS requirements
  (AS-3, AS-8, AS-9, AS-18) do have executable cases that read the RFC 7662
  introspection response, which Section 8 makes the authoritative enforcement
  context; they run against any target declaring `separatedDeployment`.
- **`changes_since` (RS-7, RS-8)**, views, blobs, and single-use grants are declared
  unsupported by the reference target and report as `unsupported`, not as passes.

Some requirements are also not black-box observable in principle. RS-9 requires
rejection "before the RS consults declaration metadata"; the suite asserts the status
and error code, and does not claim to test the ordering.

## Status against a real implementation

The suite runs against the PDP-Connect reference implementation's real
authorization and resource servers, and reports two findings that reproduce
independently.

**Target:** `reference-implementation/server/index.ts` in the data-connect
repository, started with separate AS and RS ports. `ReferenceAsAdapter` drives the
real consent journey over HTTP — RFC 7591 client registration, PAR, owner review
and approval, grant issuance, revocation — so the grant-shape cases execute rather
than skipping. Config: `targets/reference-implementation.json`.

**Result: 15 of 37 applicable tested, 12 passed, 3 failed MUSTs, one skip.**

Bring the target up reproducibly with `scripts/reference-target.sh up` (pinned
install, readiness polling, PID-tracked lifecycle), then run the suite against
`targets/reference-implementation.json`.

| Finding | Detail |
| --- | --- |
| RS-2 | A grant covering `repositories` correctly denies `starred`, but with 401 `context.stream_not_allowed`. Section 8 maps stream-not-in-grant to 403 `grant_stream_not_allowed`. Access control holds; the classification differs, and a client branching on the documented code will not recognise it. |
| RS-16 | The `WWW-Authenticate` challenge on a rejected token omits `error="invalid_token"`, which RFC 6750 Section 3 requires when a token was presented and refused. |
| AS-8 | After an owner-authenticated revoke the AS correctly reports `active: false`, but the inactive introspection response still carries `subject_id`, `client_id` and `grant_id`. RFC 7662 Section 2.2 requires an inactive response to carry no information about the token, so a holder of a revoked token string can still learn whose it was and what it covered. |

All three reproduce with curl against the running server, independent of the suite.
Everything else currently testable passes: stream membership, field projection,
cross-subject isolation, self-export, token-kind-from-introspection, client-token
filter and expansion rejection, unknown-parameter rejection, version negotiation,
metadata projection, RFC 9728 metadata, revocation enforcement at the RS,
single-use consumption, resolved-grant expansion, introspection extension fields,
and introspection caller authentication.

The one skip is expired-grant enforcement: the adapter cannot fabricate a grant
that has already expired against this AS.

### The apps/site sandbox is not this target

An earlier revision of this file reported an RS-16 failure against the public
sandbox that `apps/site` serves under `/sandbox/v1`. That was a category error and
is withdrawn. The sandbox is a demo with no authorization layer — its routes
hardcode an owner actor and read no `Authorization` header — and it makes no
conformance claim. Its behaviour is not a product defect and is not reported as
one. `targets/site-sandbox.json` is retained only as harness plumbing: it exercises
the HTTP adapter and the declared-query-base path against a server that mounts its
surface somewhere other than `/v1`.

### Why running against the real server changed the suite

Three cases that failed on first contact were defects in the suite, not the server:

- RS-2 and RS-15 compared returned fields against the fields *requested*. Section 5
  requires schema-required fields in every resolved allowlist, so a conforming AS
  widens a narrow request — and the cases read that correct behaviour as a leak.
  They now judge against the fields the grant actually resolved.
- RS-12 and RS-13 read a 400 as a scoping failure when the deployment simply
  requires `connector_id` on owner reads. `ownerReadParams` carries that
  convention, and both now pass.

A fourth, found earlier, was the hardcoded `/v1` prefix that Core deliberately does
not fix. None of these would have surfaced against a purpose-built fixture.

Expect coverage to differ per target: one implementing views, incremental sync, or
single-use grants moves requirements out of `unsupported` and into the tested
denominator.
