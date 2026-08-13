## Context

The immediate owner is `packages/polyfill-connectors`. The ultimate consumer
is Vana Desktop, whose existing polyfill runtime supplies an isolated
persistent browser profile and generic owner handoff. This change proves the
connector in that package first; it does not add Desktop integration code.

WHOOP's web application uses authenticated first-party JSON endpoints. They
are not a public stability contract, so connector tests must make response
drift visible and live acceptance must be repeated before the connector is
publicly listed. Existing open-source WHOOP MCPs mostly use developer OAuth;
they are useful API-shape references but are not the runtime model here.

## Decisions

### 1. The browser profile is the credential boundary

The connector declares a required browser binding with a WHOOP-specific
persistent profile. It probes the authenticated session in the browser. If the
probe shows a signed-out state during an owner-started run, it uses the
existing `manualAction` browser handoff, asks the owner to sign in in that
window, then re-probes. It does not accept username/password environment
variables, extract tokens into connector state, or report success merely
because the owner dismissed the handoff.

An unattended refresh is session-reuse-only. It must not open a login prompt;
expired authentication is reported as owner repair required. Scheduling and
heartbeat policy are downstream Desktop concerns and remain outside this
change.

### 2. Collection is direct, typed, and fail-closed

All WHOOP requests execute inside the bound browser context. The implementation
parses only the response fields required by the six declared streams and
validates every emitted record. A 401/403 response is authentication loss, 429
is rate limiting, other non-success responses and invalid JSON are endpoint
failures, and schema mismatches are source drift. None may be converted into an
empty successful result or an advanced cursor.

The initial collection walks all history exposed by the source with bounded
requests and source-provided pagination/range signals. Records use stable
source identifiers and mutable-state semantics so later runs can update them.
Cursor state advances only after the corresponding records have been emitted.

### 3. Streams preserve source evidence

The connector exposes `profile`, `body`, `cycles`, `recoveries`, `sleeps`, and
`workouts`. Fields are source-owned values, not inferred wellness conclusions.
Profile and body are owner-scoped singleton records. The remaining streams use
WHOOP-owned stable record identifiers and retain timestamps needed for range
queries and incremental collection.

Journal data, raw continuous heart-rate samples, enrichment, and derived
cross-stream summaries are not part of this change.

### 4. Fixtures prove mechanics; the owner proves the live boundary

Synthetic scrubbed fixtures model the currently observed response shapes.
Hermetic tests cover every stream, pagination/cursor behavior, requested-stream
filtering, session loss, rate limiting, non-success responses, invalid JSON,
schema rejection, and manual-login re-probe. No personal data, browser profile,
token, or raw capture is committed.

A successful authenticated run against the owner's WHOOP account is the final
acceptance check and remains explicitly open until the owner performs it. Until
then WHOOP stays real-but-unlisted rather than being claimed production-ready.

## Rejected Alternatives

- **WHOOP developer OAuth:** requires a registered developer application and
  moves the connector away from the owner's existing web-account session.
- **WHOOP mobile data export:** delayed archive delivery is not the recurring
  owner-controlled collection model required for Desktop.
- **Email/password or mobile-client impersonation:** expands the secret and
  maintenance boundary and is unnecessary when the owner can authenticate in
  the isolated browser.
- **Generic runtime changes:** the existing browser binding, persistent profile,
  manual handoff, and run metadata already provide the needed primitives.

## Acceptance

1. The OpenSpec change validates strictly.
2. Focused WHOOP tests and package manifest/conformance gates pass.
3. The connector is registered in the local orchestrator and can reach the
   owner-login handoff without receiving credentials.
4. A later owner-run live test proves session reuse and non-empty records for
   each available stream before public listing.
