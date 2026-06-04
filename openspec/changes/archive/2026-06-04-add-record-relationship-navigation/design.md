# Design — add-record-relationship-navigation

## Context

The current state at HEAD `e043f403`:

- `openspec/specs/reference-implementation-architecture/spec.md` requirement "Public record expansion SHALL be declaration-gated and one-hop" already establishes the one-hop, manifest-declared, grant-scoped expansion contract. The "Expansion pushes child-stream narrowing into SQL" scenario states the join shape precisely: `WHERE child.foreign_key IN (…N parent keys…)`.
- `reference-implementation/server/record-expand-helpers.js` exports `normalizeExpandRequest`, which both the SQLite (`records.js`) and Postgres (`postgres-records.js`) backends use to validate `expand[]` / `expand_limit[]` against the parent stream's manifest. The hydration SQL in both backends filters `child.<foreign_key>` against the parent record-key page (`records.js:1719`, `postgres-records.js:587`). The child's own identity is its `primary_key`; the `foreign_key` is a distinct field on the child carrying the parent key.
- `packages/reference-contract/src/public/index.ts` defines the `expand_capabilities` items schema with `name`, `relation`, `stream`, `target_stream`, `cardinality`, `foreign_key`, `default_limit`, `max_limit`, `granted`, `usable`, `reason`. Only `name`, `stream`, `cardinality`, `granted`, `usable` are required today. `target_stream` and `foreign_key` already exist as optional properties.
- `reference-implementation/server/index.js` `buildExpandCapabilities` emits `name`, `stream` (= `relationship.stream`, the child stream), `cardinality`, `granted`, `usable`, `foreign_key` (when present), `default_limit`/`max_limit` (when present), and `reason: 'related_stream_not_granted'` for a not-granted target. It does **not** currently emit `target_stream`.
- Zero polyfill connector manifests declare `relationships[]` **on a first-party GitHub stream**. Gmail and Slack already declare their own `query.expand[]` entries (covered by the 2026-04-24 / 2026-05-28 archives); GitHub declares none. The GitHub `issues` / `pull_requests` records carry a `repository_id` value and a `user_id` value, but neither is a required property; `user_stats` carries a required `user_id`.
- The operator console at `apps/console/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` calls `getRecord` with no `expand` parameter, prints the envelope as raw JSON, and offers no cross-record links.

This is the gap this change closes: the protocol-level wiring exists end-to-end and is tested; no GitHub manifest advertises relationships and the operator surface does not navigate them.

Prior art: `docs/research/record-relationship-navigation-prior-art-2026-06-04.md`.

### The key-field semantics (the v1 correction)

The v1 proposal conflated two distinct things and named them as one (`target_key_field`, "the field on the related stream whose value identifies the parent record"), then wrote scenarios that used that field as if it identified the **child/target** record. Those two readings are contradictory, and the second is wrong against the implementation. The precise model is:

| Concept | Lives on | Holds | Example (`repositories → issues`) |
| --- | --- | --- | --- |
| `target_stream` | n/a (names a stream) | the child stream name | `issues` |
| `child_parent_key_field` (= manifest `foreign_key`) | the **child** record (`issues`) | the **parent** record's key | `repository_id`, valued with the repo's key |
| child's own record key | the **child** record (`issues`) | the child's identity | `id` |
| parent's own record key | the **parent** record (`repositories`) | the parent's identity | `id` |

Consequences this design must respect:

1. For `repositories → issues`, the parent links to a **filtered child list** (`issues?filter[repository_id]=<repo_id>`), not to a single issue detail page derived from `repository_id`. `repository_id` is not an `issues` record key.
2. A child `issues.repository_id` can link **back** to `/repositories/<repository_id>` precisely because `repository_id` holds the parent repository's key. That is a console navigation affordance, not server-side reverse expansion.
3. Server-side reverse expansion (`issues → repositories`) stays impossible without a new contract, because there is no foreign key on the parent pointing at the child; the archived 2026-04-24 design already records this ("the foreign key is on the parent, not the related stream" — i.e. reverse lookup needs different semantics).

## Goals

1. Make relationship navigation usable on the operator console without changing the protocol's one-hop discipline.
2. Hold the line that **manifests are the only source of truth** for relationships; refuse to ship console heuristics.
3. Cover at least one GitHub join end-to-end so the contract has live first-party coverage and a reference shape future connectors can copy — using only a join the existing manifest validator already accepts.
4. Define a calm, normative behavior for the case where a manifest declares a relationship the current grant cannot read.
5. Name the child's parent-key field precisely so a console builds correct navigation (parent → filtered child list; child field → parent detail) and never mistakes the parent key for a child key.

## Non-goals

- Reverse / belongs-to **server** expansion (`issues → repositories`, `user_stats → user`). Held until a separate change designs reverse-edge manifest declaration. The existing `Scenario: Message-to-thread reverse expansion remains out of scope` stays in force.
- Declaring `repositories → issues` / `repositories → pull_requests`. Held until the child parent-key field is made required (or the validator gains an explicit absent-key policy). See D5.
- Multi-hop / dotted `expand=child.grandchild`. Held.
- Cross-connector navigation (e.g. a Gmail message linking to a Calendar event). Out of scope; the grant model is per-connector.
- Backfill of relationships for any connector other than GitHub. Chase, USAA, Reddit, ChatGPT, YNAB, Claude Code follow as separate slices.
- Auto-detected foreign-key heuristics on either server or console. PostgREST's `PGRST201` lesson stands.
- Edge-typed metadata (Relay edges with own attributes). The parent payload already carries any per-link metadata.

## Decision

### D1. The manifest is the only source of truth for relationships

Loose heuristics are explicitly forbidden in both server and console:

- The server already requires manifest declaration; no change.
- The console SHALL discover relations exclusively from `expand_capabilities` returned by `GET /v1/streams/<s>`. It SHALL NOT inspect raw payload fields to guess at links.
- Prior art alignment: Stripe (expansion declared in API reference), PostgREST (`PGRST201` refuses ambiguous joins rather than guessing), JSON:API (`include` paths must match declared relationship names).

### D2. `expand_capabilities` gains required, precisely-named target fields

New required fields on each `expand_capabilities` entry:

- `target_stream` — the related **child** stream the relation points at. Equal to the value the builder already computes as `stream` (= `relationship.stream`). Kept as a distinct, explicitly-named field so a reader does not have to infer "is `stream` the parent or the child?" from context. Required.
- `child_parent_key_field` — the field **on the child (target) record** whose value holds the **parent** record's key. This is the same field the manifest declares as `foreign_key` and that the server filters on during hydration. Required.

`foreign_key` remains emitted as a back-compat alias carrying the identical value. The canonical, self-describing name going forward is `child_parent_key_field`, which states three facts the v1 name hid: the field lives on the **child**, its value is the **parent's** key, and it is therefore *not* the child's own record key.

This is additive: the server already has `relationship.stream` and `relationship.foreign_key` in hand inside `buildExpandCapabilities`; it emits them under the new names too.

Explicitly rejected name: `target_key_field` (v1). It reads as "the key field of the target", which a reader will interpret as the target/child's own key — the exact mistake this change corrects.

### D3. Unreadable targets remain visible as inert entries

Today an `expand_capabilities` entry with `usable: false` is emitted for a not-granted target with `reason: 'related_stream_not_granted'`, but the presence rule is not normative for the unknown / not-loaded cases. Without a normative presence rule, a console cannot tell "no relationship declared" apart from "relationship declared but not readable here", and would have to choose between hiding both cases (loses information) or surfacing fake links (lies to the operator).

This change makes the presence rule normative:

- If the parent manifest declares a relation that is enabled in `query.expand[]`, the stream metadata response SHALL include an entry in `expand_capabilities` for it.
- If the target stream is outside the grant, absent from the manifest, or not loaded, the entry SHALL be present with `usable: false` and a `reason` from a defined enum: `related_stream_not_granted`, `related_stream_unknown`, `related_stream_not_loaded`. `related_stream_not_granted` matches the value the server emits today; the other two are additive.
- The operator console SHALL render unreadable relations as inert text (not a hyperlink), with the `reason` surfaced as a tooltip-style advisory string. No error toast.

Prior art alignment: JSON:API omits unreachable records from `included` but still preserves relationship identifiers on the parent — same intent, simpler envelope for a single-resource server.

### D4. Console navigation construction

The operator console renders relationships in two places. The direction of each link follows directly from the key-field semantics in Context:

- **Record detail page** (`/dashboard/records/<conn>/<stream>/<recordKey>`):
  - A "Related" section lists every `expand_capabilities` entry for the current stream.
  - For each entry with `usable: true`:
    - `has_many`: render a link to the related child stream's **list page filtered by the parent key**: `/dashboard/records/<conn>/<target_stream>?filter[<child_parent_key_field>]=<parent_record_key>`. This is the only correct target — the parent record key is not a child record key, so a child *detail* URL must not be constructed from it. (If a particular child stream has not declared the necessary `exact_filter` capability for `child_parent_key_field`, the link MAY be omitted and the relation rendered as an inert chip with a "list filter unavailable" advisory. The `filter[]` contract is unchanged by this proposal.)
    - `has_one`: render a link to `/dashboard/records/<conn>/<target_stream>/<child_record_key>` only when the parent record carries the child's record key for that relation. (No first-party GitHub `has_one` relation ships in this change; the rule is defined for completeness and for connectors that declare one.)
  - For each entry with `usable: false`, render inert text with the `reason` as advisory.
- **Child record page** — list (`/dashboard/records/<conn>/<stream>`) and detail:
  - A field that matches the `child_parent_key_field` of a declared forward relation renders as a link to the **parent** record's detail page: `/dashboard/records/<conn>/<parent_stream>/<child_record[child_parent_key_field]>`. The field's value is the parent's key, so this link is well-formed.

The console does not request `expand[]` to draw these links — the parent record already carries its own key (for the has_many list filter) and the child record already carries `child_parent_key_field` (for the back-link). Inline expand stays opt-in; this change does not require the console to request inline expansion.

### D5. GitHub first-party relationships — scoped to what the validator accepts

The GitHub connector emits today (see `packages/polyfill-connectors/connectors/github/schemas.ts` and the generated `manifests/github.json`):

- `repositories` — primary key `id`; required `[id, full_name]`.
- `issues` — primary key `id`; required `[id]`; carries nullable `repository_id`, nullable `user_id`.
- `pull_requests` — primary key `id`; required `[id]`; carries nullable `repository_id`, nullable `user_id`.
- `user` — primary key `id`; required `[id, login]`.
- `user_stats` — primary key `id` (`"{user_id}:{YYYY-MM-DD}"`); required `[id, user_id, observed_on]`; carries required `user_id`.
- `starred`, `gists` — no repo/user-anchored navigation that helps an operator; out of scope.

The existing manifest validator (proven by `reference-implementation/test/query-contract.test.js`, "first-party manifests declare only parent-to-child query.expand entries with FK on child") requires a relation's `foreign_key` to be a **required** top-level property of the child schema, "to avoid silent drops" of children whose key is null.

Declared relationship in this change:

- `user → user_stats` — `has_many`, `foreign_key=user_id` (required on `user_stats`), `default_limit=30`, `max_limit=365`. Passes the existing validator.

**Not** declared (deferred, with reason):

- `repositories → issues` and `repositories → pull_requests` — would use `foreign_key=repository_id`, but `repository_id` is **nullable / not required** on the `issues` and `pull_requests` child schemas. They would **fail** the existing validator. v1 declared them anyway; this is the concrete feasibility blocker v1 missed. Enabling them requires either (a) making `repository_id` (and the `user_id` link, if wanted) a required property on the child schemas — a connector-schema change with its own fixture/snapshot review — or (b) a separate change that relaxes the "fk must be required" rule with an explicit, tested policy for null-keyed children (skip vs. surface). Either is out of scope here and is the obvious next slice.
- `commits` — not present in the GitHub manifest at all (not merely "broken/fake"). No relationship can point at it.
- Reverse links (`user_stats → user`, `issues → repositories`, `pull_requests → repositories`) — intentionally absent from the manifest. The console still renders the child-to-parent **hyperlink** (D4 child-record rule) because the child payload carries the parent key — no relationship declaration is required to link a field whose value is a valid parent record key (see D6).

### D6. Symmetric console linking does not require symmetric manifest declaration

If a forward relation `A → B` is declared (`has_many` with `child_parent_key_field b_parent_id` on the `B` child, valued with the `A` record key), the console MAY render `b_parent_id` on a `B` record as a link to the matching `A` record's detail page, because the relation's existence proves both streams are named and the field value is a valid `A` record key.

This is a console-only navigation affordance. It does **not** define a server-side reverse expansion: `GET /v1/streams/B/records?expand=<reverse>` still fails with `invalid_expand` unless and until a separate change defines reverse-edge manifest semantics. The console-side link only constructs `/dashboard/records/<conn>/A/<b_record.b_parent_id>`; no `expand[]` is issued.

This keeps server behavior strict (manifest-only) while making the console navigation usable today. Prior art alignment: Airtable's linked-record cells navigate in both directions while the underlying foreign key is still declared one-way.

### D7. What this does not change

- The `expand[]` request semantics: still one-hop, still manifest-declared, still grant-scoped, still subject to `expand_limit`.
- The grant model: relationships do not extend the grant; the child stream must be granted to be expanded server-side.
- The protocol: `spec-*.md` is untouched.
- The MCP adapter, retrieval, attachments, blob hydration: untouched.

## Alternatives considered

### A1. Use raw payload heuristics on the console

Pro: zero manifest work.
Con: violates the established no-heuristics principle (PostgREST `PGRST201` lesson). Would create false links the moment a payload field is renamed or a different connector adopts a different id shape.

Rejected.

### A2. Keep v1's `target_key_field` name

Pro: no rename churn.
Con: the name reads as "the target's key field", which a reader interprets as the child's own key. v1's own scenarios used it both ways and at least one direction is wrong against the implementation (`repository_id` is not an `issues` key). The corrected `child_parent_key_field` name encodes the true semantics. `foreign_key` is retained as the back-compat alias so existing readers are unaffected.

Rejected.

### A3. Declare `repositories → issues` / `repositories → pull_requests` now (as v1 did)

Pro: maximizes GitHub navigability immediately.
Con: both fail the existing manifest validator because `repository_id` is nullable / not required on the child schemas. Shipping them requires a child-schema change (make the field required) or a validator policy change for null-keyed children — each a reviewable change of its own. Bundling that here re-introduces the exact silent-drop risk the validator was built to prevent.

Rejected for this change; tracked as the next slice.

### A4. Define reverse-edge manifest declaration in this change

Pro: cleanly answers "how do I get from an issue to its repository?" on the server too.
Con: doubles scope. The existing 2026-04-24 archive intentionally deferred reverse expansion and the spec already has `Scenario: Message-to-thread reverse expansion remains out of scope`. Designing reverse expansion well (one direction declares, other is inferred? both must declare? how is the parent's pointer expressed when no field on the parent holds the child key?) deserves its own change.

Rejected for this change; tracked as a follow-up slice.

### A5. Backfill every first-party connector at once

Pro: maximizes navigability.
Con: every connector touches different review surfaces (auth, fixtures, manifest validation, grant fixtures, snapshots). Bundling them in a relationship-navigation change drags review time and risk. Connector-specific backfill follows the GitHub pattern this change establishes.

Rejected for this change; each connector becomes its own slice.

### A6. Generate a relationship graph endpoint

Pro: a single GraphQL-like endpoint could front the whole graph.
Con: graph-product framing, violates voice ("a graph traversal product"). The console doesn't need it; per-stream `expand_capabilities` plus per-record envelope is enough.

Rejected.

### A7. Add an opt-in console toggle to inline-expand on record detail

Pro: lets an operator see the related body in place.
Con: the existing `expand[]` mechanism already supports this; once the console knows declared relations it can pass `?expand=…` if a follow-up adds a UI affordance. Not required for navigation.

Deferred.

## Acceptance checks

The change is acceptable when:

1. `packages/reference-contract/src/public/index.ts` requires `target_stream` and `child_parent_key_field` on every `expand_capabilities` entry, documents the `reason` enum, and an `expand_capabilities` entry exists for every enabled parent-stream relation regardless of `usable` value.
2. The reference server's `buildExpandCapabilities` emits `target_stream` (= child stream) and `child_parent_key_field` (= manifest `foreign_key`, mirrored), keeps `foreign_key` as a back-compat alias, and emits inert (`usable: false`) entries with one of the defined `reason` enum values for unreadable targets.
3. The GitHub connector manifest declares `user → user_stats` (`has_many`, `foreign_key=user_id`, `default_limit=30`, `max_limit=365`) in both `relationships[]` and `query.expand[]`, and the existing "FK on child must be required" manifest test passes on it. The manifest declares no `repositories → issues`, `repositories → pull_requests`, `commits`, or reverse relation.
4. New query-contract tests prove:
   - `GET /v1/streams/user/records?expand=user_stats` hydrates `user_stats` by `user_id` under a grant that includes both streams, and each hydrated child carries `user_id` equal to the parent user key.
   - `GET /v1/streams/user/records?expand=user_stats` returns `insufficient_scope` when the grant excludes `user_stats`.
   - `GET /v1/streams/user_stats/records?expand=user` returns `invalid_expand` (reverse expansion is not declared).
   - `GET /v1/streams/repositories/records?expand=issues` returns `invalid_expand` (relation not declared in this change).
   - Stream metadata for a `user`-only grant emits an `expand_capabilities` entry for `user_stats` with `usable: false` and `reason: related_stream_not_granted`.
   - Stream metadata for a both-granted `user` emits the `user_stats` entry with `target_stream: "user_stats"`, `child_parent_key_field: "user_id"`, `foreign_key: "user_id"`, and `usable: true`.
5. Operator console regression tests cover:
   - Record detail page renders a "Related" section listing `usable: true` relations as links and `usable: false` relations as inert text with the `reason` advisory.
   - A `has_many` relation links to the child list page filtered by `child_parent_key_field` = parent key, and does **not** build a child detail URL from the parent key.
   - A child record's `child_parent_key_field` field renders as a link to the parent record's detail page.
   - The console does not call `getRecord(..., { expand: … })` solely to draw links.
6. `openspec validate add-record-relationship-navigation --strict` and `openspec validate --all --strict` both pass.

## Residual risks

- The `reason` enum is narrow. If a future grant model introduces a new failure mode (`related_stream_in_grant_but_blocked_by_field_projection`, say), the enum will need an additive entry. Documented as additive expansion only.
- The console-only symmetric link affordance (D6) creates a UI link where the server would refuse `expand`. If the destination parent record is missing on the related stream, the navigation lands on a "not found" detail page. This is acceptable behavior (it's how Airtable and Notion both handle dead links) but should be exercised by a console regression test.
- Only one GitHub join ships. The dashboard's most visible relationship (a repository's issues / PRs) stays unlinked until the deferred child-schema change lands. This is an intentional honesty tradeoff: shipping a join that fails manifest validation, or silently dropping null-keyed children, is worse than shipping less. The follow-up slice is named in D5.
- Backfill for other connectors will follow the same shape but is not validated by this change. If a future connector's relationship shape doesn't fit `has_one`/`has_many` + single foreign-key (e.g., many-to-many through a join stream), a follow-up change must extend the cardinality vocabulary; not a regression in this change.
