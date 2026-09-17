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
# Against the bundled reference target
pnpm --filter @pdpp/conformance-suite exec tsx src/cli.ts --target reference

# Against your own implementation
pnpm --filter @pdpp/conformance-suite exec tsx src/cli.ts \
  --target ./my-adapter.ts \
  --json report.json --markdown report.md
```

`--target` takes a module whose default export returns a `TargetAdapter`. Set
`SOURCE_DATE_EPOCH` to fix run timestamps for a byte-reproducible report; the report
records whether that held.

Exit codes are three-valued, because a run with no failures and partial coverage is not
a complete pass and must not be scriptable as one:

| Code | Meaning |
| --- | --- |
| `0` | Every applicable MUST was tested and passed. |
| `1` | At least one requirement failed. |
| `2` | No failures, but coverage is incomplete. |

## Coverage

Against the reference target, this version tests 11 of 36 applicable requirements
(RS 10/16, AS 1/20). The gaps are deliberate and recorded rather than hidden:

- **Client role (CL-1…CL-8): entirely untested.** Client conformance requires driving
  a client under test and observing its outgoing requests. The adapter has no reverse
  channel — it only lets the suite call *into* a target. Closing this needs a
  client-adapter hook, a harness change rather than a test-authoring one. Every client
  case returns `skip` with the specific missing hook named. The reference target does
  not declare the client role, so those requirements are scoped out of its report
  entirely; they appear only for a target that claims the role.
- **Most AS requirements.** Consent-surface rendering (AS-7), snapshot retention
  (AS-16), and approval-revision binding (AS-15) are not observable over the record
  query interface. They need an AS-side adapter surface.
- **`changes_since` (RS-7, RS-8)**, views, blobs, and single-use grants are declared
  unsupported by the reference target and report as `unsupported`, not as passes.

Some requirements are also not black-box observable in principle. RS-9 requires
rejection "before the RS consults declaration metadata"; the suite asserts the status
and error code, and does not claim to test the ordering.
