# Position: The read surface — PDPP is a queryable substrate, not only a consent layer

**Status:** Settled as to what v0.1 defines (verified against spec-core §8, 2026-06-24);
open as to branding emphasis.

## Asked as

- "So PDPP is a consent/permission protocol?"
- "What can an app or agent actually *do* once granted access?"
- "Where's the value beyond authorization?"

## Short answer

PDPP has two co-equal halves that are one act: consent (grants, enforcement) and a
**portable, queryable substrate** — a normative, declaration-driven query interface over
a person's modeled data. A granted client doesn't get a data dump; it gets a standing,
fine-grained read surface: filterable, projectable, relationship-aware, incrementally
syncable, schema-introspectable. Presenting PDPP as consent-only misrepresents it (and
underserves the developer and AI-agent audiences, for whom the substrate is the value;
consent is the trust layer that makes it safe).

## What the read surface actually is (normative, spec-core §8; the "durable base query
surface" per L1061)

- **Pagination & ordering**: opaque direction-bound cursors, `limit` (≤100, clamps with a
  non-fatal `limit_clamped` warning), `order asc|desc`, stable `(cursor_field,
  primary_key)` sort.
- **Filtering**: exact `filter[{field}]` on authorized scalar fields; range operators
  (`gte/gt/lte/lt`) **only on manifest-declared** `query.range_filters` fields.
- **Field projection**: sparse `fields` (top-level, v0.1) or manifest-named `view`.
- **Relationships**: `expand[]` (depth 1, declaration-gated), `expand_limit`,
  has_one/has_many.
- **Incremental sync**: `changes_since` with tombstones, 410 `cursor_expired`, and the
  distinctive privacy rule — eligibility computed on the *grant-authorized projection*
  (a record whose visible fields didn't change MUST NOT surface; hidden-field changes
  must not leak).
- **Discovery**: `GET /v1/streams` (+counts, freshness), `GET /v1/streams/{stream}` —
  schema, primary key, declared query capabilities; the surface is self-describing.
- **Single-record fetch, blob fetch** (sha256/mime/size), **owner self-export**,
  **owner-authenticated erasure**, structured errors + warnings.

## What we do NOT claim

- Full-text search, aggregation, nested/OR filters, multi-hop expansion — **not in
  v0.1** (spec-core L1069; §11). The reference implementation ships search and aggregate
  as extensions; do not present them as Core capabilities.
- Request-time filters do **not** narrow grant scope (§11, L1475): filtering what you
  read ≠ consent narrowing. Don't blur these.
- No claim that one half "leads." Branding emphasis is deliberately undecided [owner];
  the honesty bar is proportional representation of both halves.

## Why it matters

The audiences that adopt protocols — developers and AI agents — buy the substrate
("point software at your own structured data, safely"), not the permission machinery.
DTP standardizes vertical content schemas + one-shot transfer; OAuth standardizes the
handshake; **PDPP is the only layer that standardizes a granular, standing, enforceable
read surface over arbitrary personal data.** That is the differentiated claim, and every
capability listed above is normative and implemented.

## References

- `apps/site/content/docs/spec-core.md` §8 (L891–1292: the interface), §11 (scope/
  exclusions), L1061 (durable base query surface), L1069 (search exclusion), L1079
  (projection-aware sync rule).
- Related: [pdpp-and-oauth](pdpp-and-oauth.md), [pdpp-and-dti](pdpp-and-dti.md),
  [why-grants-are-durable](why-grants-are-durable.md).
