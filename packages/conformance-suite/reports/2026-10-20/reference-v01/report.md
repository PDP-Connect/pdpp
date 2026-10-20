# Conformance report: pdpp-reference-implementation

Suite: pdpp-conformance-suite v0.1.0
Spec: PDPP Core v0.1.0, Section 9 (spec-core.md)
Clause inventory: spec revision v0.1 (the adopted draft)
Target: pdpp-reference-implementation vdata-connect@e94f4fd9c6683e8284143dbccf29a12bc7370b94 reference-implementation at http://127.0.0.1:48055 (roles: resource-server, authorization-server)
Run: started 2026-10-20T13:58:46.902Z, finished 2026-10-20T13:58:48.612Z

## Coverage

Coverage (tested/applicable): 23/34 (67.6%)
Passed/tested: 20/23
Failed: 3

A pass count alone does not describe this run. Read coverage first: a suite that tested a third of applicable requirements and passed all of them is not equivalent to a complete run.

Clause coverage at v0.1: 85/119 MUST-level clauses have at least one case (71.4%), and 36 roll up to pass, out of 144 clauses in force at this revision. A clause with a case can still be partial or skipped; only "roll up to pass" counts toward completion.

The two numbers above measure different things. Requirement coverage counts Section 9 items, which are one-line summaries; clause coverage counts the normative sentences behind them. The second is always the harder number, and changing the spec revision changes its denominator.

## Disclaimer

This report records observed behaviour only. It does not confer any status on the target. Conferring status is the technical committee's act under GOVERNANCE.md Section 5, and no output of this suite substitutes for it.

## Legend

| Marker | Meaning |
| --- | --- |
| `PASS` | The target demonstrated the required behaviour. |
| `ADVISORY` | The target met every MUST the case checks, but did not follow a SHOULD-level recommendation. Not a conformance failure; see Advisories below. |
| `FAIL` | The target demonstrated a violation. |
| `UNSUPPORTED` | The target declares the optional capability absent; the requirement does not apply. Not a pass. |
| `SKIP` | The case could not run for an environmental reason. Absence of evidence, not a pass. |
| `NOT TESTED` | No case exists in this suite version for the requirement. Absence of evidence, not a pass. |

`UNSUPPORTED`, `SKIP`, and `NOT TESTED` all mean the suite has no evidence for that requirement. None of them may be read as a pass.

## Coverage by role

| Role | Total | Applicable | Tested | Passed | Failed | Skipped | Unsupported | Not tested |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| resource-server | 16 | 16 | 12 | 10 | 2 | 2 | 0 | 2 |
| authorization-server | 21 | 18 | 11 | 10 | 1 | 4 | 3 | 3 |

## Failures

### Failed MUSTs

### AS-17 (#errors)

- Case `AS-17/unsupported-version-rejected`
  - Assertion: An unsupported PDPP-Version on a selection request returns 400 unsupported_version.
  - Detail: A selection request declaring PDPP-Version 1999-01-01 returned 201 rather than 400. Section 9 AS item 17 requires the AS to refuse a version it does not implement: proceeding instead means the client and server disagree about the contract while both believe they agree.

### RS-1 (#resource-server-interface)

- Case `RS-1/list-page-size-bounded-by-limit-across-instances`
  - Assertion: With a grant listing two instances of one stream, no page exceeds limit, and walking every page returns each record exactly once.
  - Detail: With limit=100, page 1 held 140 records. Core Section 8: limit is "Records per page"; applying it per instance and concatenating lets a page exceed it.
- Case `RS-1/list-sort-order-across-instances`
  - Assertion: With a grant listing two instances, records come back in (cursor_field, primary_key) order across the instances, absent cursor values last.
  - Detail: Rows are not in (seen_at, primary key) order across instances: row 2 is "a001", expected "b000" (140 rows seen, 140 expected).
- Case `RS-1/list-has-more-carries-next-cursor-across-instances`
  - Assertion: With a grant listing two instances, every page that reports has_more: true carries a next_cursor that resumes the walk.
  - Detail: Page 1 reported has_more: true with no next_cursor, so a client cannot continue past it although 140 records span the grant's instances.

### RS-7 (#list-records)

- Case `RS-7/changes-since-accepted-on-multi-instance-grant`
  - Assertion: changes_since on a mutable_state grant listing two instances is accepted, and the terminal page carries next_changes_since.
  - Detail: changes_since on a grant listing 2 instances of a mutable_state stream returned 400. Section 9 RS item 7 obliges changes_since for mutable_state streams, with no exemption for multi-instance grants.

### Failed SHOULDs

None.


## Advisories

These cases record SHOULD-level observations. Other cases for the same requirement may fail; those appear under Failures.

### AS-8 (#revocation)

- Case `AS-8/revoked-token-introspects-inactive`
  - Assertion: After revocation, introspection reports active false (MUST); extra disclosure on the inactive response is reported as advisory (RFC 7662 SHOULD NOT).
  - Detail: Revocation is correctly reflected (active: false), which is what Core Section 9 AS item 8 requires. The inactive introspection response additionally disclosed subject_id, client_id, grant_id. RFC 7662 Section 2.2 says an authorization server SHOULD NOT include that information, and Core does not raise that clause to a MUST, so this is a recommendation rather than a conformance failure. A holder of a revoked token string can still learn whose it was and what it covered.


## Not tested

Requirements below have no case in this suite version. The gap is listed here rather than left implicit.

| Requirement | Role | Level | Spec anchor |
| --- | --- | --- | --- |
| AS-1 | authorization-server | must | #conformance |
| AS-11 | authorization-server | must | #conformance |
| AS-21 | authorization-server | must | #errors |
| RS-3 | resource-server | must | #token-introspection |
| RS-5 | resource-server | must | #list-records |

## All requirements

| Requirement | Role | Level | Outcome | Spec anchor |
| --- | --- | --- | --- | --- |
| AS-1 | authorization-server | must | NOT TESTED | #conformance |
| AS-2 | authorization-server | must | PASS | #conformance |
| AS-3 | authorization-server | must | PASS | #grant |
| AS-4 | authorization-server | must | PASS | #grant |
| AS-5 | authorization-server | must | PASS | #selection-request |
| AS-6 | authorization-server | must | PASS | #selection-request |
| AS-7 | authorization-server | must | SKIP | #client-claims |
| AS-8 | authorization-server | must | SKIP | #revocation |
| AS-9 | authorization-server | must | PASS | #token-introspection |
| AS-10 | authorization-server | must | PASS | #access-modes |
| AS-11 | authorization-server | must | NOT TESTED | #conformance |
| AS-12 | authorization-server | must | UNSUPPORTED | #views |
| AS-13 | authorization-server | must | UNSUPPORTED | #views |
| AS-14 | authorization-server | must | PASS | #ai-training-consent |
| AS-15 | authorization-server | must | SKIP | #grant |
| AS-16 | authorization-server | must | SKIP | #declaration-acceptance |
| AS-17 | authorization-server | must | FAIL | #errors |
| AS-18 | authorization-server | must | PASS | #token-introspection |
| AS-19 | authorization-server | must | PASS | #conformance |
| AS-20 | authorization-server | must | UNSUPPORTED | #access-modes |
| AS-21 | authorization-server | must | NOT TESTED | #errors |
| RS-1 | resource-server | must | FAIL | #resource-server-interface |
| RS-2 | resource-server | must | PASS | #resource-server-interface |
| RS-3 | resource-server | must | NOT TESTED | #token-introspection |
| RS-4 | resource-server | must | SKIP | #token-introspection |
| RS-5 | resource-server | must | NOT TESTED | #list-records |
| RS-6 | resource-server | must | PASS | #errors |
| RS-7 | resource-server | must | FAIL | #list-records |
| RS-8 | resource-server | must | PASS | #list-records |
| RS-9 | resource-server | must | PASS | #list-records |
| RS-10 | resource-server | must | PASS | #list-records |
| RS-11 | resource-server | must | SKIP | #errors |
| RS-12 | resource-server | must | PASS | #resource-server-interface |
| RS-13 | resource-server | should | PASS | #resource-server-interface |
| RS-14 | resource-server | must | PASS | #stream-metadata |
| RS-15 | resource-server | must | PASS | #stream-metadata |
| RS-16 | resource-server | must | PASS | #protected-resource-metadata |

## Clause coverage

Each Section 9 item summarizes normative clauses in Core sections 4-8 and 10. The clauses behind each item are listed here, and any MUST-level clause with no case is named with the gap that blocks it. A requirement marked `PASS` may still have uncovered clauses: the marker describes the cases that ran, not the whole item.

Full inventory at this revision: `docs/reference/conformance-normative-matrix.md`.

### AS-1 (NOT TESTED)

Clauses: `10.3-2`

Every MUST-level clause under this item has at least one case.

### AS-2 (PASS)

Clauses: `5.2-4`, `6.8-1`, `6.8-2`, `6.8-3`, `6.9-1`

Every MUST-level clause under this item has at least one case.

### AS-3 (PASS)

Clauses: `6.3-3`, `7.1-1`, `7.2-4`, `10.3-1`

Uncovered MUST clauses:

- `10.3-1`: "Tamper-sensitive" names a design posture, not a wire behaviour; the spec defers grant signing and a formal token format to a future version, so there is no observable artifact to check.

### AS-4 (PASS)

Clauses: `6.8-3`, `7.2-1`

Every MUST-level clause under this item has at least one case.

### AS-5 (PASS)

Clauses: `6.8-1`

Every MUST-level clause under this item has at least one case.

### AS-6 (PASS)

Clauses: `6.5-1`, `A.0-1`

Every MUST-level clause under this item has at least one case.

### AS-7 (SKIP)

Clauses: `5.3-2`, `5.3-3`, `5.3-4`, `5.4-2`, `5.8-7`, `6.1-1`, `6.1-2`, `6.1-4`, `6.1-5`, `6.1-6`, `6.1-7`, `6.1-8`, `6.1-9`, `6.1-10`, `6.1-11`, `6.2-2`, `6.3-1`, `6.4-1`, `6.5-2`, `7.2-6`

Uncovered MUST clauses:

- `5.4-2`: A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed.
- `5.8-7`: The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges.
- `6.1-5`: Which source the AS resolved from is visible only on the consent surface it renders, which is not black-box observable.
- `6.1-6`: A display obligation on the consent surface; a case can see what the AS bound into the grant, not what it rendered.
- `6.1-8`: Trust-signal rendering is a consent-surface obligation; not observable over the protocol surface this suite drives.
- `6.1-9`: Consent-surface wording obligation; not observable without asserting on a deployment's rendered text.
- `6.1-10`: Missing fixture: an inbound HTTP endpoint named as an unverified client's `logo_uri` that logs requests, plus a way to open the consent surface so a fetch triggered by rendering it is seen. The harness hosts a request-logging fixture for client identity documents (src/tests/client-identity.ts serveDocument) but has no consent-render hook. A fetch made by the owner's browser, rather than the AS, would be seen only if the fixture logs it; the verified-client and proxied-asset exceptions need local policy knowledge the suite lacks.
- `6.3-1`: A visual-register obligation on the consent surface. This is the clause AS-7 chiefly summarizes, and it is the clearest example of a MUST that is not black-box observable in principle.
- `6.4-1`: The normative core of AS-7, and not observable over HTTP: a case can see what the server bound, not what it rendered.
- `6.5-2`: The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam.

### AS-8 (SKIP)

Clauses: `2.2-3`, `10.2-2`, `10.2-7`, `10.2-10`, `10.7-1`

Uncovered MUST clauses:

- `10.2-2`: Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support.

### AS-9 (PASS)

Clauses: `10.2-3`, `10.2-4`

Every MUST-level clause under this item has at least one case.

### AS-10 (PASS)

Clauses: `7.5-1`, `7.5-2`

Every MUST-level clause under this item has at least one case.

### AS-11 (NOT TESTED)

Clauses: `7.1-1`, `7.2-0`

Every MUST-level clause under this item has at least one case.

### AS-12 (UNSUPPORTED)

Clauses: `5.6-2`

Every MUST-level clause under this item has at least one case.

### AS-13 (UNSUPPORTED)

Clauses: `5.6-2a`

Every MUST-level clause under this item has at least one case.

### AS-14 (PASS)

Clauses: `6.7-1`, `A.0-2`

Every MUST-level clause under this item has at least one case.

### AS-15 (SKIP)

Clauses: `6.3-2`, `7.2-1`, `7.2-2`, `7.2-3`, `7.2-4`, `7.2-5`, `7.2-6`

Every MUST-level clause under this item has at least one case.

### AS-16 (SKIP)

Clauses: `5.2-1`, `5.2-5`, `5.8-1`, `5.8-2`, `5.8-3`, `5.8-4`, `5.8-5`, `5.8-6`, `5.8-7`, `5.8-8`, `10.1-1`

Uncovered MUST clauses:

- `5.2-1`: What the AS treated as authenticated is an internal trust decision; from outside, an accepted and a rejected declaration differ only by whether consent proceeded, which does not discriminate this clause.
- `5.8-1`: The former case submitted a non-normative top-level `authority` member to an operator declaration-onboarding hook. Core defines the accepted authority as AS-side acceptance metadata and gives `SourceDeclaration` no such document member; this surface cannot observe a client introducing authority during authorization. A client-authorization fixture with an overridable source identifier is required.
- `5.8-3`: Restates 5.2-1 as an acceptance obligation; what the AS relied on internally is not observable from a request outcome.
- `5.8-5`: Missing fixture: an inbound HTTP endpoint serving a candidate declaration that logs each request the AS makes (credentials sent, redirect targets followed, remote schema retrieval). The harness already hosts one for client identity documents (src/tests/client-identity.ts serveDocument) but has no hook to offer an AS a declaration pointer to retrieve. The HTTPS requirement needs a TLS fixture, and the connection-bound address check is internal to the AS, so those parts stay unobservable even with the fixture.
- `5.8-6`: A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client.
- `5.8-7`: The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges.

### AS-17 (FAIL)

Clauses: `8.14-1`

Every MUST-level clause under this item has at least one case.

### AS-18 (PASS)

Clauses: `2.2-1`, `8.2-1`, `8.2-2`, `10.2-1`

Uncovered MUST clauses:

- `8.2-2`: The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer.

### AS-19 (PASS)

Clauses: `10.2-5`

Every MUST-level clause under this item has at least one case.

### AS-20 (UNSUPPORTED)

Clauses: `10.2-3`, `10.2-6`, `10.2-7`

Every MUST-level clause under this item has at least one case.

### AS-21 (NOT TESTED)

Clauses: `7.4-3`, `10.2-8`

Uncovered MUST clauses:

- `7.4-3`: An ordering obligation over internal persisted state: the suite would need to write a legacy-shaped record into the target's store, which the adapter deliberately cannot do, and even then could not observe that the refusal happened *before* route handling.
- `10.2-8`: An upgrade-path obligation over pre-existing persisted state: the suite would have to plant legacy tokens in the target's store before boot, which the adapter deliberately cannot do.

### RS-1 (FAIL)

Clauses: `8.12-1`, `8.12-2`, `8.12-3`

Every MUST-level clause under this item has at least one case.

### RS-2 (PASS)

Clauses: `8.1-2`, `8.12-1`

Every MUST-level clause under this item has at least one case.

### RS-3 (NOT TESTED)

Clauses: `2.2-1`, `2.2-2`, `8.1-1`, `8.2-1`, `8.2-2`, `8.2-4`, `10.2-1`, `10.2-2`

Uncovered MUST clauses:

- `2.2-2`: The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer, as at 8.2-2.
- `8.1-1`: Needs a separated AS/RS target plus a clock the case controls: the suite would have to revoke a grant and prove the RS stops serving within 60 seconds, which no current target topology supports.
- `8.2-2`: The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer.
- `10.2-2`: Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support.

### RS-4 (SKIP)

Clauses: `8.1-3`, `8.2-3`

Every MUST-level clause under this item has at least one case.

### RS-5 (NOT TESTED)

Clauses: `8.1-1a`

Every MUST-level clause under this item has at least one case.

### RS-6 (PASS)

Clauses: `8.9-11`

Every MUST-level clause under this item has at least one case.

### RS-7 (FAIL)

Clauses: `4.3-1`, `4.3-2`, `4.3-6`, `4.3-7`, `8.9-13`, `8.9-14`

Every MUST-level clause under this item has at least one case.

### RS-8 (PASS)

Clauses: `4.3-5`, `8.9-14`, `8.9-15`

Every MUST-level clause under this item has at least one case.

### RS-9 (PASS)

Clauses: `8.9-2`, `8.9-3`, `8.9-4`, `8.9-5`, `8.9-9`, `8.9-10`

Every MUST-level clause under this item has at least one case.

### RS-10 (PASS)

Clauses: `8.9-5`, `8.9-7`, `8.9-8`

Every MUST-level clause under this item has at least one case.

### RS-11 (SKIP)

Clauses: `7.4-2`, `8.14-1`

Every MUST-level clause under this item has at least one case.

### RS-12 (PASS)

Clauses: `8.3-1`

Every MUST-level clause under this item has at least one case.

### RS-13 (PASS)

Clauses: `8.3-2`

Every MUST-level clause under this item has at least one case.

### RS-14 (PASS)

Clauses: `8.9-6`

Every MUST-level clause under this item has at least one case.

### RS-15 (PASS)

Clauses: `5.8-8`, `8.1-2`, `8.7-1`

Every MUST-level clause under this item has at least one case.

### RS-16 (PASS)

Clauses: `8.4-1`, `8.4-2`, `8.4-3`, `8.4-4`

Uncovered MUST clauses:

- `8.4-4`: Whether the target's authorization-server set is enumerable is not declared anywhere the suite can read, so the presence or absence of the member cannot be judged; closing this needs a target-config field stating enumerability.

### Uncovered MUST clauses under no Section 9 item

10 MUST-level clauses have no case AND summarize to no Section 9 item, so no heading above lists them. They are counted in the clause numbers at the top of this report, so without this list the denominator would move for reasons the reader cannot look up. These clauses are gaps in Section 9's conformance list.

- `3.0-1`: Binds the personal server's read of an upstream platform, a hop outside the Core HTTP surface a client can reach; no Section 9 item names it and no black-box hook exposes the upstream request.
- `3.0-2`: Onward transfer of a token happens outside the protocol exchange; a client-capture fixture sees only the client's own requests, and no Section 9 client item names this obligation.
- `4.5-2`: The rejection half binds a write interface the Collection Profile defines, which Core's read-only query surface cannot reach; the read half could be checked but no Section 9 item claims it.
- `5.4-1`: No Section 9 item covers it, so `requirementIds` stays empty. Core explicitly permits streams that cannot define a stable `consent_time_field` to omit it, so the former negative fixture (`time_range_capable` with no consent field) did not violate this clause. A valid black-box fixture would need to observe the AS deriving a consent boundary from `cursor_field`; the declaration submission surface exposes neither that derived state nor a normative capability member.
- `7.4-1`: A design constraint on implementations rather than a checkable wire behaviour; its observable consequences are the three axis rows, recorded separately as 7.4-2, AS-17, and RS-11.
- `10.4-1`: Binds the Collection Profile's INTERACTION channel, which Core's HTTP surface does not expose; logs and persisted state are outside what a black-box client can read.
- `12.3-1`: Whether a stream name "encodes predicate logic" is a semantic judgement no static check settles. The paragraph is headed "(non-normative)" yet carries a MUST NOT; recorded at the keyword's level and flagged for the spec lock.
- `12.4-1`: Needs a target that offers an extension capability and a hook that enables it; the suite has no such fixture. Missing case: a grant's reachable data is identical with the extension enabled and disabled.
- `12.4-2`: No case yet checks that each capability a target exercises is advertised in its declared metadata. Missing case: cross-check stream metadata and protected resource metadata against the capabilities the target answers.
- `12.4-3`: Needs a client fixture response that advertises an unknown capability; no Section 9 client item names it. Missing case: the client under test completes its flow against metadata carrying an undeclared capability.


## Review evidence

These packets are human-review evidence for clauses the executable suite cannot observe. They do not create cases, change coverage, or count as tested.

| Clause | Status | Claim | Evidence files | Reviewed by | Date |
| --- | --- | --- | --- | --- | --- |
| — | — | No review evidence attached. | — | — | — |
