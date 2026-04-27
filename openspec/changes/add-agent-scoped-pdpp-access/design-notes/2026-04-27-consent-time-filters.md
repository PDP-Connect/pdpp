# Consent-Time Filters

Status: sprint-needed
Owner: owner
Created: 2026-04-27
Updated: 2026-04-27
Related: `openspec/changes/add-agent-scoped-pdpp-access/`, `apps/web/content/docs/spec-core.md`

## Question

Should PDPP grants support consent-time filters beyond the current `fields`/`view`, `time_range`, and `resources` selection primitives?

## Current State

Today, a PDPP selection request can narrow a stream at consent time by:

- `fields` or `view`: field projection.
- `time_range`: a temporal window, only when the stream declares `consent_time_field`.
- `resources`: exact primary-key records.

It cannot express arbitrary predicates such as "transactions where `category_name = Pets`", "amount greater than $50", "messages from a specific sender", or "records matching this search query" as part of the grant.

## Initial Judgment

PDPP probably needs a consent-filter primitive eventually, but it should not be the public query filter grammar copied into grants.

The safer shape is a constrained, manifest-declared consent-filter subset:

- Connector manifests declare which fields are eligible for consent filtering.
- Each eligible field declares supported operators and human-readable rendering.
- The AS validates the filter at grant issuance and stores the resolved predicate in the grant.
- The RS enforces the predicate on every record/search/blob/aggregation path before response projection.
- Consent UI renders the predicate in owner-readable language, not raw query syntax.
- Filters remain source/stream-scoped and do not become a hidden cross-source policy language.

This would preserve data minimization for common assistant cases without turning consent into an unreviewable query builder.

## Risks

- Arbitrary predicates can leak side-channel information if counts, denial messages, or search behavior differ by filtered-out data.
- Rich filters may be too hard for owners to review correctly in consent UI.
- Predicate semantics can drift from query semantics if the same field/operator behaves differently at consent time and request time.
- Connector-authored display text must not let requesting clients smuggle persuasive copy into consent.
- Cross-stream or semantic/search-based filters would blur authorization with retrieval ranking and should be treated as a separate, higher-risk design.

## Promotion Trigger

Promote this note into a dedicated OpenSpec change before implementing any grant field, PAR request field, manifest field, consent UI, or RS enforcement path for consent-time predicate filters.

The promoted change should include prior-art review across OAuth RAR, Google OAuth data scopes, GitHub fine-grained permissions, Slack app scopes, Plaid consent/scopes, Apple/Android permission grouping, and database row-level-security policy UX.

