# Design: Source Webhook Ingress Envelope and Security Boundary

Status: proposed
Owner: reference implementation owner
Created: 2026-05-28
Related: `design-notes/source-webhooks-and-event-driven-collection-2026-05-15.md`, `design-notes/client-event-webhook-standards-review-2026-05-28.md`

## Background

The reference implementation has a working source webhook ingress since the `split-reference-server-by-route-family` tranche extracted `server/routes/source-webhooks.ts`. The route accepts authenticated source-platform callbacks and maps them into existing ingest or scheduler semantics. Four high-level requirements for this surface already exist in `openspec/specs/reference-implementation-architecture/spec.md` (§ "Source webhook ingress…"), but they are intentionally high-level — the split-server change was a mechanical behaviour-preserving extraction, not a spec elaboration pass.

The `design-notes/source-webhooks-and-event-driven-collection-2026-05-15.md` decision log (2026-05-15) explicitly called for promoting "a narrow reference-only tranche to `openspec/changes/add-source-webhook-ingress`." This is that promotion.

## What the code does (verified 2026-05-28 against branch `workstream/ri-source-webhook-envelope-spec`)

### Endpoint

`POST /_ref/source-webhooks/:sourceId` — RS app only. Not registered on the AS app. Not advertised in `.well-known/oauth-protected-resource` or any public PDPP metadata.

### Auth posture

The route uses **no** owner-session, bearer token, client grant, or device credential middleware. It authenticates exclusively via per-source HMAC signing on the incoming request headers. This is intentional: the endpoint is a machine-to-machine callback surface, not an operator surface. Applying the `_ref` owner-session gate would make it impossible for a remote source platform to deliver callbacks without a browser session.

The owner-session gate that applies to all other `_ref/*` routes (`harden-reference-auth-surfaces`, `gate-ref-reads-when-owner-auth-enabled`) explicitly carves out `/_ref/source-webhooks/*`. The `PDPP_SOURCE_WEBHOOK_SECRETS` environment variable is the configuration boundary that controls whether the endpoint is active; when unset, `resolveSecret` returns `undefined` and every request fails `unknown_source` (404).

### Signed material

Three headers are required:

| Header | Format | Role |
|---|---|---|
| `PDPP-Webhook-Timestamp` | Unix epoch seconds (integer string) | Timestamp for replay protection |
| `PDPP-Webhook-Event-Id` | Opaque string | Idempotency key component |
| `PDPP-Webhook-Signature` | `sha256=<hex(HMAC-SHA256(secret, "${timestamp}.${body}"))>` | Message authenticity |

HTTP header names are case-insensitive. The table shows the canonical casing
used in the reference documentation; the Express adapter reads the same names
from Node's lowercased header map.

The signed material is `${timestamp}.${body}` where `body` is the raw request body as a UTF-8 string. This matches common HMAC webhook patterns (Stripe, Svix/Standard Webhooks) while being deliberately source-private — there is no cross-source key reuse or cross-source envelope format.

**Why not Standard Webhooks v1 (`webhook-id` / `webhook-timestamp` / `webhook-signature`)?** Standard Webhooks is the right choice for the *client event subscription* outbound delivery direction (already implemented), where the reference server is the *sender* delivering to subscriber receivers. Source webhook ingress is the *receiver* direction: the reference accepts callbacks from source platforms that each have their own signing scheme. Standardizing the inbound header names would require every source platform to adopt PDPP header names — an impractical interoperability requirement. PDPP-prefixed header names (`PDPP-Webhook-*`) correctly signal that this is a reference-specific adapter contract, not a PDPP Core protocol surface.

### Validation order and timestamp tolerance

The operation first validates the source id and required headers, then resolves
the per-source secret, then applies the timestamp tolerance, then verifies the
HMAC signature, then parses and processes the JSON body. Unknown sources are
therefore rejected before timestamp and signature checks, but missing required
headers are still reported as header-specific 401 errors.

The timestamp tolerance is ±5 minutes from server wall-clock time. Requests
outside that window are rejected with `stale_timestamp` (HTTP 401) before
signature verification completes. The tolerance is hardcoded
(`DEFAULT_TOLERANCE_MS = 5 * 60 * 1000`) and is intentionally not configurable
in the initial implementation — variability would create gaps between what
operators expect and what the reference enforces.

### Replay protection

The operation persists an idempotency record in `source_webhook_events(source_id, event_id, body_hash, received_at)` with a `UNIQUE(source_id, event_id)` constraint **before** applying any record mutations or scheduler signals. The body hash (HMAC-SHA256 of the body using the same source secret) is stored alongside the event id so the record can be inspected offline; it does not participate in the uniqueness check.

Idempotency is durable for both SQLite and Postgres backends via `ON CONFLICT(source_id, event_id) DO NOTHING` (Postgres) and a `UNIQUE` constraint with `INSERT OR IGNORE` semantics (SQLite). An accepted duplicate returns HTTP 202 with `{ duplicate: true }`.

### Error codes and HTTP status

| Code | HTTP | Meaning |
|---|---|---|
| `missing_event_id` | 401 | `PDPP-Webhook-Event-Id` header absent or blank |
| `missing_timestamp` | 401 | `PDPP-Webhook-Timestamp` header absent or blank |
| `missing_signature` | 401 | `PDPP-Webhook-Signature` header absent or blank |
| `unknown_source` | 404 | No configured secret for the given `sourceId` |
| `stale_timestamp` | 401 | Timestamp is outside the ±5-minute tolerance window |
| `invalid_signature` | 401 | HMAC-SHA256 mismatch (timing-safe comparison) |
| `invalid_payload` | 400 | Body is not a JSON object, missing required fields, or carries an unrecognised `action` |

All auth/replay failures return 401 rather than 403 to avoid revealing to an unauthenticated caller whether the `sourceId` exists. The `unknown_source` 404 is intentional: an operator misconfiguration (wrong `sourceId` in the URL) should be diagnosable, and source ids are not secret.

### Payload action vocabulary

Accepted `action` values:

- `ingest_records` — Push records into the reference's existing record-ingest path. Required fields: `stream` (string), `records` (array of record objects). Records are serialized as NDJSON and passed to `executeRecordsIngest`, which enforces stream lookup, schema, primary keys, tombstones, versioning, and projection.
- `schedule_run` — Request a connector refresh. No additional required fields. The request passes through the automation policy model (same policy as `scheduled` and `manual` trigger kinds); the run is started only if `allowed_to_start` is true. If the runtime controller is unavailable, the signal falls back to `signalScheduler`.

## Alternatives Considered

### Reuse Standard Webhooks v1 headers inbound

Using `webhook-id` / `webhook-timestamp` / `webhook-signature` inbound would align header names with the outbound client-event-subscription surface. Rejected: those headers are defined in a receiver contract (the reference is the *sender*), and requiring source platforms to adopt them adds friction for zero gain. The source-webhook surface is reference-only and source-specific by design; it is not intended to become an interoperability contract.

### Reuse owner bearer token or client grant token for source authentication

Rejected immediately. Owner tokens are bound to a human session and must not be issued to external systems. Client grant tokens are issued per grant to authorized clients; reusing them for source callbacks would conflate grant-scoped disclosure with collection-trigger authorization, violating the Core/Collection split. Device credentials are enrolled local-collector specific. Each of these token families carries different lifetime, revocation, and trust semantics that must not be conflated with a per-source platform secret.

### Make timestamp tolerance configurable per source

Rejected for now. The 5-minute window matches industry norms (Stripe, GitHub, Twilio). Per-source overrides would require storage and configuration surfaces that add complexity without a concrete use case. If a source platform requires a different window, the operator can adjust the source secret rotation cadence instead.

### Use a monotonic event counter instead of opaque event ids

The current design accepts caller-supplied event ids as opaque strings. A monotonic counter would enable gap detection (detect dropped events) but would require the source platform to cooperate. Real source platforms emit opaque event ids; enforcing monotonicity would break integration with them. Gap detection is better served by source-specific stream coverage tracking, not by constraining the event id format.

## Invariants and Security Properties

1. **Auth before mutation.** The HMAC signature and timestamp are verified before any record or scheduler state is written. The idempotency claim is persisted before any ingest or run trigger. There is no code path that mutates state for an unauthenticated or unverified callback.
2. **No cross-contamination with owner/client auth.** The route registers no `requireOwnerSession`, `requireClientAuth`, or device-credential middleware. The only credential used is the per-source HMAC secret from `PDPP_SOURCE_WEBHOOK_SECRETS`.
3. **Timing-safe comparison.** The HMAC verification uses `timingSafeEqual` (Node.js `node:crypto`) to prevent timing oracle attacks.
4. **Source isolation.** Each `sourceId` maps to one secret and one `connectorId`. A callback for `sourceId=spotify` cannot influence state for `connectorId=gmail` even if both are registered.
5. **No PDPP protocol leakage.** The endpoint is not advertised in PDPP OAuth/resource server metadata. It does not appear in `/.well-known/oauth-protected-resource` or `/.well-known/oauth-authorization-server`. It is reference-only: a conformant PDPP Core resource server is not required to implement it.

## Residual Risks and Deferred Work

1. **Secret rotation.** The current implementation has no in-flight secret rotation: the old secret is checked, and if it fails, the callback is rejected. Standard Webhooks v1 and Stripe support a transition window. Rotation support is deferred; the design note (`source-webhooks-and-event-driven-collection-2026-05-15.md`) lists source subscription lifecycle as a future tranche.
2. **Source subscription lifecycle.** There is no subscribe/renew/expire lifecycle for registering with source platforms. Registration is operator-managed via `PDPP_SOURCE_WEBHOOK_SECRETS`. Formalizing a subscription lifecycle requires an interoperability reason (a source platform willing to send PDPP-shaped callbacks) and is deferred.
3. **Body size limits.** No explicit limit is imposed on `ingest_records` payloads beyond what the HTTP server applies globally. Large batches are not explicitly bounded. Not a blocker for the current use case but worth noting.
4. **`schedule_run` vs inline run ambiguity.** If `requestRun` is available, it is called inline within the HTTP handler (before the 200 response). If the run takes a long time to start, the source platform's delivery timeout may fire before a response is sent. This is acceptable for the current synchronous implementation but is a design debt for high-volume or slow-starting connectors.
