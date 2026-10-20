# Record-read baseline — 20 October 2026

Both unmodified targets returned suite exit **1**. Neither target is labelled conformant. Counts are executable AS/RS cases; skipped hooks and unsupported optional capabilities are separate outcomes.

| Target | Pass | Fail | Skip | Unsupported | Advisory | Report |
| --- | --- | --- | --- | --- | --- | --- |
| Reference | 70 | 5 | 12 | 7 | 1 | [JSON](reference-v01/report.json), [Markdown](reference-v01/report.md), [binding](reference-v01/baseline.json) |
| External personal server | 70 | 3 | 15 | 7 | 0 | [JSON](ps-v01/report.json), [Markdown](ps-v01/report.md), [binding](ps-v01/baseline.json) |

Runner commit: `b4ea865c27b9ccb8059a3a14117304c621fac381`. Normative suite/spec base: `541ebc38f0794d5c7c2d09198a978471dd61733e`. Both source snapshots were clean and had the same digest. Core text SHA-256: `80a38c963f777541ab10325e292291255c65df9211499b39e7f8eaf0083ad6b2`.

Reference target: `PDP-Connect/data-connect@e94f4fd9c6683e8284143dbccf29a12bc7370b94`. External target: `vana-com/personal-server-ts@0b5eac036a33cb714cdd6d3a71abddd98e609f2d`. Both checkouts were clean. See [reproduction instructions](../../BASELINE.md).

## Pre-existing target failures

| Owner | Case | Observation |
| --- | --- | --- |
| PDP-Connect/data-connect | `AS-17/unsupported-version-rejected` | A selection request declaring PDPP-Version 1999-01-01 returned 201 rather than 400. Section 9 AS item 17 requires the AS to refuse a version it does not implement: proceeding instead means the client and server disagree about the contract while both believe they agree. |
| PDP-Connect/data-connect | `RS-1/list-page-size-bounded-by-limit-across-instances` | With limit=100, page 1 held 140 records. Core Section 8: limit is "Records per page"; applying it per instance and concatenating lets a page exceed it. |
| PDP-Connect/data-connect | `RS-1/list-sort-order-across-instances` | Rows are not in (seen_at, primary key) order across instances: row 2 is "a001", expected "b000" (140 rows seen, 140 expected). |
| PDP-Connect/data-connect | `RS-1/list-has-more-carries-next-cursor-across-instances` | Page 1 reported has_more: true with no next_cursor, so a client cannot continue past it although 140 records span the grant's instances. |
| PDP-Connect/data-connect | `RS-7/changes-since-accepted-on-multi-instance-grant` | changes_since on a grant listing 2 instances of a mutable_state stream returned 400. Section 9 RS item 7 obliges changes_since for mutable_state streams, with no exemption for multi-instance grants. |
| vana-com/personal-server-ts | `RS-1/owner-sparse-fields-keep-required-fields` | With fields=name the owner read dropped schema-required field(s) id from record "art_1". Core Section 8: "Schema-required fields are always included." |
| vana-com/personal-server-ts | `RS-7/paginated-sync-session-anchored-to-one-horizon` | Following next_cursor within a changes_since session returned 400. |
| vana-com/personal-server-ts | `RS-10/malformed-limit-rejected` | Core Section 8 requires unsupported query shapes to be rejected with HTTP 400, but: limit=1.5 -> 200; limit=1junk -> 200. |

The four reference multi-instance failures are tracked separately by [data-connect #454](https://github.com/PDP-Connect/data-connect/pull/454), open at `661962dabe5b4d26982d312d1e4d7efc14ae16aa` when checked. Its patch is not applied. [PDPP #447](https://github.com/PDP-Connect/pdpp/pull/447) remains an unadopted candidate at `9cd44bb88adbb9f06eaaca50f184687a4cb01406`. The historical default reference pin remains `59a3fb480e7f3e2d68d46b1e4ee2cb23d505d113`; only its newly exercised shared-blob and time-range-negative expectations changed.

## Hook gaps and owners

The exact skipped-case reason is retained in each target’s `baseline.json` and raw report. Adapter work belongs to `PDP-Connect/pdpp`; a missing target operation belongs to the target repository shown below. A skipped precondition is not a protocol verdict.

| Target | Skipped cases | Owner and missing evidence |
| --- | --- | --- |
| reference-v01 | `AS-7/valid-url-hosted-client-identity-accepted` | PDP-Connect/pdpp: URL-hosted identity adapter or separate ClientUnderTest request log |
| reference-v01 | `AS-7/malformed-url-hosted-client-identity-refused` | PDP-Connect/pdpp: URL-hosted identity adapter or separate ClientUnderTest request log |
| reference-v01 | `AS-7/client-does-not-override-display-descriptions` | PDP-Connect/pdpp: URL-hosted identity adapter or separate ClientUnderTest request log |
| reference-v01 | `AS-8/expired-grant-refused` | PDP-Connect/data-connect: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| reference-v01 | `AS-15/rendered-client-claims-bound-with-attribution` | PDP-Connect/data-connect: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| reference-v01 | `AS-16/provider-native-source-id-mismatch-refused` | PDP-Connect/pdpp: declaration provisioning/readback bridge; positive control must be accepted before negative assertions |
| reference-v01 | `AS-16/key-field-not-declared-in-schema-refused` | PDP-Connect/pdpp: declaration provisioning/readback bridge; positive control must be accepted before negative assertions |
| reference-v01 | `AS-16/consent-time-field-not-declared-in-schema-refused` | PDP-Connect/pdpp: declaration provisioning/readback bridge; positive control must be accepted before negative assertions |
| reference-v01 | `AS-16/embedded-schema-remote-reference-refused` | PDP-Connect/pdpp: declaration provisioning/readback bridge; positive control must be accepted before negative assertions |
| reference-v01 | `RS-4/unrecognized-token-kind-is-unauthorized` | PDP-Connect/data-connect: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| reference-v01 | `RS-7/expired-sync-cursor-reported-as-gone` | PDP-Connect/data-connect: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| reference-v01 | `RS-11/unsupported-grant-schema-version-rejected` | PDP-Connect/data-connect: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `AS-3/issued-grant-artifact-matches-section-7-schema` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `AS-3/client-claims-stay-outside-the-resolved-grant` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `AS-7/valid-url-hosted-client-identity-accepted` | PDP-Connect/pdpp: URL-hosted identity adapter or separate ClientUnderTest request log |
| ps-v01 | `AS-7/malformed-url-hosted-client-identity-refused` | PDP-Connect/pdpp: URL-hosted identity adapter or separate ClientUnderTest request log |
| ps-v01 | `AS-7/client-does-not-override-display-descriptions` | PDP-Connect/pdpp: URL-hosted identity adapter or separate ClientUnderTest request log |
| ps-v01 | `AS-10/single-use-grant-consumed` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `AS-16/declaration-equivocation-refused-and-prior-content-retained` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-1/list-page-size-bounded-by-limit-across-instances` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-1/list-sort-order-across-instances` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-1/list-has-more-carries-next-cursor-across-instances` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-4/unrecognized-token-kind-is-unauthorized` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-7/expired-sync-cursor-reported-as-gone` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-7/changes-since-accepted-on-multi-instance-grant` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-11/unsupported-grant-schema-version-rejected` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |
| ps-v01 | `RS-12/foreign-subject-cannot-read` | vana-com/personal-server-ts: target operation/readback or controlled fixture; PDP-Connect/pdpp: corresponding adapter hook |

PS explicitly refuses a grant selecting two instances of one stream with HTTP 400 `unsupported_instance_fan_in` / “Select one connection per stream”. The four affected cases remain **skip**, not unsupported or pass.

The reference’s AS-10 pass observes repeated approval refusal. It does not independently isolate atomic reissuance against a consumed grant from approval/code replay checks. PS has no same-consumed-grant reissue hook and skips AS-10. A real same-grant replay seam remains work for the target owners and the PDPP adapter; authorization-code replay is covered separately by AS-19.

The current cases also leave same-key cross-connection delete/cursor isolation, full multi-instance delta correctness, and client-grant tombstone isolation unproven. These coverage additions belong to `PDP-Connect/pdpp`. Existing horizon and tombstone passes are single-stream observations, not a replica merge proof.

Clause-level gaps remain in `requirements.json`, including MUST clauses with no executable case and review-only obligations. Both targets have five not-tested Section 9 requirements: AS-1, AS-11, AS-21, RS-3, and RS-5. The zero in executable case counts does not include these unimplemented requirement cases.

## Additional evidence

Both targets pass three separate connection-choice probes: explicit first connection, explicit second connection with the same record keys, and no implicit fan-in. See [reference probes](reference-v01/instance-choice-probes.json) and [PS probes](ps-v01/fixture-probes.json). These do not inflate normative case counts.

All four [injected defects](defect-injection.md) cause their matching cases to fail; the five focused assertions pass. The full suite has **362 passing tests**, zero failures; typecheck, lint, and the conformance-suite accounting run pass. [SIGTERM cleanup](ps-signal-proof.json) observed both owned child processes gone and runner exit 143.

Experimental v0.2 is separate: [PS probes](ps-v01/experimental-v0.2.md) have **2 pass / 0 fail** (narrowed record read and v0.2 minimum rejected on v0.1). [Reference v0.2](reference-experimental-v0.2.md) is **not tested**. The suite has no v0.2 requirement inventory, so neither result is a v0.2 conformance assessment.

Confidence is high for these pinned loopback observations and their reported outcomes. Deployed behavior, replica imports, concurrency under same-grant replay, and complete Core coverage remain unverified.
