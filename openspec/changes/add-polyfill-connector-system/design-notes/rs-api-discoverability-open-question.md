# Open question: RS API surface — discoverability, error-shape, and query semantics

**Status:** open
**Raised:** 2026-04-20
**Trigger:** Handed a newly-minted owner token to an outside coding agent on the LAN, pointed it at the RS, and asked it to explore. Within minutes the agent surfaced three real gaps that the "design from the inside out" development path had missed. None is catastrophic on its own; together they show the RS is currently undiscoverable without out-of-band knowledge, inconsistent in how it reports failure, and missing query primitives the spec's own consent model (time_range as a first-class concept) implies should exist.

**Framing:** Discovery + error + query answers differ depending on whether the primary client is the owner's own agent or a third-party client. See `pdpp-trust-model-framing.md`.

## Quirk 1 — `connector_id` is mandatory on every endpoint, including listing

`GET /v1/streams` without a `connector_id` query parameter returns:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_request",
    "message": "connector_id must be a single non-empty string for polyfill owner access",
    "request_id": "req_..."
  }
}
```

Same error on `/v1/streams/<stream>/records` and `/v1/streams/<stream>/records/<key>`. The parameter is required in 100% of requests. This is intentional in the reference: polyfill tokens are scoped to one connector at a time, and the stream namespace overlaps across connectors (both Slack and ChatGPT have a `messages` stream, both Gmail and Codex have `messages`), so the caller must name the connector. Fine premise.

**What breaks:** there is no way to **discover** which connectors exist. No `/v1/connectors`, no `/v1/.well-known/connectors`, no listing under the AS. An agent holding a valid owner token cannot ask the RS "what data do you have?" without someone pasting in a list of connector URLs first. The expert on the inside (who wrote the connectors) has the list in their head; the outside agent has nothing.

This is the inverse of the problem the protocol claims to solve. PDPP's pitch is "owners give agents scoped access to their data." If the agent can't enumerate what's available under its grant, the grant is half-usable. The agent is forced to guess (`/v1/connectors`, `/connectors`, `/manifests`, `/v1/registry/connectors` — all tried, all 404) or wait for the owner to paste in a registry.

## Quirk 2 — Error shapes are inconsistent across endpoints

`GET /v1/streams/messages/schema` returns:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>Cannot GET /v1/streams/messages/schema</pre>
</body>
</html>
```

That's Express's default 404 handler. Not the structured `invalid_request_error` JSON the agent has been trained on by the other 20 endpoints it's hit. A client parsing JSON responses bombs out on "Unexpected token '<' in JSON at position 0" and has to guess whether the problem is auth, a bad endpoint, the server being down, or a malformed request.

The reference ships a `pdppError` / `oauthError` helper (`reference-implementation/server/index.js`) that produces the JSON shape consistently — but it's only applied on routes that were written with it in mind. Any un-routed path falls through to Express default. Since clients can't always predict which paths exist (see Quirk 1), the probability of a client hitting an un-routed path is high, and when it happens they get HTML.

## Quirk 3 — Query API lacks time filtering and sort-by-timestamp

`GET /v1/streams/<stream>/records` accepts these parameters today (`reference-implementation/server/records.js`):

- `limit` (1–100, default 25)
- `order=asc|desc` (default desc; sorts by **ingest order / record version**, not by any timestamp in the record)
- `cursor=<opaque>` (pagination)
- `changes_since=<opaque>` (delta cursor, a monotonic version number — not a timestamp)
- `filter[<field>]=<value>` (exact-match equality, any field; **unindexed**, so slow on large streams)
- `fields=a,b,c` (column projection within grant's allowed fields)

It does NOT accept any of:

- `since` / `until` / `before` / `after` / `from` / `to` / `date` — all silently ignored. The agent tried every reasonable synonym.
- `sort_by=<field>` — no user-selectable sort key. Ingest order only.
- Comparison filters (`filter[sent_at][gt]=...`) — only strict equality.

The spec-level irony: **`time_range` is a first-class concept in the consent model.** A grant's `authorization_details[].streams[].time_range.since/until` is enforced at query time (`records.js:274–285` applies it automatically). But an owner token with no grant (or a grant with no `time_range`) cannot express "I want records newer than 2026-01-01" as an ad-hoc query. The consent layer has time, the query layer does not.

**What this forces clients to do today:**

1. Fetch `order=desc` and paginate until the record timestamps drop below their window. Reads everything inside the window plus up to one page past it.
2. Wide-net fetch `limit=100`, filter client-side. For 186k Slack messages that's ~1,900 paginated round-trips to find a 24-hour slice — unusable.
3. Store a `changes_since` cursor and poll for deltas. Works for "what's new since I last checked" but not for "give me last month."

The first two are wasteful. The third doesn't answer the question the agent asked.

## Why this is a spec-level question, not a code bug

Fixing each in isolation is easy:
- Add a `/v1/connectors` endpoint that lists accessible connector IDs for the bearer.
- Add a catch-all 404 handler that returns the standard JSON error shape.

But the deeper question is what the RS's **contract** is for discovery, errors, and queries, and that's the spec's job:

1. **Is the RS self-describing or does it require an out-of-band registry?** Today it's the latter by accident (no endpoint exists) rather than by design (the spec hasn't chosen). Self-describing is the usable default; requiring a registry is reasonable if the registry is first-class.

2. **What's the canonical error envelope?** The reference has one (JSON with `type`, `code`, `message`, `request_id`, optional `trace_id`), but it's not spec'd as mandatory. Two different implementations today could reasonably ship two different shapes and both claim conformance.

3. **What is the minimum query vocabulary?** `time_range` is a first-class consent primitive — the spec and the manifest both treat it as a fundamental scope dimension. But at query time, grant-holders can only retrieve records in ingest order with exact-match filters. If `time_range` is fundamental to consent, an ad-hoc time query should be fundamental to the RS. Symmetry between consent expression and query expression is the question.

None of these three questions is addressed in `spec-core.md` or `spec-data-query-api.md`. All three should be.

## What the spec could require

### Option A — Minimal: standardize the error envelope, add one discovery endpoint

**Spec additions:**

1. All RS error responses MUST use the envelope:
   ```json
   { "error": { "type": "...", "code": "...", "message": "...", "request_id": "..." } }
   ```
   Status codes MUST match the error type (400 for invalid_request, 401 for unauthorized, 404 for not_found, etc.). Never fall through to framework defaults.

2. RS MUST expose `GET /v1/connectors` that returns the connectors accessible to the presented bearer. Minimum schema: `{ object: "list", data: [{ connector_id, streams: [...], record_count, last_updated }] }`.

- **Pro:** closes the immediate gap. Small surface area. Lets the RS stay otherwise unchanged.
- **Con:** doesn't address stream-level discovery (schema endpoints, resource discovery inside a stream).

### Option B — Full self-description

Add a `GET /v1/manifest` that returns the current state of all accessible connectors *and* streams *and* schemas under this bearer. Basically OpenAPI-ish — a machine-readable description of the whole RS from the caller's perspective.

- **Pro:** the RS becomes fully discoverable; agents can operate without any out-of-band knowledge.
- **Con:** much larger surface to spec; schemas themselves need a spec (JSON Schema? something custom?). See `stream-schema-format-open-question.md` if it exists; this is adjacent.

### Option C — Split: RS for queries, AS for discovery

Move `/v1/connectors` and schema-listing to the AS (which already handles manifest registration). RS stays narrowly focused on records. Agents bootstrap by hitting the AS's discovery endpoint, then pivot to the RS for the actual data.

- **Pro:** matches separation-of-concerns. AS knows what exists; RS knows what's in it.
- **Con:** agents now need two URLs, not one. Onboarding friction.

### Option D — RFC 9728 + OpenAPI punt

Lean on existing standards. The AS exposes RFC 9728 protected-resource metadata. Within that, link to a standard OpenAPI document describing the RS. Agents parse OpenAPI. Error envelope is whatever OpenAPI says.

- **Pro:** zero PDPP-specific invention; works with existing tooling.
- **Con:** OpenAPI is heavyweight; probably more than needed for the simple "what connectors exist" question.

### Option E — Do nothing, document "out-of-band discovery is expected"

Accept that callers bring the connector list with them from an out-of-band registry (the PDPP connector registry at registry.pdpp.org, eventually). Document this. Don't add discovery endpoints.

- **Pro:** forces the registry question to be answered for real.
- **Con:** punts the immediate usability problem. Keeps the "undiscoverable without secrets" gap.

## Query-vocabulary options (Quirk 3)

These compose with A–E above (discovery and error-shape). Query-vocab is an orthogonal axis.

### Option Q1 — Minimal: promote `time_range` to a query parameter

Accept `since` and `until` as query-string parameters on `/v1/streams/<stream>/records`, applied using the same `consent_time_field` the grant-time `time_range` uses. Reuse the existing `passesTimeRange` helper.

- **Pro:** single-line code change; symmetric with consent vocabulary; answers 80% of the practical question.
- **Con:** no server-side index today, so it's still a full scan. Correctness win, not performance win.

### Option Q2 — Sort-by-field + comparison filters

Accept `sort_by=<field>&order=asc|desc` and `filter[<field>][gt|gte|lt|lte]=<value>`. Fully general; client picks field + comparator.

- **Pro:** general-purpose; no PDPP-specific semantics.
- **Con:** larger surface, indexing implications grow. Implementers have to expose which fields are indexed.

### Option Q3 — Declare supported queries in the manifest

Manifest declares, per stream, `queryable_fields: [{ field: "sent_at", comparators: ["gt","lt"] }, ...]`. Clients discover what filters are possible (complements Option B above — full self-description).

- **Pro:** aligns queryability with the schema/discovery story; no unindexed surprises.
- **Con:** manifest complexity; forces every connector author to think about indexing.

### Option Q4 — Do nothing; force clients to paginate-and-filter-client-side

Keep today's behavior. Document the pattern. Accept that "last 30 days of Slack" requires 1,900+ round-trips.

- **Pro:** zero spec change.
- **Con:** unusable at any real scale. Loses the "reference that demonstrates the protocol" claim.

## What should happen regardless of which option lands

These are cleanup items that don't prejudge the spec decision:

1. **Add a catch-all 404 handler on the RS app** that returns the JSON error envelope. Today's fallthrough to Express default is a silent contract violation on an otherwise clean surface. This is 3 lines of code.

2. **Document the error envelope in `spec-data-query-api.md`** as at least a SHOULD, even before it becomes a MUST. Implementers reading the spec today don't know the shape exists.

3. **When the reference server starts up, log the connector IDs available** so an operator can at least `grep` them out of the log. Doesn't fix the spec question; does unblock the demo use case.

## Trade-offs to weigh

- **Self-description vs. registry.** A registry is durable across owners (registry.pdpp.org knows all connectors). Self-description is scoped to one owner (this RS's accessible connectors). They serve different needs; whether the spec wants one, the other, both, or neither (with different semantics if both) is part of the decision.

- **Error shape as conformance.** If the error envelope becomes a MUST, conformance tests can fail any implementation that ships an HTML fallthrough. That's the cheapest way to catch this class of bug across implementations.

- **Agent-vs-human error experience.** An agent wants JSON. A human running `curl` for the first time benefits from the HTML being somewhat readable. The envelope should be JSON-by-default with an HTML representation available via content negotiation if needed. (No need to design that now; worth flagging.)

- **OpenAPI ≠ PDPP-native description.** A PDPP-native manifest endpoint can encode PDPP concepts (grants, consent, retention) that OpenAPI has no vocabulary for. OpenAPI is a fine transport for the subset that's about "what HTTP endpoints exist."

- **Consent-query symmetry.** `time_range` appears in the consent vocabulary as a primitive scope dimension. A grant can say "Slack messages from the last 30 days." But the query API has no way to ask that question ad-hoc; it's enforced only as a grant-time filter. The contradiction (fundamental in consent, absent in query) has several possible resolutions: add to query, remove from consent, or declare the asymmetry intentional and explain why.

## Cross-cutting

- `owner-authentication-at-approve-time-open-question.md` — both are about the AS/RS surface that an outside agent encounters. Authentication is the entry; discovery is what the agent does next.
- `connector-configuration-open-question.md` — manifest additions to advertise discoverability capabilities may belong here.
- `owner-self-export-open-question.md` — self-export needs to enumerate everything the owner has. Discovery is a precondition; time-range query is what makes "last year's data" exportable without reading the whole RS.
- `layer-2-completeness-open-question.md` — "what streams does a connector claim?" is the manifest side of this note's "what streams does the RS expose?"
- `gap-recovery-execution-open-question.md` — error envelope consistency affects how clients distinguish "retry now" from "retry never."
- `cursor-finality-and-gap-awareness-open-question.md` — the `changes_since` cursor is opaque and version-based; a time-based query is a different axis but shares the question "what does this cursor claim?"

## Action items

- [ ] Decide A/B/C/D/E for discoverability + error envelope.
- [ ] Decide Q1/Q2/Q3/Q4 for query vocabulary. The decision composes with the discoverability choice; some combinations are cheaper, others richer.
- [ ] Regardless: spec-define the error envelope in `spec-data-query-api.md` and add a conformance test for it.
- [ ] Regardless: add a catch-all 404 handler in the reference RS that emits the JSON envelope.
- [ ] Audit other un-routed paths in the reference (there are likely more than `/schema`) and ensure the catch-all covers them.
- [ ] Decide whether `registry.pdpp.org` is the canonical "what connectors exist globally" answer, even after per-RS discovery lands. They're not the same question.
- [ ] If Q1 or Q2 lands: decide indexing story per stream — which fields must be indexed for query performance to be tolerable on real-owner-scale data (186k Slack messages, 227k claude-code messages, etc.)?

## Why this note and not "just fix it"

Adding `/v1/connectors` is one endpoint. Cleaning up the error envelope is one middleware. Both are trivial. What's non-trivial is writing them into the spec such that all conformant implementations behave the same way. That's the actual deliverable — "this reference impl ships an endpoint it forgot to spec" is exactly the dishonesty the steering constraints flag. The fix belongs in the spec first, the code second.
