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
those sentences for Core sections 4-8 and 10 — 131 clauses, each with its
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

# Against the Vana Personal Server's composed AS + RS.
# vana-target.sh checks out the pinned ref, installs, builds, boots, seeds both
# streams, and prints the per-boot owner token for the run to pick up.
export PDPP_VANA_PS=/path/to/personal-server-ts
scripts/vana-target.sh up
eval "$(scripts/vana-target.sh env)"
pnpm --filter @pdpp/conformance-suite exec tsx src/cli.ts \
  --target targets/vana-personal-server.json
scripts/vana-target.sh stop

# Against the real reference implementation (AS + RS)
scripts/reference-target.sh up
pnpm --filter @pdpp/conformance-suite exec tsx src/cli.ts \
  --target targets/reference-implementation.json \
  --json report.json --markdown report.md
scripts/reference-target.sh stop
```

Each real target has a script that owns its whole lifecycle, because the setup is
not incidental to the result: which streams are declared and how many records they
hold decides whether five requirements are *tested* or merely *skipped*. A recipe
in prose lets a later reader reproduce the commands but not the coverage. Both
scripts poll for readiness rather than sleeping, and `stop` terminates only the PID
it recorded — never a pattern match.

Target configs never carry credentials. A field written as `${VAR}` resolves from
the environment at run time and fails loudly if unset: a server that mints a fresh
owner token per boot cannot have a correct value committed, and a real deployment's
credential committed by habit is a leak.

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

Against the bundled target, this version tests 16 of 30 applicable requirements
(RS 11/14, AS 5/16). Requirements the target declares absent — incremental sync,
views, single-use grants, refresh tokens, blobs, and RFC 7662 introspection, which
a co-located deployment need not expose — report `unsupported` and leave the
applicable denominator rather than counting as passes. The gaps are deliberate and
recorded rather than hidden:

- **Client role (CL-1…CL-8):** Batch 19 adds a separate `ClientUnderTest` contract
  backed by a local AS + RS fixture and an inbound request log. Eleven client-capture
  clauses now have executable cases and injected-defect receipts against the real
  `@pdpp/mcp-server` transport client. CL-1 (the envelope-only case) and CL-6
  (retention lifecycle) remain untested; the bundled target does not declare the
  client role, so client cases appear only when a client adapter is supplied.
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

## Status against a real implementation

The suite runs against the PDP-Connect reference implementation's real
authorization and resource servers, and reports two findings that reproduce
independently.

**Target:** `reference-implementation/server/index.ts` in the data-connect
repository, started with separate AS and RS ports. `ReferenceAsAdapter` drives the
real consent journey over HTTP — RFC 7591 client registration, PAR, owner review
and approval, grant issuance, revocation — so the grant-shape cases execute rather
than skipping. Config: `targets/reference-implementation.json`.

**Result: 15 of 37 applicable tested, 13 passed, 2 failed MUSTs, 1 advisory.**

Bring the target up reproducibly with `scripts/reference-target.sh up`, then run
the suite against `targets/reference-implementation.json`.

| Requirement | Level | Finding |
| --- | --- | --- |
| RS-6 | **Failed MUST** | A grant covering `repositories` correctly denies `starred` — enforcement passes as RS-2 — but with 401 `context.stream_not_allowed`. Section 9 RS item 6 requires structured errors as the Section 8 table defines, and that table binds stream-not-in-grant to 403 `grant_stream_not_allowed`. A classification defect, not an access-control one: a client branching on the documented code will not recognise this response. |
| RS-16 | **Failed MUST** | The `WWW-Authenticate` challenge on a rejected token omits `error="invalid_token"`. This is PDPP's own requirement, not an inherited one: RFC 6750 Section 3 does not mandate the attribute, while spec-core.md states the resource server "MUST set `error=\"invalid_token\"` when a token was presented and rejected". |
| AS-8 | Advisory (SHOULD) | Revocation is correctly reflected as `active: false`, which is all Core Section 9 AS item 8 pins. The inactive introspection response additionally discloses `subject_id`, `client_id` and `grant_id`. RFC 7662 Section 2.2 says an AS **SHOULD NOT** include that, and Core does not raise it to a MUST — so this is a recommendation, not a conformance failure. A holder of a revoked token string can still learn whose it was. |

All three reproduce with curl against the running server, independent of the suite.
Everything else currently testable passes: stream membership, field projection,
cross-subject isolation, self-export, token-kind-from-introspection, client-token
filter and expansion rejection, unknown-parameter rejection, version negotiation,
metadata projection, RFC 9728 metadata, revocation enforcement at the RS,
single-use consumption, resolved-grant expansion, introspection extension fields,
and introspection caller authentication.

The one skip is expired-grant enforcement: the adapter cannot fabricate a grant
that has already expired against this AS.

### Second target: the Vana Personal Server's composed AS + RS

Run against `personal-server-ts` @ `waspflow/pdpp-integrated-journey-0917`
(`5e98085`) — the integration owner's composed tree, carrying both PDPP halves.
Config: `targets/vana-personal-server.json`. Bring it up with
`scripts/vana-target.sh up`.

A resource-server-only ref is not a target on its own, which is worth stating
because it is an easy mistake to make from a PR number alone:
`feat/pdpp-record-storage-rs` carries the RS fixes but deletes the authorization
server outright — no `routes/pdpp-auth.ts`, no `pdpp/bootstrap.ts` — so the consent
journey cannot run there and a run would report skips rather than findings.
`scripts/vana-target.sh` refuses such a ref rather than producing a thin report.

**Result: 20 of 33 applicable tested, 20 passed, 0 failed, 2 skips.** Exit code 2:
no failures, coverage incomplete — which is not the same as a complete pass, and
the exit code says so.

The most recent batch took coverage from 13 to 20 by testing the authorization
server's own decisions rather than only the resource server's enforcement. Seven
requirements moved out of `not-tested`, all passing, none by relaxing anything:

| Requirement | What is now tested |
| --- | --- |
| AS-2 | A selection naming an undeclared stream, an undeclared field, or an undefined preset is refused as `invalid_authorization_details`. |
| AS-4 | A stream requested with no field list is expanded to the explicit declared list before issuance, not stored as an open reference. |
| AS-5 | Requests carrying both `streams` and `selection_preset`, and neither, are both refused. |
| AS-6 | An unregistered `purpose_code` is *not* refused — the inverted case, where the defect is over-refusal. |
| AS-17 | An unsupported `PDPP-Version` on a selection request returns 400 `unsupported_version`. |
| AS-20 | Refresh tokens rotate; replaying a superseded token returns `invalid_grant`, revokes the family, and kills the family's access tokens. |
| RS-7 | A record deleted after a sync cursor was issued comes back as a tombstone (`deleted: true`, no `data`) when that cursor resumes. |

Two properties of this batch are worth stating because they are what makes the
passes mean anything. Every negative case carries a **positive control** that
differs in exactly one property and must be accepted, so a server that refuses all
selection requests fails rather than passes. And every one is in the
discrimination matrix with an injected defect, so each has been shown able to fail
before being trusted to pass — including AS-6, whose defect makes the reference
target reject an unregistered purpose that a conforming server must allow.

AS-20 deserves its three separate legs. A server that rotates but never detects
reuse looks healthiest of all: the legitimate client's rotation succeeds while a
stolen token keeps working. So the case checks rotation, then refusal of the
superseded token, then — the leg a refusal alone does not prove — that an access
token from the revoked family actually stops serving records.

All three MUSTs this suite reported against this target are now fixed, each
confirmed by re-running the same case that found it:

| Requirement | Was | Now |
| --- | --- | --- |
| RS-10 | Unknown query parameter served 200, silently dropped | `400 invalid_request`, naming the parameter in `error.param` |
| RS-6 | Malformed cursor returned `500 INTERNAL_ERROR` | `400 invalid_cursor`, with a valid cursor still paginating |
| RS-16 | A *rejected* token got a bare 401, no challenge | `401` with `WWW-Authenticate` on both the missing- and rejected-token paths |

RS-16 is worth recording in more detail than its one-line fix suggests, because the
first attempt at it fixed a different defect. `20a65d6` made the challenge's
`resource_metadata` absolute rather than relative — a real RFC 9728 §5.1
improvement, but one this suite had recorded as an *observation it explicitly did
not report*. The finding was about which path emits a challenge at all:
`authenticate()` built one only on its `!token` branch, so a token that was present
and rejected by `resolveToken` returned a bare 401. `8e1c518` attaches the challenge
where the 401 is emitted rather than at each call site, so a future 401 path cannot
omit it. Both paths now answer identically:

```console
$ curl -sD- -o /dev/null http://127.0.0.1:8420/v1/streams/top_artists/records
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer error="invalid_token", resource_metadata="http://127.0.0.1:8420/.well-known/oauth-protected-resource"

$ curl -sD- -o /dev/null http://127.0.0.1:8420/v1/streams/top_artists/records \
    -H 'Authorization: Bearer pdpp-conformance-invalid-token'
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer error="invalid_token", resource_metadata="http://127.0.0.1:8420/.well-known/oauth-protected-resource"
```

The fix deliberately does **not** challenge on a grant-level refusal: a revoked or
expired *grant* answers `403 grant_revoked` / `403 grant_expired` with no challenge,
because that is an authorization outcome and a challenge would point the client at
the wrong remedy. This suite does not currently test that distinction — it is the
implementation's own regression coverage, recorded here so the gap is visible rather
than assumed closed.

This target uses a different authorization journey from the reference — a session
opened at `/pdpp/v1/authorize`, reviewed by digest, approved against that digest,
then an authorization code exchanged with PKCE, rather than RFC 9126 PAR plus a
consent endpoint. Core pins neither: Section 6 defines the selection request and
Section 7 the resolved grant, not the route between them. Both are conformant, and
the case bodies never learn which journey produced the token they were handed. That
is the strongest available evidence that the suite tests the protocol rather than
one deployment's habits.

Coverage rose from 8 tested to 13 because the target now declares a second stream,
not because any oracle was relaxed. Stream-membership enforcement (RS-2) and its
error classification (RS-6) work by holding one stream *out* of the grant, so with
a single declared stream they could only report `skip`. Both now pass.

RS-6 here is the one place where the two targets in this README disagree, and the
disagreement runs against the reference. A client token granted `top_artists` is
refused `saved_tracks` with `403 grant_stream_not_allowed` — what the Section 8
error table specifies — where the reference implementation answers `401
context.stream_not_allowed` for the same situation. **The reference is the one that
fails this requirement.** Saying so plainly matters: a reader who assumes the
reference implementation is normative would draw the opposite conclusion, and
Section 8's table, not any implementation, is what the suite judges against.

```console
$ curl -s -w '\nHTTP %{http_code}\n' http://127.0.0.1:8420/v1/streams/saved_tracks/records \
    -H "Authorization: Bearer $CLIENT_TOKEN"
{"error":{"type":"permission_error","code":"grant_stream_not_allowed",
  "message":"Grant does not include stream 'saved_tracks'", ...}}
HTTP 403
```

Two cases still skip rather than pass vacuously: this deployment binds one owner,
so there is no foreign subject for RS-12, and the adapter cannot fabricate an
already-expired grant for AS-8.

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
