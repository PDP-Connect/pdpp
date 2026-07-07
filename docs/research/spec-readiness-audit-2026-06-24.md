# PDPP Spec Readiness Audit — 2026-06-24

Three-lane audit run ahead of the LFDT/DTI working-group push: (1) spec-core normative
quality, (2) reference-implementation ↔ spec divergence, (3) spec-deferred register
quality. Each lane was a single Sonnet subagent pass with file:line anchors; findings
marked VERIFIED were confirmed in code/spec text by the auditing agent. Load-bearing
findings (search-excluded-from-v0.1, closed token-kind enum) were independently confirmed
first-hand against spec-core on 2026-06-23. Treat unanchored claims as LIKELY, not fact.

## Verdict summary

| Dimension | Grade | One-line basis |
|---|---|---|
| Architecture & design maturity | A- | §8 discipline (declaration-driven capability, projection-aware `changes_since`, direction-bound cursors) is genuinely sophisticated |
| Editorial/normative hygiene | C+/B- | Real but cheap-to-fix defects (list below) |
| Spec↔RI honesty | B | Zero downward violations; large undisclosed upward surface; one real interop risk |
| Deferred register | B- | Two-thirds reasoned; one-third parked one-liners; three genres mixed |

**Readiness:** Lab filing — ready now. Working-group scrutiny — ready after ~2 days of
editorial fixes plus one strategic decision (Session Relay Profile) and one design
decision (extension mechanism).

## Lane 1 — spec-core.md normative quality (grades: rigor B-, consistency C+, WG-readiness B-)

Confirmed defects, all in `apps/site/content/docs/spec-core.md`:

1. **`description` field: normative/illustrative violation.** Required in §12
   `ManifestStream` type (L1584) and used in manifest examples (L716, L760, L818), but
   never defined in the normative §7 manifest fields table (L786–802). The exact ambiguity
   the spec's own "types are illustrative" caveat (L491, L519) promises to prevent.
2. **Stale cross-reference.** L935 cites "Section 9 conformance item 12" for self-export;
   it is item 13 (L1337).
3. **Self-export informative/normative contradiction.** §11 scope table (L1448) labels it
   "(informative)"; §8 (L935) and §9 item 13 state SHOULD-level conformance.
4. **`cursor_expired` never named in prose.** The 410 behavior is described at L179,
   L1059, L1077, §9 item 7, client item 5 — none cite the error code the table defines at
   L1268.
5. **Section scope statements**: only §7 (L691) opens with a what-it-defines/excludes
   statement in-body; §4/§5/§6/§8 rely on the front-matter table (L34–40). This is the
   named reviewer requirement ("chunk it"), half-satisfied.
6. **Lowercase normative language in framing prose**: L24, L51 (incl. literal "TODO for
   v0.2" in a published draft), L552, L839, L1295.
7. **Record envelope shape drift** (flag, maybe not a bug): ingest RECORD envelope uses
   `key` (L217–230); response record envelope uses `id`, no `key` (L1101–1111); tombstones
   use `id`. The `key`→`id` mapping is never explicitly reconciled.
8. **Untestable requirements examples**: L1295 (conformance-claim advice), L1409 (MAY with
   no observable surface), L392 ("monogram" undefined + visual design out of scope).
9. **Unpublished normative dependency:** "PDPP Session Relay Profile (not yet published)"
   cited at L85 and L1455 as the home of the flagship deployment's AS flow.

Top-5 fix order (by reviewer-trust yield): #1 description reconcile, #2 cross-ref sweep,
#3 self-export status, #4 name `cursor_expired` in prose, #5 per-section scope openers +
Session Relay decision (publish or reframe as informative-with-rationale).

## Lane 2 — RI ↔ spec divergence

**Headline: zero conformance violations found; the RI is a faithful superset.** Every
checked MUST is implemented: changes_since + tombstones + terminal `next_changes_since`,
`cursor_expired` 410, direction-bound cursors → `invalid_cursor`, expand depth-1 (nested
rejected), `expand_limit` only for declared has_many, `limit_clamped` shape,
`field_not_granted` 403, `insufficient_scope` on ungranted expand, blob three-part auth.
(Anchors: server/records.js:2139–2200, record-expand-helpers.js:127–190,
connection-id-request.js:87–113, record-filters.js:92–159,
operations/rs-blobs-read/index.ts:103–130.)

**RI-beyond-spec surface (candidate spec revisions), all VERIFIED:**

| # | Surface | Where |
|---|---|---|
| 1 | `GET /v1/streams/{stream}/aggregate` (metrics, group_by, granularity, manifest-declared `query.aggregations`) | operations/rs-streams-aggregate/, server/records.js:~975–1040, openspec RI-arch spec L811–892 |
| 2 | `GET /v1/search` + `/search/semantic` + `/search/hybrid` — full contract incl. capability advertisement + recall metadata (`meta.count_accuracy`, `meta.recall.*`) — while spec-core L1069 excludes full-text search from v0.1 | server/routes/rs-read.ts:21–25, openspec/specs/{lexical,semantic,hybrid}-retrieval/spec.md |
| 3 | `count=none\|estimated\|exact` → `meta.count` | server/records.js:538, 900–908, 2373–2420 |
| 4 | `window=none\|exact` → `meta.window{total,earliest_at,latest_at}` | server/records.js:548, 2340–2360, 2494–2560 |
| 5 | `sort` grammar distinct from `order` (cross-validated, `invalid_sort`) | server/records.js:837–850, 954–985 |
| 6 | Multi-connection addressing: `connection_id` (+ deprecated alias), cross-binding fan-in | server/connection-id-request.js, server/records.js:3556–3620 |
| 7 | Warning vocabulary beyond `limit_clamped`: `deprecated_alias_used`, `count_downgraded`, `source_skipped_not_applicable`, `partial_results`, `compatibility_fallback` | server/connection-id-request.js:58–65 |
| 8 | ~13 error codes beyond the spec table (`invalid_sort`, `ambiguous_connection` 409, `grant_consumed` 403, `provider_pressure_cooldown` 425, …) | server/routes/ref-error-status.ts:86–137 |
| 9 | **Third token kind**: `pdpp_token_kind: "mcp_package"` + `grant_package_id` + `inactive_reason` on introspection — spec presents a closed `owner\|client` enum | server/auth.js:6707–6731, openspec/specs/agent-consent-bundling/spec.md |
| 10 | Bulk stream erasure `DELETE /v1/streams/{stream}/records` | server/routes/rs-mutation.ts:755–838 |
| 11 | `GET /v1/connectors`, `GET /v1/schema` discovery | server/routes/rs-read.ts:626–1095 |

**Interop risk (the one with teeth):** an RS/client written strictly to spec-core would
mishandle `mcp_package` tokens. Spec needs either an extensibility rule ("unknown
`pdpp_token_kind` MUST be treated as inactive") or a Core-level package concept.

**Protocol-shaped text hiding in RI-only openspec files:** the three retrieval specs, the
closed warnings vocabulary (RI-arch spec L7426–7451), the aggregate contract (L811–892),
agent-consent-bundling. Interoperability-grade content no external implementer can find.

**RI-internal notes:** `count=exact` is a stub on the Postgres backend
(server/records.js:2422–2431 — cross-backend divergence in the RI's own extension);
`changes_since` is rejected across multi-connection fan-in (single-binding precondition a
spec-only reading wouldn't anticipate).

**Strategic recommendation (agent judgment, owner-endorsed direction pending):** define an
extension/advertisement mechanism in Core (capabilities.*, registry posture for warnings/
error codes/token kinds) rather than promoting search/aggregate into Core. Makes the RI
honest instead of quietly heretical; small spec delta; strong WG topic.

## Lane 3 — spec-deferred.md register quality

20 items. ~Two-thirds REASONED (best entries: predicate scoping #1, event-driven triggers
#6, view naming #7, grant identity #10, privacy-hostile defaults #20 — the standout).
~One-third PARKED one-liners: secret handling #16, mid-run cancellation #18, record-level
errors #19, point-in-time reconstruction #9, AS interface #8 (thin).

Structural problems: three genres mixed under one heading (open design questions /
implementation TODOs / already-closed decisions); wildcard expansion #11 is recorded as
deferred but is actually decided; the historical-corrections section is changelog. A
standards reviewer accepts it as an internal parking lot, not a rigorous concerns
register. **Fix: restructure into open-questions / decided / implementation-TODO** (an
afternoon).

WG-candidate items per this lane: #1 predicate scoping, #2 active erasure, #6 event-driven
triggers, #7 view naming, #10 signing/trust scheme, #12 purpose-code registry, #14
JWS/PAR profiling, #20 privacy defaults (strongest — values-laden, explicitly undecided,
cited precedent).

## Cross-cutting: the doc-vs-spec overclaim

External docs (whitepaper/Lab proposal) say the grant is "cryptographically bound and not
modifiable after issuance." Spec-core L1383: "designed to be signable… deferred to a
future version." The overclaim generated an external reviewer's (Harvard) persistence
questions verbatim. Fix the external doc; the spec is correct.

## Correction (2026-07-06)

Lane 2's headline — "zero conformance violations found; the RI is a faithful superset" —
holds for what that lane actually checked: §8 runtime enforcement behaviors
(changes_since, cursors, expand, error codes, blob auth). It does NOT extend to the
grant/request document shape. A subsequent docs-inventory audit found spec-core §5/§6
STALE on the source-binding shape: top-level `connector_id` was removed from the request
and grant contract as a BREAKING change by the archived OpenSpec change
`2026-04-30-unify-source-binding-vocabulary`; the implemented contract is
`source: { kind: 'connector' | 'provider_native', id }`
(packages/reference-contract/src/public/index.ts SourceObjectSchema), and the RI rejects
the spec-documented top-level scalar with 400 `invalid_request`
(reference-implementation/server/auth.js, normalizeAuthorizationDetail). A client written
to the published §5/§6 text could not obtain a grant. Spec fix: the
`spec-source-binding-alignment` PR (stacked on the editorial-hygiene PR).
