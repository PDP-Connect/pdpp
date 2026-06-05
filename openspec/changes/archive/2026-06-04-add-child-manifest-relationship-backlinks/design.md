# Design — add-child-manifest-relationship-backlinks

## Context

State at HEAD `4dc31030`:

- The companion change `add-record-relationship-navigation` (implemented on main, not yet archived) added server `expand_capabilities` target naming (`target_stream`, `child_parent_key_field`), the GitHub `user -> user_stats` join, and operator-console relationship rendering. Its console requirements live only in its change delta; they are not yet folded into `openspec/specs/reference-implementation-architecture/spec.md` (`child_parent_key_field` appears zero times in the durable spec today).
- That change's console contract sources child-to-parent links from the **parent** stream's `expand_capabilities` (`findParentBackLink` in `apps/console/src/app/dashboard/records/lib/relationships.ts`), and states the console "SHALL discover these renderings exclusively from `expand_capabilities`."
- Only three first-party streams enable `query.expand[]`, so only they emit `expand_capabilities`: `gmail.messages -> message_bodies, attachments`; `github.user -> user_stats`; `slack.messages -> message_attachments, reactions`. All are forward relations.
- Every other declared relationship across first-party manifests is a child-side belongs-to edge. The archived `2026-05-28-expand-first-party-parent-child-relations` audit (`design-notes/audit.md`) enumerates them — Chase, USAA, YNAB, ChatGPT, Anthropic, Claude Code, Codex, Amazon, DoorDash, HEB, Loom, WhatsApp, and the Slack belongs-to edges — and records that "the current engine cannot serve them" forward, so they are "left as descriptive metadata; they are not enabled through `query.expand`."
- The operator console reads connector manifests directly from the bundled filesystem path (`apps/console/src/app/dashboard/lib/rs-client.ts` `listConnectorManifests`, `MANIFESTS_DIR = .../packages/polyfill-connectors/manifests`), not from a server endpoint. The child-declared `relationships[]` are therefore available to the console regardless of the deployed reference revision or the live `expand_capabilities` response.
- Commit `00a66cdd` added `childHasOneBackLinksFromManifest`: it reads the displayed child stream's own manifest `relationships[]`, and for each `has_one` entry with a non-empty `stream` and `foreign_key`, builds a link to `/dashboard/records/<conn>/<parent_stream>/<foreign_key_value>` when the record carries a non-empty string at that field. The record detail page merges this with the metadata-derived `findParentBackLink`, deduplicating by parent stream. This is shipped and unit-tested but unspecified.

### The owner example

A Chase `transactions` record is keyed by its own transaction id and carries `account_id` = the parent `accounts` record key, declared as `transactions.relationships[] = { name: "account", stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`. The `accounts` stream declares no `query.expand[]`, so:

- the reference server emits no `expand_capabilities` for any `accounts -> transactions` forward relation (none is declared);
- `findParentBackLink` (the companion change's spec path) reads `accounts` metadata, finds nothing, and returns null;
- without `childHasOneBackLinksFromManifest`, the transaction detail page shows no related-account link.

The shipped affordance closes exactly this gap by reading the **child's own** declared `has_one` relationship.

## Goals

1. Make the existing, tested child-declared `has_one` parent back-link a sanctioned part of the operator-console relationship contract, so the spec matches shipped reference behavior.
2. Preserve the manifest-only / no-heuristics discipline the companion change established (D1): links come from declared relationships, never from payload field-name guessing.
3. Keep the server contract untouched: no reverse expansion, no new `expand_capabilities`, no `expand[]` request issued to draw the link.
4. Reconcile cleanly with the companion change's "exclusively from `expand_capabilities`" wording rather than silently contradicting it.

## Non-goals

- Server-side reverse / belongs-to expansion (`transactions -> accounts` as `GET …?expand=account`). Still impossible without a separate reverse-edge contract; the companion change's `Scenario: Symmetric link does not imply server-side reverse expansion` stays in force and this change restates it for the child-declared case.
- Changing any manifest. The child-side `has_one` relationships already exist as declared metadata.
- Backfilling `query.expand[]` to make these relations server-expandable. That is the deferred forward-expansion work; this change is purely about the console back-link from already-declared child metadata.
- `has_many` relationships declared on a child stream. The `has_many` navigation direction is parent → filtered child list (companion change). A child-declared `has_many` is not turned into a back-link here.
- Multi-hop, cross-connector, or edge-typed navigation. Out of scope, consistent with the companion change.

## Decision

### D1. Child-declared `has_one` relationships are a sanctioned back-link source

The operator console MAY source a child-to-parent link from the displayed child stream's **own** manifest `relationships[]`, not only from a parent stream's `expand_capabilities`. The rule:

- For each `has_one` relationship declared on the displayed child stream with a non-empty `stream` (parent) and `foreign_key`,
- when the displayed child record carries a non-empty string value at `foreign_key`,
- the console renders a link to the parent record's detail page `/dashboard/records/<conn>/<stream>/<foreign_key_value>`.

The `foreign_key` value is the parent record's key by the same key-field semantics the companion change defines (`child_parent_key_field` lives on the child and holds the parent's key). No `has_many` child relationship and no undeclared field produces a link.

This is additive to the companion change's parent-metadata path. When both a parent's `expand_capabilities` entry and the child's own declared relationship resolve to the same parent stream, the console deduplicates by parent stream (the implementation prefers the metadata-derived link).

### D2. The affordance is console-only and manifest-grounded

This does **not** define server-side reverse expansion. The reference server continues to reject `GET /v1/streams/<child>/records?expand=<parent_relation>` with `invalid_expand`. The console issues no `expand[]` request to draw the link: the child record already carries the `foreign_key` value, and the manifest already declares the relationship. This mirrors the companion change's D6 (symmetric console linking without symmetric manifest declaration), extended to the case where the declaration lives on the child stream.

The no-heuristics line holds: the console consults the **declared** `relationships[]`, never the raw payload. A field that merely looks like a foreign key but is not covered by a declared `has_one` relationship renders as plain text.

### D3. Relationship to the companion change's "exclusively" clause

The companion change's requirement "Operator console SHALL render manifest-declared parent links on the child record page" says links come "exclusively from `expand_capabilities` returned by the relevant parent stream's metadata." Taken literally, that forbids the shipped Chase affordance. This change relaxes it: child-to-parent links MAY also be sourced from the child stream's own declared `relationships[]`. Both sources are manifest declarations; the relaxation does not admit payload heuristics.

Because the companion change is not yet archived, the two requirements coexist as additive deltas. At archive time the durable-spec fold SHALL merge them into one requirement naming both sources, so the durable spec never carries the contradiction. This change's proposal records that obligation.

### D4. Chase is the proving scenario; the rule is generic

The normative requirement is connector-agnostic. Chase `transactions.account_id -> accounts` is pinned as the scenario because it is the owner's reported example and the simplest end-to-end case (single `has_one`, scalar string key). The other ~13 connectors with child-side `has_one` relationships are covered by the same rule and need no per-connector spec text — consistent with the companion change's rejection of "backfill every connector at once" (its A5). If a future connector's child relationship shape does not fit `has_one` + single scalar `foreign_key`, a follow-up change extends the rule.

## Alternatives considered

### A1. Amend the companion change in place

Pro: one artifact owns the whole console contract.
Con: the companion change is implemented on main and its design deliberately argued "exclusively from `expand_capabilities`" and scoped Chase out as a follow-up slice. Rewriting accepted design rationale in place erases the audit trail and conflates two decisions made at different times. A separate additive change preserves the history and is the cleaner reconciliation. Rejected.

### A2. Backfill `query.expand[]` so these relations expand server-side

Pro: would let `findParentBackLink` (the existing spec path) light up without a new affordance.
Con: these are belongs-to edges; the foreign key is on the child, not the parent, so the engine cannot serve them forward without a reverse-lookup contract (the archived audit's core finding). This is a large server contract change, not a documentation slice. Out of scope. Rejected for this change.

### A3. Report-only; leave the code unspecified

Pro: zero spec churn.
Con: leaves a shipped, operator-visible navigation affordance with no durable contract and in literal contradiction with the companion change. The repo rule (AGENTS.md) is to write up durable behavior a reviewer should be able to audit. Rejected.

### A4. Treat the child-declared link as a payload heuristic and remove it

Pro: restores strict "expand_capabilities only."
Con: the affordance is manifest-declared, not a heuristic; removing it re-breaks the owner's Chase example and every other belongs-to navigation, with no replacement until the deferred reverse-expansion work lands. Strictly worse for the operator. Rejected.

## Acceptance checks

The change is acceptable when:

1. `openspec validate add-child-manifest-relationship-backlinks --strict` passes.
2. `openspec validate --all --strict` passes (no regression against the 45-item baseline + this change).
3. The added requirement's scenarios are satisfied by the shipped implementation:
   - `childHasOneBackLinksFromManifest` builds `/dashboard/records/<conn>/accounts/<account_id>` for a Chase-shaped `transactions` record carrying `account_id` (proven by `relationships.test.ts` `child-declared has_one links to the parent record detail page`).
   - A child-declared `has_many` relationship produces no back-link (proven by `child-declared has_many relationships are ignored by childHasOneBackLinksFromManifest`).
   - An undeclared id-shaped field produces no link (proven by `unrelated id-looking fields do not link when not covered by a declared has_one`).
   - A missing/empty `foreign_key` value produces no link (proven by the empty/absent-field tests).
4. No code, manifest, server, or contract file changes in this change (documentation/spec only). `git diff --check` clean.

## Residual risks

- The companion change and this change both modify `reference-implementation-architecture`. If they are archived independently without the durable-spec fold described in D3, the durable spec could carry both the "exclusively from `expand_capabilities`" wording and the relaxation. The proposal pins the fold as an archive-time obligation; an owner archiving either change must reconcile the two child-to-parent requirements into one.
- The affordance lands on a parent-detail "not found" page if the declared `foreign_key` value has no matching parent record (e.g. the parent stream is not granted or the account was not collected). This is the same dead-link behavior the companion change accepts for its symmetric links (its residual-risk note) and is consistent with how Airtable/Notion handle linked records. The detail page already renders `notFound()` calmly for 404/410.
- The rule assumes a single scalar `foreign_key` per `has_one`. A connector declaring a composite or array foreign key would not be served by `childHasOneBackLinksFromManifest`; that is a follow-up rule extension, not a regression here.
