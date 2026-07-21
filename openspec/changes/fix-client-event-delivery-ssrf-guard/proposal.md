# Fix client-event delivery SSRF guard, the identical CIMD gap, the Web Push SSRF path, and the reproduced allow-policy/race/timeout/test-oracle gaps

## Why

The client-event subscription delivery worker fetches a client-supplied
`callback_url` with no server-side-request-forgery (SSRF) guard. `callback_url`
is validated only at subscription-create time, and only for URL scheme plus a
literal-hostname allowlist (`operations/as-client-event-subscriptions/index.ts`
`validateCallbackUrl`): an `https://` URL whose hostname resolves to a private,
loopback, or link-local address passes. The delivery worker then issues a raw
`fetch(url, …)` (`server/client-event-delivery-worker.ts` `defaultHttpTransport`)
with no IP check and default redirect-following.

A client with subscription-create authority can therefore make the reference
server issue POST requests to internal targets — cloud metadata
(`169.254.169.254`), loopback admin ports, or RFC 1918 hosts — either directly or
via DNS rebinding between create-time and each delivery tick, and the bounded
response snippet the worker logs can leak internal responses back through the
attempt-log read surface.

The CIMD document-fetch path (`server/cimd.js`, `fetchCimdDocument`) had the
identical defect, independently of delivery: it resolved DNS, checked the
result, and then called `fetch(clientId)` with the original hostname —
`fetch` performs its own independent resolution when it opens the connection,
so the address that was checked is not provably the address that gets
connected to. This was a live SSRF gap in the reference AS's CIMD
client-identity fetch, reachable by any party who can register a `client_id`
metadata URL.

An independent security review (`tmp/workstreams/ssrf-terra-final-0717.md`,
GPT-5.6 Terra) of the first two fixes found the guard itself was incomplete in
two ways that this revision closes in the same change:

- **P1 — allow-list false passes.** The address classifier was a hand-maintained
  deny list that blocked a small set of known-bad IPv4 ranges but silently
  passed several IANA special-purpose ranges that are not globally
  reachable — the three TEST-NET ranges, the IPv4 benchmarking range
  (198.18.0.0/15), and the 6to4 relay anycast range — because they were never
  added to the list. A deny list is inherently incomplete this way; only an
  explicit "is this global-unicast?" allow policy closes the class of gap, not
  just the specific instances found.
- **P2 — unbounded fallback.** The guard retained every address a DNS answer
  returned with no cap, and the pinned connector retried all of them
  sequentially; an attacker-controlled DNS response with many addresses could
  force unbounded connection work.
- **P1 (separate finding) — Web Push endpoint had no guard of any kind.**
  `server/web-push-notifications.js`'s `defaultSendNotification` hands an
  owner-supplied `subscription.endpoint` straight to the `web-push` npm
  package, which issues its own `https.request` with no IP policy at all. This
  is a different-shaped defect (no preceding check to race, not a TOCTOU) but
  is a real, live, exploitable outbound request to a user-controlled endpoint,
  reachable by an authenticated owner. It was documented but explicitly left
  unfixed by the prior revision of this change; the review correctly treated
  "documented" as insufficient — it remains a socket-level false pass.

A second independent security review (`tmp/workstreams/ssrf-sol-final-0717.md`,
GPT-5.6 Sol, 99% confidence REVISE) of the Terra-revision fixes reproduced
five further, concrete gaps, all closed in this revision:

- **P1/High — the allow policy's own authority was itself a stale snapshot.**
  The Terra-revision fix built `isGlobalUnicastAddress` on `ipaddr.js`'s
  `range() === 'unicast'` result, treating that as affirmative registry
  evidence. It is not: `unicast` is `ipaddr.js`'s default fallthrough for any
  address absent from its own hardcoded, unversioned range table — which
  predates several rows the actual IANA IPv6 registry has since added
  (`64:ff9b:1::/48` local-use NAT64, `100:0:0:1::/64`, `3fff::/20`,
  `5f00::/16`). Sol's probe reproduced six addresses that false-passed,
  including `64:ff9b:1::7f00:1` (local-use translation space embedding IPv4
  loopback). Separately, the prior fix conditionally allowed 6to4
  (`2002::/16`) based on its embedded IPv4 payload — the registry's own
  "Globally Reachable" value for that block is `N/A`, not `true`, so that was
  itself an overclaim.
- **P1/High — the Web Push TLS connector could double-fire its completion
  callback.** The pinned `https.Agent`'s TLS adapter attached independent
  `once('secureConnect', ...)` / `once('error', ...)` listeners with no
  settlement guard. A socket emitting both events (either order) invoked the
  agent callback twice — reporting success then failure, or vice versa,
  potentially opening a second connection after the request already received
  a socket, or reporting failure after success had already been handed to the
  caller. Sol's deterministic fake-socket probe reproduced two callbacks for
  one connection attempt.
- **P2/Medium — Web Push had no wall-clock connection bound.** The pinned
  agent and address-count cap bound how many addresses are retained and
  dialed, but not how long any single attempt is allowed to stay open. An
  allowed endpoint that accepted a connection and then hung left
  `sendNotification` — and the fanout `Promise.all` awaiting it — pending
  indefinitely, and the agent-cleanup `finally` block never ran.
- **P2/Medium — the tests and OpenSpec overstated what was proved.** The
  Web Push tests exercised only the guard helper directly, never the actual
  production sending function (`defaultSendNotification`), so they could not
  prove the guard's agent/timeout were forwarded, that cleanup was safe, or
  that a timeout existed. The prior revision's falsification method for that
  gap — reverting the source file and observing a missing-export import
  failure — proved the export didn't exist yet, not that a regression which
  *keeps* the export but weakens its behavior would be caught. The prior
  range tests covered selected historical examples, not the current registry,
  so the P1 false-passes above stayed green. The design doc claimed the
  address cap was enforced "at the connector," but the connector factories
  accepted arbitrary-length arrays with no enforcement of their own (every
  production caller did bound its input via the resolver, so production
  attempt count was still correct in practice — but the claim itself was
  inaccurate as stated). The prior "zero known live gap" statement was
  disproved by the first three findings above.

## What Changes

- **P1 (allow-list):** Replace the deny-list `isForbiddenIp` classifier with an
  explicit global-unicast **allow** policy, `isGlobalUnicastAddress`, built on
  `ipaddr.js` (a small, widely-used, IANA-registry-aligned IP-range library —
  added as a pinned direct dependency rather than re-deriving the same table by
  hand a second time, since re-deriving it by hand is exactly how the P1 gap
  happened). Covers every IPv4/IPv6 IANA special-purpose range and every
  mapped/tunneled representation (IPv4-mapped IPv6 dotted/hex, 6to4-embedded
  IPv4, NAT64/RFC6052-embedded IPv4), unwrapping tunnel encodings to check the
  embedded address rather than passing them through as unrecognized-but-
  unblocked IPv6 literals. `isForbiddenIp` is kept as a deprecated alias
  (`= !isGlobalUnicastAddress`) for call-site continuity.
- **P2 (bounded fallback):** `resolveAllowedAddresses` now caps retained
  addresses at `MAX_VALIDATED_ADDRESSES` (8) and fails closed — rejects the
  DNS answer in full — when a resolution exceeds the cap, rather than silently
  truncating to a prefix. Both `createPinnedDispatcher` (undici) and the new
  `createPinnedHttpsAgent` (`node:https`) share one bounded, ordered-fallback
  connector implementation.
- **P1 (Web Push):** `web-push-notifications.js`'s `defaultSendNotification`
  now runs the same `resolveAllowedAddresses` guard against the endpoint host
  before ever calling `web-push`, and passes a `createPinnedHttpsAgent`-built
  `node:https.Agent` (a real subclass — `web-push` validates its `agent` option
  with `instanceof https.Agent`) through `web-push`'s documented `agent`
  option. This closes the gap at the actual socket, not by pre-resolving and
  hoping the library doesn't re-resolve: `web-push` never gets a chance to
  perform its own independent DNS lookup, because the agent it uses only knows
  how to dial the already-validated literal address(es). VAPID header
  construction, payload encryption, TTL, and content-encoding are completely
  untouched — the guard adds exactly one new option (`agent`) to the existing
  `sendNotification` call and nothing else. `web-push` already does not follow
  redirects (any non-2xx status, including 3xx, is treated as a failure), so no
  separate redirect guard was needed.
- Add a normative requirement to `reference-implementation-architecture` for
  each of the three guarded paths (delivery, CIMD, Web Push) requiring: (a) a
  global-unicast **allow** policy, not a deny policy, covering every IANA
  special-purpose range and mapped representation; (b) send-time address
  binding (the validated and connected addresses are the same value by
  construction); (c) a bounded, fail-closed address count with ordered
  fallback within the bound. CIMD's existing requirement is **modified** to
  add all three properties; delivery's and Web Push's are **added**.
- Extract the address classifier, the bound, and the connection-pinning
  mechanisms into the shared module `server/ssrf-guard.js`:
  `isGlobalUnicastAddress`, `isForbiddenIp` (deprecated alias),
  `resolveAllowedAddresses`, `createPinnedDispatcher` (undici, for
  `fetch`-based callers), `createPinnedHttpsAgent` (`node:https`, for the
  `web-push` library's raw `https.request` call). All three callers
  (`client-event-delivery-worker.ts`, `cimd.js`, `web-push-notifications.js`)
  call this module instead of each owning or copying DNS-resolve-and-check
  logic. Each caller keeps its own scheme validation, exemption policy
  (delivery's sanctioned http+literal-loopback dev path; CIMD and Web Push have
  none), redirect handling, and error-message wording — only the
  resolve+classify+bound+pin mechanisms are shared, so there is one set of
  guarantees to prove instead of three that could drift out of sync.
- A blocked delivery/fetch/send is treated as a normal transient failure on
  its caller's existing error path (delivery: retry/backoff/dead-letter; CIMD:
  `cimd_fetch_failed`; Web Push: the sender's existing failure-handling path),
  not a crash — unchanged from each caller's prior behavior.

### Sol-revision changes (closing the five reproduced findings above)

- **Registry-derived allow policy authority.** `isGlobalUnicastAddress` no
  longer uses `ipaddr.js`'s own `range()` classifier as policy. A new vendored
  data module, `server/iana-special-purpose-registry.js`, encodes every row of
  both current IANA Special-Purpose Address Registries (transcribed from the
  primary-source CSVs, snapshot dated 2026-07-18) with each row's own
  "Globally Reachable" value as the classification authority. `ipaddr.js` is
  retained only for IP parsing and CIDR containment matching
  (`parseCIDR`/`match`/`process`), not for range classification. Longest-
  prefix-match is used for overlapping rows (e.g. `192.0.0.9/32` PCP Anycast,
  reachable, nested inside `192.0.0.0/24` IETF Protocol Assignments, not
  reachable) — an exhaustive table-driven test sweeps every row in both
  registries and caught this as a real bug during development. 6to4
  (`2002::/16`) is now denied outright and unconditionally (previously
  conditionally allowed based on the embedded IPv4, which the registry's own
  `N/A` "Globally Reachable" value for that block does not support).
- **Full research trail preserved.** The raw registry CSVs, the derivation
  rules, and the update procedure are recorded durably at
  `openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md`
  — exact primary-source URLs, access date, and the exact snapshot-refresh
  steps for when the registries change again.
- **Single-settlement fallback and TLS attempts.** `boundedFallbackConnect`
  (shared by both connector factories) now tracks its own settlement and
  destroys/ignores any late callback after it has already settled.
  `dialTlsOnce`, a new per-attempt TLS dial function, settles its own callback
  exactly once and removes the listener for whichever event did NOT fire, so
  a socket that both succeeds and later errors (or vice versa) cannot
  double-report. Both layers are independently tested with real sockets and
  with a deterministic fake-socket model reproducing Sol's exact
  `secureConnect`-then-`error` ordering.
- **Explicit Web Push send timeout.** `WEB_PUSH_SEND_TIMEOUT_MS` (10s,
  matching the order of magnitude of the other two guarded callers) is now
  passed as `web-push`'s `timeout` option, the only way that library installs
  a socket-inactivity bound. A deterministic hanging-transport test (a real
  server that never responds and never closes) proves the send is bounded and
  the pinned agent is still released.
- **Production-seam tests, behavioral-mutant falsification.**
  `defaultSendNotification` gained a test-only `deps` parameter
  (`guardWebPushEndpointImpl`, `webPushModuleImpl`) so tests can drive the
  actual production sending function — not just the guard helper — against a
  real local HTTPS server and real VAPID/subscription key material (generated
  via `web-push`'s own `generateVAPIDKeys()` and Node's `crypto.createECDH`,
  not hand-crafted fixtures), observing the exact options forwarded to a
  spy-wrapped real `web-push` module. Falsified against a behavioral mutant
  (still exports and runs `defaultSendNotification`, still guards, but
  silently omits `agent`/`timeout` from the real library call) rather than a
  missing-export failure — the mutant is caught by four of the new tests.
- **Connector-level cap enforcement.** `boundedFallbackConnect` now slices its
  input to `MAX_VALIDATED_ADDRESSES` itself, so `createPinnedDispatcher` and
  `createPinnedHttpsAgent` cannot be made to attempt more than the bound even
  if called directly with a longer list, bypassing `resolveAllowedAddresses`.
- **OpenSpec claims corrected throughout.** Every "forbidden address"/deny-
  list framing, the unconditional 6to4-embedded-address claim, the
  "enforced at the connector" claim, and the "zero known live gap" claim are
  replaced with language that matches exactly what the vendored snapshot,
  the connector enforcement, and the production-seam tests actually prove —
  including an explicit statement that the registry snapshot is dated, not a
  live feed, and does not close future IANA allocations by construction.

## Impact

- Affected specs: `reference-implementation-architecture` (delivery
  requirement ADDED and rewritten for the allow-list/bound properties; CIMD
  metadata-fetch-IP-filtering requirement MODIFIED for the same properties;
  new Web Push SSRF-guard requirement ADDED).
- Affected code: `reference-implementation/server/client-event-delivery-worker.ts`,
  `reference-implementation/server/cimd.js`,
  `reference-implementation/server/web-push-notifications.js`.
- Shared module: `reference-implementation/server/ssrf-guard.js` (+
  `ssrf-guard.d.ts` ambient types, mirroring the existing `hosted-ui.js`/
  `hosted-ui.d.ts` pairing convention in this codebase). Rewritten from the
  prior revision: classifier is now allow-list-based, `resolveAllowedAddresses`
  is bounded, `createPinnedHttpsAgent` is new.
- New direct dependencies: `undici` (previously transitive/Node-bundled only,
  needed for the `Agent`/`buildConnector` connection-pinning extension point)
  and `ipaddr.js` (pinned to `2.3.0`, the version already resolved
  transitively in this monorepo's lockfile before this change — a small,
  widely-used IP-parsing library, not a general networking framework, used
  only for its IANA-aligned range classification).
- No protocol-surface, wire-envelope, signing, VAPID-header, payload-encryption,
  or subscription-state change.
- Re-ran the outbound-fetch audit after this revision (every call site outside
  `node_modules`/tests that issues HTTP(S) to an externally-influenced
  destination): all three guarded call sites confirmed correctly wired to
  `ssrf-guard.js`; no other externally-influenced outbound-fetch call site
  found anywhere in the codebase; the fix itself introduced no new call site
  that bypasses the guard. All five findings from the second independent
  review (`tmp/workstreams/ssrf-sol-final-0717.md`) are closed and covered by
  falsifiable tests as of this revision; this is not a claim that no further
  finding exists, only that these specific, reproduced findings do not.
  New direct dependency: none beyond `undici`/`ipaddr.js` already listed above.
