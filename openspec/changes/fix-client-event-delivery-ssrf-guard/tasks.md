# Tasks — client-event delivery SSRF guard

## 1. Implement the guard

- [x] 1.1 Import `isForbiddenIp` from `../server/cimd.js` and `lookup as dnsLookup`
      from `node:dns/promises` into `server/client-event-delivery-worker.ts`.
- [x] 1.2 Add optional injectable seams (`dnsLookupImpl`, `isForbiddenIpImpl`) to
      `defaultHttpTransport`, defaulting to the real implementations, mirroring
      `fetchCimdDocument`'s `dnsLookupImpl` seam.
- [x] 1.3 Before `fetch`: parse the URL, DNS-resolve the host (`{ all: true }`),
      and if any resolved address is forbidden, return the worker's existing
      connection-failure outcome shape (`statusCode: null`, descriptive
      `errorMessage`) without fetching.
- [x] 1.4 Set `redirect: 'manual'` on the delivery fetch.
- [x] 1.5 Exempt the sanctioned `http://` + literal-loopback-host callback (in
      lockstep with create-time `validateCallbackUrl`) so the local-dev / e2e
      receiver path is preserved. (Discovered via e2e regression; see design.md.)
- [x] 1.6 **Revision:** replace resolve-then-`fetch(url)` with send-time address
      binding — issue the delivery fetch through a per-request `undici.Agent`
      whose `connect` is pinned to the validated address literal(s)
      (`undici.buildConnector`, `servername` preserved for TLS SNI/cert
      verification), so `fetch` cannot re-resolve the hostname and race the
      validation. Added `undici` as a direct dependency. See design.md
      "Revision" section for why the original approach was a TOCTOU gap.

## 2. Prove it

- [x] 2.1 Unit test: a callback host resolving to `169.254.169.254` and (over
      `https`) to `127.0.0.1` is NOT fetched and is recorded as a failed attempt
      on the existing retry path (inject `dnsLookupImpl`).
- [x] 2.2 Assert a public-resolving host is still fetched (happy path unchanged)
      and that `redirect: 'manual'` is set; assert the sanctioned loopback dev
      callback is delivered without an IP check.
- [x] 2.3 Full `client-event-delivery-worker.test.js` suite — 13/13 green.
      `client-event-subscriptions-e2e.test.js` — 6/6 green.
      `as-client-event-subscriptions-operation.test.js` — 12/12 green.
- [x] 2.4 **Falsifiable send-time-binding test:** spy on `node:net`'s `connect`
      (not a mocked `fetch`) against a real loopback HTTP server, using a
      callback hostname that cannot itself resolve (`.invalid` TLD). Assert the
      literal address dialed is the validated address. Confirmed this test FAILS
      against the pre-revision (resolve-then-`fetch(url)`) implementation — ran
      it against the stashed prior code and observed the expected failure — and
      passes against the send-time-bound implementation.
- [x] 2.5 Companion test proves the sanctioned loopback-dev exemption path is
      unaffected (no pinning applied there; `dnsLookupImpl` must not be called).

## 3. Close the identical CIMD gap (same change, same session)

- [x] 3.1 Audit `server/cimd.js`'s `fetchCimdDocument`: confirmed the identical
      resolve → `isForbiddenIp` check → `fetchImpl(clientId, ...)`-with-original-
      hostname TOCTOU shape, live on `origin/main` today (not merely a design
      smell — a reachable gap in the CIMD client-identity fetch).
- [x] 3.2 Extract the shared mechanism into `server/ssrf-guard.js`:
      `isForbiddenIp` (moved from `cimd.js`, re-exported there for back-compat),
      `resolveAllowedAddresses` (resolve + classify, returns a structured
      failure reason so each caller keeps its own error wording),
      `createPinnedDispatcher` (the send-time-binding `undici.Agent`
      construction, previously local to the delivery worker). Added
      `server/ssrf-guard.d.ts` ambient types (mirrors the existing
      `hosted-ui.js`/`hosted-ui.d.ts` pairing convention).
- [x] 3.3 Rewired `client-event-delivery-worker.ts` to call the shared module
      instead of its own local `pinnedConnect`/`checkSsrfGuard` copies —
      deleted the duplication, kept its own scheme/exemption policy and
      error-message wording.
- [x] 3.4 Rewired `cimd.js`'s `fetchCimdDocument` to call the shared module;
      added an `isForbiddenIpImpl` injectable seam (previously only
      `dnsLookupImpl` was injectable); preserved exact existing error messages/
      codes (`CIMD fetch blocked: ... resolves to private/loopback address ...`,
      `cimd_fetch_failed`) and `redirect: 'manual'`; https-only scheme
      requirement and lack of a loopback exemption both unchanged.
- [x] 3.5 **Falsifiable CIMD send-time-binding test:** spy on `node:tls`'s
      `connect` (CIMD is https-only, so TLS not plain `net`) using the real
      `fetchImpl`, against an unresolvable `.invalid` `client_id` hostname.
      Confirmed FAILS two ways: (a) against current `origin/main`'s `cimd.js`
      (no `isForbiddenIpImpl` seam exists there, so the real classifier always
      blocks before reaching connect — proving `main` structurally can't even
      isolate this property), and (b) against a surgical variant of the fixed
      `cimd.js` with only the dispatcher-pinning line removed — which dialed
      the original hostname instead of the validated address, the precise
      TOCTOU shape. Both re-verifications done by hand, file swapped back
      after each.
- [x] 3.6 Outbound-fetch audit across the rest of the codebase (every call site
      outside node_modules/tests hitting an externally-influenceable URL) —
      no other same-class (resolve-then-fetch TOCTOU) gap found. Found one
      different-class gap (`web-push-notifications.js`, no guard at all, higher
      trust bar to reach) — deliberately NOT bundled into this change; recorded
      in design.md Residual risk as a separate follow-up.

## 4. Gate (Revisions 1–2)

- [x] 4.1 `pnpm typecheck` green (strict: `exactOptionalPropertyTypes`,
      `noUncheckedIndexedAccess`, etc.) — both revisions.
- [x] 4.2 `openspec validate fix-client-event-delivery-ssrf-guard --strict`
      green — including the new CIMD `MODIFIED Requirements` delta.
- [x] 4.3 `git diff --check` clean (no whitespace errors).
- [x] 4.4 Focused suites green: `cimd.test.js` 11/11, `client-event-delivery-ssrf-guard.test.js`
      7/7, `client-event-delivery-worker.test.js` 13/13,
      `client-event-subscriptions-e2e.test.js` 6/6,
      `as-client-event-subscriptions-operation.test.js` 12/12 (49 total across
      both callers' suites).
- [x] 4.5 Full reference-implementation suite (`node scripts/run-tests.js`)
      green. First run surfaced one real regression — a pre-existing test
      (`rs-client-event-deliver-operation.test.js`, "default transport attaches
      a bounded response-window abort signal") called `defaultHttpTransport`
      directly against a real hostname without injecting `dnsLookupImpl`; the
      guard correctly short-circuited it. Fixed by injecting a public-address
      DNS stub, isolating the abort-signal behavior from the SSRF decision.
      Re-ran full suite green after the fix.

## 5. Independent review (GPT-5.6 Terra) returned REVISE — close all three findings in one batch

Reviewed at `HEAD c5d25066a`; report at `tmp/workstreams/ssrf-terra-final-0717.md`.
Findings: P1 allow-list false passes (TEST-NET/benchmarking/6to4-relay ranges
accepted), P1 Web Push endpoint had zero SSRF guard (documented, not fixed, in
the Revision-2 Residual risk), P2 unbounded DNS-answer fallback. All three
closed here, together, not as another slice.

- [x] 5.1 **P1 allow-list:** replaced `isForbiddenIp` deny-list classification
      with `isGlobalUnicastAddress`, an explicit allow policy built on
      `ipaddr.js` (pinned direct dependency, `2.3.0`, the version already
      resolved transitively before this change) as an IP parser/CIDR-matcher.
      As first implemented in this task, denial for both IPv4 and IPv6 was
      driven by `ipaddr.js`'s own `range()` result (`unicast` treated as the
      only allowed value), with 6to4 (`2002::/16`) and NAT64/RFC6052
      (`64:ff9b::/96`) embedded IPv4 addresses unwrapped and recursed, and
      Teredo (`2001::/32`) denied outright. **This `range()`-as-policy
      mechanism, and the 6to4 conditional-allow specifically, were themselves
      found incorrect by a second review (Sol) and superseded — see task 7.1
      below and design.md Revision 4 for what actually ships as of HEAD:**
      the policy authority is now a vendored, dated IANA registry snapshot,
      `ipaddr.js`'s `range()` is not consulted for policy at all, and 6to4 is
      denied outright and unconditionally regardless of embedded payload.
      `isForbiddenIp` is kept as a deprecated `= !isGlobalUnicastAddress`
      alias.
- [x] 5.2 **P2 bounded fallback:** `resolveAllowedAddresses` gained a
      `maxAddresses` parameter (`MAX_VALIDATED_ADDRESSES = 8` default) and
      fails closed (`kind: 'too_many_addresses'`) — rejects the answer in full
      — rather than silently truncating, when a DNS answer exceeds the bound.
      `createPinnedDispatcher` and the new `createPinnedHttpsAgent` share one
      `boundedFallbackConnect` implementation for ordered, bounded fallback.
- [x] 5.3 **P1 Web Push:** `web-push-notifications.js` gained
      `guardWebPushEndpoint` (exported, directly testable) — validates
      `https:` scheme, runs `resolveAllowedAddresses` against the endpoint
      host, and on success returns a `createPinnedHttpsAgent`-built
      `node:https.Agent` (verified via `instanceof https.Agent`, matching
      `web-push`'s own validation of its `agent` option — the only
      integration point available without forking VAPID/encryption logic).
      `defaultSendNotification` calls the guard before `web-push`, throws
      `web_push_send_blocked` on failure (caught by existing send-failure
      handling), and passes `{ ..., agent: guard.agent }` as the one new
      option to the existing `sendNotification` call — VAPID headers, TTL,
      contentEncoding, and payload encryption untouched. Confirmed (by reading
      `web-push`'s `sendNotification` source) that it already rejects every
      non-2xx status including 3xx, so no separate redirect guard was needed.
- [x] 5.4 All three callers (`client-event-delivery-worker.ts`, `cimd.js`,
      `web-push-notifications.js`) rewired to the updated `ssrf-guard.js` API
      (`isGlobalUnicastAddressImpl` instead of `isForbiddenIpImpl`, handling
      the new `too_many_addresses` outcome). Two pre-existing tests updated
      for the renamed option (`isForbiddenIpImpl` → `isGlobalUnicastAddressImpl`
      with `() => true`, since they stub-accept a loopback stand-in address to
      isolate address-binding from the allow/block decision).
- [x] 5.5 **Table-driven allow-list tests** (`test/ssrf-guard.test.js`, new
      file): every Terra P1 example denied by name (`192.0.0.1`, `192.0.2.1`,
      `198.18.0.1`, `198.18.255.254`, `198.51.100.1`, `203.0.113.1`,
      `192.88.99.1`, `240.0.0.1`), full standard deny-set, every mapped/
      tunneled form (including the reviewer's own `2002:c000:0204::1` 6to4
      example embedding TEST-NET-1), and the same forms embedding a PUBLIC
      address (must be allowed). Malformed-input handling. `isForbiddenIp`
      legacy alias asserted to agree with `isGlobalUnicastAddress` throughout.
- [x] 5.6 **Bounded-fallback tests:** exactly-at-bound allowed,
      bound-plus-one rejected, the reviewer's 128-address case rejected,
      caller-supplied `maxAddresses` override respected.
- [x] 5.7 **Falsifiable ordered-fallback tests, real sockets (not mocked):**
      `createPinnedDispatcher` proven to dial two loopback addresses in exact
      order with real fallback (one real `ECONNREFUSED`, one real HTTP 200),
      and proven to attempt exactly as many connections as addresses supplied
      (three unreachable addresses → exactly three dial attempts).
- [x] 5.8 **Web Push guard tests:** block-before-send for a non-public
      endpoint, block for the Terra P1 addresses, block non-`https:`, fail
      closed on an oversized DNS answer, and a falsifiable real-socket test
      (spy on `node:tls`'s `connect`, unresolvable `.invalid` endpoint
      hostname, assert the validated address is dialed). Confirmed falsifiable
      by reverting `web-push-notifications.js` to `origin/main` and
      re-running: the module fails to load entirely (`guardWebPushEndpoint`
      does not exist) — the strongest possible proof the guard was absent
      before this change. All pre-existing Web Push tests (VAPID/encryption/
      fanout, via the pre-existing mocked-`sender` seam) remain green
      unmodified — protocol correctness untouched.
- [x] 5.9 **Re-audit after this revision:** an Explore-agent sweep of every
      outbound HTTP(S) call site in the codebase (outside node_modules/tests)
      confirmed all three call sites correctly wired to `ssrf-guard.js`, and
      found no other externally-influenced call site anywhere and no new
      call site introduced by this revision that bypasses the guard.
- [x] 5.10 OpenSpec rewritten to claim exactly what the code enforces: the
      delivery `ADDED Requirement` and CIMD `MODIFIED Requirement` both
      rewritten for the allow-list/bound properties (replacing "forbidden
      address" deny-list language); a new Web Push `ADDED Requirement` added,
      including the explicit statement that owner-authentication does not
      exempt an endpoint from the guard (a confused-deputy SSRF is still an
      SSRF) and that VAPID/encryption/TTL are explicitly out of scope for the
      guard to alter.

## 6. Gate (Revision 5, the Terra-revision closure)

- [x] 6.1 `pnpm typecheck` green.
- [x] 6.2 `openspec validate fix-client-event-delivery-ssrf-guard --strict`
      green (rewritten spec delta). `openspec validate --all --strict` green
      (63/63, no cross-spec breakage).
- [x] 6.3 `git diff --check` clean.
- [x] 6.4 `pnpm exec ultracite check` clean on touched `.ts`/`.d.ts` files
      (`.js` files remain lint-exempt under this repo's JS→TS migration
      policy in `biome.jsonc`, unchanged by this revision).
- [x] 6.5 Focused suites green AS OF `HEAD dfde1ded0` (this revision's HEAD at
      the time; superseded by task 8.5's counts as of the current HEAD —
      `ssrf-guard.test.js` grew from 9/9 to 18/18 and
      `web-push-notifications.test.js` from 44/44 to 50/50 in the Sol-revision
      closure below): `ssrf-guard.test.js` 9/9 (new),
      `cimd.test.js` 11/11, `client-event-delivery-ssrf-guard.test.js` 7/7,
      `client-event-delivery-worker.test.js` 13/13,
      `client-event-subscriptions-e2e.test.js` 6/6,
      `as-client-event-subscriptions-operation.test.js` 12/12,
      `web-push-notifications.test.js` 44/44 (1 pre-existing env-gated skip),
      `rs-client-event-deliver-operation.test.js` 18/18 — 120/120 total.
- [x] 6.6 Full reference-implementation suite (`node scripts/run-tests.js`)
      green: 6461 assertions passing, 0 failures, 1 pre-existing
      environment-gated skip (Postgres conformance).
- [x] 6.7 Independent diff + behavior verification: a second review
      (GPT-5.6 Sol, `tmp/workstreams/ssrf-sol-final-0717.md`, 99% confidence
      REVISE) reproduced five further gaps at this HEAD — see section 7.

## 7. Independent review (GPT-5.6 Sol) returned REVISE — close all five findings in one batch

Reviewed at `HEAD dfde1ded0`; report at `tmp/workstreams/ssrf-sol-final-0717.md`.
Findings: P1/High the allow-policy authority (`ipaddr.js`'s own `range()`)
was itself a stale, unversioned snapshot that predated several current IANA
IPv6 registry rows, and the 6to4 conditional-allow (task 5.1 above) was
itself incorrect; P1/High the Web Push pinned TLS connector could double-fire
its completion callback; P2/Medium Web Push had no wall-clock connection
bound; P2/Medium the tests and OpenSpec overstated what was proved (Web Push
tests never drove the real production sender; the connector-cap claim
"enforced at the connector" was not actually enforced there). All five closed
here, together, not as another slice. See design.md Revision 4 for the full
rationale.

- [x] 7.1 **P1 allow-policy authority:** replaced `ipaddr.js`'s `range()` as
      the classification authority with a new vendored data module,
      `server/iana-special-purpose-registry.js`, transcribed from the
      primary-source IANA IPv4/IPv6 Special-Purpose Address Registry CSVs
      (fetched via `curl`, snapshot dated 2026-07-18), using each row's own
      "Globally Reachable" value. `ipaddr.js` is retained only for parsing
      and CIDR containment matching (`parseCIDR`/`match`/`process`), never
      for classification — `.range()` is not called anywhere in the shipped
      `ssrf-guard.js`. Longest-prefix-match (`lookupSpecialPurposeRow`) added
      after an exhaustive registry sweep caught a real nested-CIDR bug
      (`192.0.0.9/32` PCP Anycast, reachable, inside `192.0.0.0/24` IETF
      Protocol Assignments, not reachable). 6to4 (`2002::/16`) is now denied
      OUTRIGHT and unconditionally — correcting task 5.1's conditional-allow,
      which treated the registry's `N/A` "Globally Reachable" value for that
      block as equivalent to `true`, which it is not. NAT64 global-use
      (`64:ff9b::/96` exactly) remains the one tunnel encoding whose embedded
      IPv4 is unwrapped and recursed; NAT64 local-use (`64:ff9b:1::/48`) is
      denied outright via its own row. Full research trail — raw CSVs,
      derivation rules, update procedure — preserved at
      `openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md`.
- [x] 7.2 **P1 TLS single-settlement:** `dialTlsOnce` (new) settles its
      per-attempt callback exactly once, removing whichever listener did not
      fire; `boundedFallbackConnect` independently tracks overall settlement
      and destroys any late-arriving success. Verified with a deterministic
      fake-socket model reproducing Sol's exact `secureConnect`-then-`error`
      ordering and the symmetric `error`-then-late-`secureConnect` case, plus
      a real end-to-end TLS handshake-then-destroy test.
- [x] 7.3 **P2 Web Push timeout:** added `WEB_PUSH_SEND_TIMEOUT_MS = 10_000`,
      forwarded as `web-push`'s `timeout` option (the only way that library
      installs a socket-inactivity bound — confirmed by reading its source).
      A deterministic hanging-transport test (a real server that never
      responds and never closes) proves the send is bounded and the pinned
      agent is still released.
- [x] 7.4 **P2 production-seam tests:** `defaultSendNotification` gained a
      test-only 4th parameter (`guardWebPushEndpointImpl`, `webPushModuleImpl`,
      defaulted; production callers unaffected). New tests drive the real
      function against a real local self-signed-cert HTTPS server with real
      VAPID keys (`web-push`'s own `generateVAPIDKeys()`) and real ECDH
      subscriber keys (`crypto.createECDH`), through a spy that calls
      straight through to the real `web-push` module. Falsified with a
      behavioral mutant (still exports/runs/guards, but silently omits
      `agent`/`timeout` from the real call) — 4 of 5 new tests failed against
      it with real `TypeError`s, not an import failure.
- [x] 7.5 **Connector-level cap enforcement:** `boundedFallbackConnect` now
      slices its input to `MAX_VALIDATED_ADDRESSES` itself; two new tests
      call each connector factory directly with more addresses than the
      bound and confirm no more than the bound are attempted.
- [x] 7.6 Fixed a pre-existing `cimd.test.js` assertion that expected the old
      (task-5.1, now-superseded) 6to4-embedded-public-address-allowed
      behavior.

## 8. Gate (Revision 7, the Sol-revision closure)

- [x] 8.1 `pnpm typecheck` green.
- [x] 8.2 `openspec validate fix-client-event-delivery-ssrf-guard --strict`
      green.
- [x] 8.3 `git diff --check` clean.
- [x] 8.4 `pnpm exec ultracite check` clean on touched `.ts`/`.d.ts` files.
- [x] 8.5 Focused suites green: `ssrf-guard.test.js` 18/18 (up from 9 —
      9 new: exhaustive registry sweep, 6to4-outright, 4 TLS
      single-settlement, 2 connector-cap), `cimd.test.js` 11/11,
      `client-event-delivery-ssrf-guard.test.js` 7/7,
      `client-event-delivery-worker.test.js` 13/13,
      `client-event-subscriptions-e2e.test.js` 6/6,
      `as-client-event-subscriptions-operation.test.js` 12/12,
      `web-push-notifications.test.js` 50/50 (up from 44 — 6 new: 1
      pre-existing env-gated skip, 5 new production-seam tests including the
      hanging-transport timeout case), `rs-client-event-deliver-operation.test.js`
      18/18 — 134/134 total.
- [x] 8.6 Full reference-implementation suite (`node scripts/run-tests.js`)
      green, 0 failures, run three times across the session.
- [ ] 8.7 Independent diff + behavior verification (maker ≠ judge) —
      delegated to a separate reviewer before merge recommendation. A third
      review (Opus, `tmp/workstreams/ssrf-opus-final-0717.md`) verdict LAND
      on security substance, with one required documentation-only fix (this
      revision to design.md/tasks.md) — see that report for the full
      independent verification record.
