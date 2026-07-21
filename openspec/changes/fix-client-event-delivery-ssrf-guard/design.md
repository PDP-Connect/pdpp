# Design — client-event delivery SSRF guard

## Context

Two files own the callback destination:

- `operations/as-client-event-subscriptions/index.ts` — `validateCallbackUrl`
  (create time): requires `https:`, or `http:` with a literal-hostname allowlist
  (`localhost`/`127.0.0.1`/`[::1]`/`::1`). No DNS resolution, no IP check.
- `server/client-event-delivery-worker.ts` — `defaultHttpTransport` (delivery
  time): raw `fetch(url, { method, headers, body, signal })`. No IP check, default
  redirect handling.

The gap is real on current `origin/main` and independently verified: a public
hostname that resolves (or rebinds) to a forbidden address is fetched. Create-time
validation alone cannot close it — DNS is resolved fresh on every delivery, so the
check MUST happen at delivery time to defeat rebinding.

A third file, `server/cimd.js` (`fetchCimdDocument`), independently has the exact
same TOCTOU shape for the CIMD client-identity metadata fetch — see the second
revision below. Both are fixed by this change.

### Revision 1: checking DNS before `fetch(url)` is itself a TOCTOU gap

An earlier version of this change resolved DNS once, checked `isForbiddenIp`
against the result, and then called `fetch(url, ...)` with the original hostname
string. That is a check-then-use race, not a fix: Node's `fetch` (undici) performs
its **own**, independent hostname resolution when it opens the TCP/TLS socket.
Between the validating lookup and the socket-level lookup, a low-TTL or
attacker-controlled DNS record can answer differently — the address that was
validated is not provably the address that gets connected to. (`server/cimd.js`'s
`fetchCimdDocument` had this exact same shape and the same latent gap; it was the
model this change originally copied — now fixed in Revision 2 below.)

The fix is to make the validated address and the connected address the same
value by construction, not by timing:

1. `new URL(url)`; if unparseable, fail the attempt (transient error).
2. `dnsLookup(hostname, { all: true })` — one resolution, whose result is kept.
3. If any resolved address `isForbiddenIp`, do NOT connect — return the existing
   `{ statusCode: null, errorMessage }` connection-failure shape so retry/backoff/
   dead-letter handles it unchanged.
4. Otherwise, issue the delivery `fetch` with a per-request `undici.Agent` whose
   `connect` function dials the validated address literals directly (via
   `undici.buildConnector`'s connector, called with `hostname` overridden to the
   validated IP and `servername` preserved as the original hostname for TLS SNI /
   certificate hostname verification). Undici never performs its own hostname
   resolution in this path — there's no second lookup for a rebind to exploit.
   `redirect: 'manual'` is kept so a 3xx from an initially-safe host cannot bounce
   the POST to a new, unvalidated location.

This is standard `undici.Agent`-level connection pinning, not a custom socket/TLS
implementation: `buildConnector` and `Agent#connect` are undici's own extension
points for exactly this purpose. `undici` is added as a direct dependency
(previously transitive/Node-bundled only) because the delivery worker now
constructs an `Agent` at this one call site.

The guard is injectable for tests: `defaultHttpTransport` gains optional
`dnsLookupImpl`/`isForbiddenIpImpl` seams (default to the real implementations),
mirroring `fetchCimdDocument`'s existing `dnsLookupImpl` seam. This lets tests
assert a blocked delivery without real DNS, and — for the send-time-binding
property specifically — lets a test assert against the literal address a real
`net.connect` call receives (see Acceptance checks).

### Revision 2: `cimd.js` has the identical gap and is fixed by extracting a shared mechanism

`fetchCimdDocument` in `server/cimd.js` independently has the same resolve →
`isForbiddenIp` check → `fetchImpl(clientId, ...)`-with-original-hostname shape.
It is a live gap on `origin/main` in the CIMD client-identity fetch path — a
`client_id` metadata document URL, which is attacker-influenceable (any party
registering a CIMD client controls it), fetched by the reference AS.

Rather than copy the pinned-connect mechanism a second time (which is exactly
how the first TOCTOU-shaped bug got copied into delivery in the first place —
duplicating a security-relevant mechanism is how it drifts), the address
classifier and the connection-pinning mechanism are extracted into a new shared
module, `server/ssrf-guard.js`:

- `isForbiddenIp(ip)` — moved here verbatim from `cimd.js` (re-exported from
  `cimd.js` for existing callers/tests that import it from there).
- `resolveAllowedAddresses(hostname, { dnsLookupImpl, isForbiddenIpImpl })` —
  resolves once, classifies every address, and returns either the validated
  address list or a structured failure reason (`dns_failed` / `no_addresses` /
  `forbidden_address` + the offending address) — NOT a formatted message, so
  each caller keeps its own error wording (`cimd.js`'s `CIMD fetch blocked: ...`
  vs. the delivery worker's `callback host ... resolves to forbidden address
  ...` are unchanged, byte-for-byte, from before this extraction).
- `createPinnedDispatcher(validatedAddresses)` — the same connection-pinning
  `undici.Agent` construction described in Revision 1, now shared.

What is deliberately NOT shared (each caller keeps its own policy, so the two
callers' genuinely different semantics don't get forced into one shape):
scheme validation (CIMD requires `https:` strictly via `validateCimdUrl`;
delivery accepts `https:` or the sanctioned `http:`+literal-loopback exception),
the loopback/dev exemption (CIMD has none; delivery does), redirect-following
policy call sites (both set `redirect: 'manual'`, but independently, at their
own fetch call), and error wrapping/codes (`cimd_fetch_failed` vs. the delivery
worker's `DeliveryOutcome` shape).

`fetchCimdDocument` gains the same `isForbiddenIpImpl` injectable seam
`defaultHttpTransport` already had (previously only `dnsLookupImpl` was
injectable), for test symmetry and to isolate the block/allow decision from the
send-time-binding property in tests, matching the delivery-worker test pattern.

`createPinnedDispatcher`'s returned `Agent`-shaped dispatcher is passed to
`fetchImpl`'s options unconditionally (not gated on `fetchImpl === globalThis.fetch`):
existing `cimd.test.js` stubs that return a canned `Response` already ignore
`signal`/`redirect`/`headers` they don't need, so adding `dispatcher` to that
options object is harmless to them, and avoids a fragile identity check.

### Revision 3: independent review found the guard itself was incomplete (allow-list gaps, unbounded fallback, unfixed Web Push)

An independent security review (`tmp/workstreams/ssrf-terra-final-0717.md`,
GPT-5.6 Terra) of Revisions 1–2 returned REVISE with three findings, all fixed
in this revision, in the same change.

**P1 — the classifier was a deny list, and deny lists are inherently
incomplete.** `isForbiddenIp` blocked a hand-picked set of IPv4 ranges but
silently passed `192.0.0.1`, `192.0.2.1` (TEST-NET-1), `198.18.0.1`
(benchmarking), `198.51.100.1` (TEST-NET-2), `203.0.113.1` (TEST-NET-3), and
others — all IANA special-purpose ranges that are not globally reachable but
are also not RFC 1918/loopback/link-local, so a "block known-bad ranges" list
never enumerated them. The reviewer's deterministic probe confirmed a resolver
answer of `198.18.0.1` reached the mocked fetch in both callers.

Fix (as first implemented in this revision; **superseded by Revision 4 below —
see that section for what actually ships**): replace the deny list with an
explicit **allow** policy, `isGlobalUnicastAddress` — an address passes only
by affirmatively qualifying as global-unicast, not by failing to match a
specific denied range. This revision built the classifier on `ipaddr.js`'s own
`range()` result (already present transitively in this monorepo's dependency
tree, pinned as a direct dependency at the exact version already resolved,
`2.3.0`), treating `ipaddr.js`'s hardcoded `SpecialRanges` tables as
IANA-registry-aligned for both IPv4 and IPv6, with `unicast` meaning
"everything else."

Two IPv6 tunnel encodings embed an IPv4 address but are not auto-unwrapped by
`ipaddr.js`'s `.process()` (verified empirically): 6to4 (`2002::/16`, IPv4 in
bytes 2–5) and NAT64/RFC6052 (`64:ff9b::/96`, IPv4 in the last 4 bytes). This
revision's implementation unwrapped **both** explicitly and recursed on the
embedded address, so a 6to4 address's fate depended on whether its embedded
IPv4 was itself public or forbidden. **This 6to4 handling was itself
incorrect and is corrected in Revision 4** — the IANA registry's own
"Globally Reachable" value for `2002::/16` is `N/A`, not `true`, so 6to4 must
be denied outright regardless of payload, not conditionally allowed based on
it; see Revision 4 for the corrected rationale. Teredo (`2001::/32`) was
denied outright without unwrapping in this revision and remains so. IPv4-mapped
IPv6 (dotted and hex forms, all lengths) IS auto-unwrapped by `.process()` and
needs no special handling (verified empirically:
`ipaddr.process('::ffff:127.0.0.1').range()` returns `'loopback'` directly, the
embedded address's own classification, not a generic "mapped" bucket).

`isForbiddenIp` is retained as a deprecated alias
(`= !isGlobalUnicastAddress`) so existing call sites that still reference it
by that name keep working, but new code — and both `resolveAllowedAddresses`'s
default and every rewritten call site — uses `isGlobalUnicastAddress` directly.

**P2 — the multi-address fallback was unbounded.** `resolveAllowedAddresses`
retained every address a DNS answer returned with no cap, and the pinned
connector retried them all sequentially, including after individual
connection failures. The reviewer's probe: a 128-address injected DNS answer
was returned intact by the guard, forcing unbounded sequential connection
attempts an attacker-controlled DNS response could trigger at will.

Fix: `resolveAllowedAddresses` gains a `maxAddresses` parameter
(`MAX_VALIDATED_ADDRESSES = 8` by default — small and deliberately
conservative; legitimate deployments, even multi-region dual-stack ones,
resolve to a handful of addresses, not dozens). A DNS answer exceeding the cap
is rejected in full (`kind: 'too_many_addresses'`) — fails closed — rather
than silently truncated to a bounded prefix; a caller could reasonably assume
"the addresses I validated are the addresses that get tried," and silent
truncation of *which* addresses violates that assumption even though it is
also "bounded." Failing loud is both the more conservative choice for a
security boundary and easier to test (the falsifiable test asserts on the
exact rejection, not on which subset was silently kept). The pinned
connector's fallback logic itself was already ordered and stops trying once a
connection succeeds or the address list is exhausted; the fix here is entirely
in what gets fed into it.

**P1 (separate finding) — Web Push had no guard of any kind, not merely an
incomplete one.** `server/web-push-notifications.js`'s `defaultSendNotification`
passed an owner-supplied `subscription.endpoint` straight to the `web-push` npm
package, which parses the URL and issues its own `https.request` internally
with zero IP policy. The prior revision of this change *documented* this as an
out-of-scope, different-class residual — the reviewer correctly rejected that
as insufficient: "documentation does not remove the socket-level false pass."

Fix: inspected `web-push@3.6.7`'s `WebPushLib.prototype.sendNotification`
directly (`node_modules/web-push/src/web-push-lib.js`) to find the only
available integration point without forking VAPID-header generation or
payload encryption: `options.agent`, validated by the library with
`instanceof https.Agent` — so a duck-typed object will not pass; it must be a
real subclass. `ssrf-guard.js` gains `createPinnedHttpsAgent`, a
`node:https.Agent` subclass whose `createConnection` performs the same
bounded, ordered-fallback dial as `createPinnedDispatcher`, using `node:tls`'s
async `connect`/`callback(err, socket)` convention (verified empirically that
`https.Agent#createConnection` supports both synchronous-return and
asynchronous-callback conventions; the callback form is required here because
bounded fallback across multiple addresses must wait for one attempt to fail
before trying the next).

`web-push-notifications.js` gains `guardWebPushEndpoint(endpoint, opts)`
(exported, directly unit-testable): validates the endpoint is `https:`, runs
`resolveAllowedAddresses` against its host, and on success returns a
`createPinnedHttpsAgent`-built agent. `defaultSendNotification` calls this
guard before ever calling `web-push`, throws a `web_push_send_blocked`-coded
error on failure (caught by the existing send-failure handling path, which
already marks the subscription's failure state on any thrown error — no new
failure-handling branch needed), and otherwise passes `{ ..., agent:
guard.agent }` as the one new option to the existing `sendNotification` call.
Nothing about VAPID header construction, `TTL`, or `contentEncoding` changed;
`generateRequestDetails`/`encrypt`/`getVapidHeaders` in the `web-push` library
are untouched by this fix, and existing mocked-`sender` tests (which never
exercise the real `web-push` call) continue to prove the payload/notification-
building logic around the sender is correct, unchanged. `web-push` was
confirmed (by reading its `sendNotification` source) to already reject every
non-2xx status, including 3xx, as an "unexpected response code" — it never
calls a redirect-following HTTP client — so no separate redirect guard was
needed for this path.

### Revision 4: independent review found the allow-policy authority, the Web Push connection lifecycle, and several claims were still wrong

A second independent security review (`tmp/workstreams/ssrf-sol-final-0717.md`,
GPT-5.6 Sol, 99% confidence REVISE) of Revision 3 reproduced five further
concrete gaps, all fixed in this revision. This is the section that describes
what the code **actually ships as of the current HEAD** — Revision 3's
descriptions of the classifier mechanism and the 6to4 rationale above are
superseded by what follows.

**P1/High — `ipaddr.js`'s `range()` is not a policy authority.** Revision 3
treated `range() === 'unicast'` as affirmative registry evidence. It is only
`ipaddr.js`'s own default fallthrough for any address absent from its
hardcoded, unversioned `SpecialRanges` tables — which predate several rows the
live IANA IPv6 Special-Purpose Address Registry has since added
(`64:ff9b:1::/48` local-use NAT64/RFC 8215, `100:0:0:1::/64` dummy prefix/RFC
9780, `3fff::/20` documentation/RFC 9637, `5f00::/16` SRv6 SIDs/RFC 9602).
Sol's probe reproduced six false-passes, most materially
`64:ff9b:1::7f00:1` — local-use translation space embedding IPv4 loopback,
classified `unicast` by `ipaddr.js` alone.

Fix: `isGlobalUnicastAddress` (`server/ssrf-guard.js`) no longer consults
`ipaddr.js`'s `range()` for policy at all — it is never called in the shipped
code. The policy authority is now a dated, vendored snapshot of both current
IANA Special-Purpose Address Registries,
`server/iana-special-purpose-registry.js`, transcribed directly from the
primary-source CSVs (fetched via `curl`, not a summarizing tool) on
2026-07-18, using each registry row's own published "Globally Reachable"
value as the classification authority for that row. `ipaddr.js` is retained
only as an IP parser and CIDR-containment matcher (`parseCIDR`, `match`,
`process`'s IPv4-mapped-unwrapping normalization) — a role Sol's review
confirmed it is well-suited for; only its own range classification was the
defect. The full raw registry data, the derivation rules (including exactly
why 6to4 is denied outright — see below), and a documented 6-step
snapshot-refresh procedure are preserved durably at
`openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md`.
This snapshot is explicitly dated, not a live feed: it proves every address in
either registry as of 2026-07-18 classifies correctly; it does not claim to
close IANA allocations made after that date.

Longest-prefix-match (`lookupSpecialPurposeRow`) was added because the
registries themselves carve more specific allocations, with a *different*
reachability value, out of broader blocks — e.g. `192.0.0.9/32` (Port Control
Protocol Anycast, `Globally Reachable: true`) sits inside `192.0.0.0/24`
(IETF Protocol Assignments, `false`). An exhaustive table-driven test sweeping
every row in both vendored tables caught this as a real bug during
development (first-match-in-declaration-order silently returned the broader,
wrong row's value for several nested addresses).

**6to4 (`2002::/16`) is denied OUTRIGHT and UNCONDITIONALLY, regardless of its
embedded IPv4 payload — correcting Revision 3's conditional-allow, which was
itself incorrect.** The registry's own "Globally Reachable" value for
`2002::/16` is `N/A`, not `true` — 6to4 is a transport mechanism whose actual
reachability depends on relay availability the registry cannot encode; `N/A`
is not equivalent to `true` and must not be treated as such. `isGlobalUnicastAddress`
therefore checks the destination against `2002::/16` first and denies it
immediately, before any embedded-address unwrapping — `2002:0808:0808::1`
(embedding the public address `8.8.8.8`) is denied exactly the same as
`2002:c000:0204::1` (embedding TEST-NET-1). NAT64 GLOBAL-USE (`64:ff9b::/96`
exactly — a distinct block whose own "Globally Reachable" value genuinely is
`true`) is the only tunnel encoding that still gets its embedded IPv4
unwrapped and recursively checked; NAT64 LOCAL-USE (`64:ff9b:1::/48`) is
denied outright via its own registry row, with no unwrapping, same as 6to4.

**P1/High — the Web Push pinned TLS connector could double-fire its
completion callback.** `createPinnedHttpsAgent`'s TLS adapter attached
independent `once('secureConnect', ...)` / `once('error', ...)` listeners
with no settlement guard; a socket emitting both events (either order)
invoked the connection callback twice — once reporting success, once
reporting failure — which could open a second connection after the request
already received a socket, or report failure after success had already been
handed to the caller. Sol's deterministic fake-socket probe reproduced two
callbacks for one connection attempt.

Fix: `dialTlsOnce` (new) settles its own callback exactly once per attempt —
on whichever event fires first, it immediately removes the listener for the
event that did NOT fire, so a later event on the same socket cannot
re-invoke the callback; the error path additionally destroys the socket.
`boundedFallbackConnect` (shared by both `createPinnedDispatcher` and
`createPinnedHttpsAgent`) independently tracks its own overall settlement and
destroys any late-arriving success rather than propagating it or advancing
fallback past an outcome already reported — belt-and-suspenders in case a
future `dialOne` implementation is less careful than `dialTlsOnce`. Both
layers are verified: a deterministic fake-socket model reproduces Sol's exact
`secureConnect`-then-`error` ordering and the symmetric `error`-then-late-
`secureConnect` case, plus a real end-to-end test (a genuine self-signed TLS
handshake, then the server destroys the socket) confirming exactly one
outcome is observed.

**P2/Medium — Web Push had no wall-clock connection bound.** The pinned agent
and the address-count cap bound how many addresses are dialed, not how long
any single attempt may stay open. `web-push@3.6.7` only installs Node's
socket-inactivity timeout when the caller supplies its `timeout` option
(confirmed by reading `web-push-lib.js`); without it, an allowed endpoint that
accepted a connection and then hung left `sendNotification` — and the fanout
`Promise.all` awaiting it — pending indefinitely, and the agent-cleanup
`finally` block never ran.

Fix: `WEB_PUSH_SEND_TIMEOUT_MS = 10_000` (matching the order of magnitude of
CIMD's 5s and delivery's 10s bounds) is now passed as `web-push`'s `timeout`
option. A deterministic hanging-transport test — a real server that accepts
the TLS handshake and then never responds and never closes — proves the send
is bounded near the configured timeout and that the pinned agent is still
released via the existing `finally` block on that outcome.

**P2/Medium — the tests and OpenSpec overstated what was proved.** The
Revision-3 Web Push tests exercised only `guardWebPushEndpoint` directly,
never the actual production sending function (`defaultSendNotification`, the
function every fanout call site invokes as `sender`), so they could not prove
the guard's agent/timeout were actually forwarded to the real library call,
that agent cleanup was safe, or that a timeout existed at all. Revision 3's
falsification method for a related claim — reverting the whole source file
and observing a missing-export module-load failure — proved the export
didn't exist yet, which is a weaker oracle than proving a regression that
*keeps* the export but silently weakens its behavior would be caught.

Fix: `defaultSendNotification` gained a test-only 4th parameter
(`{ guardWebPushEndpointImpl, webPushModuleImpl }`, defaulted so every
production caller — always exactly 3 positional args — is unaffected). New
tests drive the real function against a real local self-signed-cert HTTPS
server, with real VAPID keys (`web-push`'s own `generateVAPIDKeys()`) and real
ECDH subscriber keys (Node's `crypto.createECDH` — the standard API, not
hand-crafted fixtures), through a thin spy wrapper that calls straight
through to the real `web-push` module while recording the exact options
forwarded. Falsified with a behavioral mutant (still exports and runs
`defaultSendNotification`, still calls the guard, still throws on block —
but silently omits `agent`/`timeout` from the actual `sendNotification({...})`
call) rather than a missing-export failure: 4 of the 5 new production-seam
tests failed against that mutant with real `TypeError`s and assertion
failures from the real library receiving `undefined` where the pinned agent
should be.

Separately, the connector factories (`createPinnedDispatcher`,
`createPinnedHttpsAgent`) previously accepted an arbitrary-length address
array with no enforcement of their own — every production caller happened to
bound its input via `resolveAllowedAddresses`, so production behavior was
correct in practice, but the connector-level bound itself was not actually
enforced, only assumed. `boundedFallbackConnect` now slices its input to
`MAX_VALIDATED_ADDRESSES` itself; a test calls each connector factory
directly with more addresses than the bound and confirms no more than the
bound are ever attempted, independent of the resolver.

### Sanctioned local-development exception (behavior preservation)

`validateCallbackUrl` (create time) permits `http://` for exactly the literal
hosts `localhost`/`127.0.0.1`/`[::1]`/`::1` and rejects every other `http://`
callback. The reference's own e2e delivery tests, and local development, POST to a
real loopback receiver over that path. A naive "block all forbidden IPs at
delivery time" contradicts that sanctioned path (loopback IS a forbidden address)
and broke three e2e tests in the first implementation pass.

Resolution: the delivery-time guard skips the resolved-address check for exactly
that same `http://` + literal-loopback-host exception, and applies the full DNS +
`isForbiddenIp` check to everything else (all `https://` callbacks). This is not
an SSRF hole: create-time validation already guarantees a public-looking
(`https://`) callback is the only thing that can carry a rebinding host, and those
are precisely what the guard checks. An attacker cannot register `https://` for a
literal loopback host and thereby bypass the check, because a literal loopback
host under `https://` still resolves to loopback and is blocked. The exception
set is duplicated as a small literal in both files with a cross-reference comment;
they must stay in lockstep (noted in both).

## Alternatives considered

- **Guard only at create time** — rejected: cannot defeat DNS rebinding; the
  resolved address at create time is not the address fetched at delivery time.
- **Resolve DNS, check `isForbiddenIp`, then call `fetch(url)` with the original
  hostname** — this change's first attempt for delivery, and `cimd.js`'s
  pre-existing shape; rejected on review for both. `fetch` re-resolves the
  hostname independently, so the checked and connected addresses are not
  provably the same value. This is the general shape of a DNS-rebinding TOCTOU
  bug, not a fix for one.
- **Keep the pinned-connect mechanism local to each file (duplicate it into
  `cimd.js` instead of sharing)** — rejected. This is literally how the bug
  propagated the first time: the original delivery-worker SSRF guard was modeled
  on `cimd.js`'s DNS-resolve-then-check code and copied its TOCTOU flaw along
  with it. Two independent implementations of a security-relevant mechanism is
  how they drift out of sync over time (one gets patched, the other doesn't).
  Extracting `resolveAllowedAddresses`/`createPinnedDispatcher`/`isForbiddenIp`
  into `server/ssrf-guard.js` makes there one mechanism to prove correct instead
  of two — while each caller keeps its own scheme/exemption/error-message
  policy, which does differ and should not be forced into a shared shape.
- **A new generic networking framework / `safeFetch` abstraction** (retries,
  connection pooling policy, header management, etc. as one general-purpose
  module) — rejected. The shared module is intentionally narrow: three
  functions, no options explosion, no framework ambitions. It does exactly one
  thing (resolve, classify, pin) and nothing else; each caller still owns its
  own `fetch`/`fetchImpl` call, error wrapping, and response handling.
- **Block at the socket layer via a custom `connect`/`lookup` hook on an
  `undici.Agent`** — adopted. This is undici's own documented extension point for
  pinning connections (`buildConnector` + `Agent#connect`), not a bespoke
  socket/TLS implementation. It's the only approach that makes the validated and
  connected addresses the same value by construction rather than by timing.
- **Hand-extend the deny list with the specific ranges the reviewer found
  missing** (add TEST-NET/benchmarking/6to4-relay to the existing
  `classifyIpv4Address` regex ladder) — rejected. This would close exactly the
  instances found and leave the class of bug open: any future IANA
  special-purpose allocation, or any range the reviewer's probe didn't happen
  to try, would again silently pass. An allow list is closed by construction —
  new IANA allocations are `unicast` or they aren't — a deny list is open by
  construction and requires someone to remember to update it forever.
- **Hand-write a from-scratch IANA range table instead of using a library** —
  rejected. This is exactly the approach that produced the P1 gap: the
  original `classifyIpv4Address`/`isForbiddenIp` WAS a hand-written range
  table, and it was incomplete. `ipaddr.js` is small (no transitive
  dependencies of its own), already present in this monorepo's dependency
  tree before this change (used by other packages), and its range tables are
  demonstrably more complete (verified against the reviewer's exact examples)
  than a bespoke one this change would otherwise have had to write and
  maintain. Adding it as a pinned direct dependency is a smaller error surface
  than re-deriving the IANA registry by hand a second time.
- **Silently truncate an oversized DNS answer to the first N addresses instead
  of failing closed** — rejected. Both are "bounded," but truncation makes a
  quiet policy decision (which addresses are "the real ones") that a caller
  has no visibility into and that an attacker could exploit by ordering a
  malicious address early in an otherwise-legitimate-looking answer. Failing
  closed on the whole answer is louder, simpler to reason about, and simpler
  to test (assert the rejection, not "which subset got kept and was it the
  right one").
- **For Web Push: pre-resolve the endpoint host, check it, then call
  `web-push.sendNotification(subscription, ...)` unmodified (no `agent`)** —
  rejected; this is the exact TOCTOU shape Revisions 1–2 exist to close.
  `web-push` performs its own `url.parse(subscription.endpoint)` →
  `https.request({ hostname: urlParts.hostname })` internally — a pre-resolve-
  then-hope-it-doesn't-re-resolve check has no more effect here than it did
  for delivery or CIMD before their fixes.
- **For Web Push: fork/vendor `web-push`'s request logic to add IP checking
  directly** — rejected. `web-push`'s `generateRequestDetails` handles VAPID
  signing, GCM/FCM key selection, and payload encryption — forking it to add
  socket pinning would create a second, drifting implementation of protocol
  logic this reference implementation does not own and should not need to
  maintain. The library's own `agent` option (validated `instanceof
  https.Agent`) is a real, intentional extension point; using it is strictly
  less code and less risk than forking.

## Acceptance checks

- A `callback_url` (delivery) or `client_id` (CIMD) whose host resolves to
  `169.254.169.254` (and to `127.0.0.1`) is NOT connected to; the failure follows
  each caller's existing error path (delivery: retry; CIMD: `cimd_fetch_failed`).
  A host resolving to a public address is fetched normally in both (happy path
  unchanged for both).
- `redirect: 'manual'` is set on both the delivery fetch and the CIMD fetch
  (unchanged from before this change for CIMD; unchanged from Revision 1 for
  delivery).
- **Send-time address binding (falsifiable), both callers:**
  - Delivery: a test spies on `node:net`'s `connect` (what the real HTTP client
    calls to open the TCP socket, independent of any mocked `fetch`) and asserts
    the literal address dialed is the validated address — using a callback
    hostname that cannot itself resolve (`.invalid` TLD), so the request can only
    succeed if the transport connects directly to the validated IP without
    re-resolving the hostname.
  - CIMD: the same pattern, spying on `node:tls`'s `connect` instead (CIMD is
    https-only, so the connect path goes through TLS, not the plain-http `net`
    branch) — using the real `fetchImpl` (`globalThis.fetch`, not a stub) so the
    actual socket layer is exercised, and an unresolvable `.invalid` `client_id`
    hostname. Nothing needs to accept the TLS handshake for this test; it proves
    WHERE the connection attempt was aimed (`tls.connect`'s `host`), not that a
    full document fetch succeeds.
  - Both tests were confirmed to FAIL against their pre-fix implementation: the
    delivery test against the resolve-then-`fetch(url)` code from Revision 1's
    "first attempt"; the CIMD test against both (a) the current `origin/main`
    `cimd.js` (which has no `isForbiddenIpImpl` seam at all, so the real
    classifier always blocks the test's `127.0.0.1` stand-in before reaching the
    connect layer — proving `main`'s CIMD code structurally cannot isolate and
    prove this property) and (b) a surgical variant of the fixed `cimd.js` with
    only the `createPinnedDispatcher` call removed (dispatcher left `undefined`,
    everything else unchanged) — which reached `tls.connect` but dialed the
    original unresolvable hostname instead of the validated address, the precise
    TOCTOU shape. Both re-verifications were done by hand (temporarily swapping
    the file, re-running the test, restoring it) before this report was written.
- Existing `client-event-delivery-worker.test.js`, `client-event-subscriptions-e2e.test.js`,
  `as-client-event-subscriptions-operation.test.js`, and `cimd.test.js` suites
  stay green, including the real loopback e2e delivery test (proves the
  sanctioned local-dev exemption still works end-to-end, unpinned) and all
  pre-existing CIMD unit tests (proves CIMD's own scheme-only, no-exemption
  policy is unchanged).
- One pre-existing test (`rs-client-event-deliver-operation.test.js`, "default
  transport attaches a bounded response-window abort signal") called
  `defaultHttpTransport` directly against a real (now DNS-resolved) hostname
  without injecting `dnsLookupImpl`; the guard correctly short-circuited it
  before reaching the mocked `fetch`. Fixed by injecting a public-address
  `dnsLookupImpl` stub, isolating the abort-signal behavior under test from the
  (separately covered) SSRF decision — not a defect in the guard.
- **Allow-list table-driven coverage (`test/ssrf-guard.test.js`):** every
  address from the reviewer's P1 finding (`192.0.0.1`, `192.0.2.1`,
  `198.18.0.1`, `198.18.255.254`, `198.51.100.1`, `203.0.113.1`, plus
  `192.88.99.1` and `240.0.0.1`) is asserted denied by name, alongside the full
  standard deny-list set and every mapped/tunneled representation (dotted and
  hex IPv4-mapped IPv6, 6to4-embedded, NAT64-embedded — both denying an
  embedded non-public address and allowing an embedded public one, including
  the reviewer's own `2002:c000:0204::1` example). Malformed input (`''`,
  `null`, `undefined`, invalid syntax) is asserted to return `false` rather
  than throw.
- **Bounded-fallback coverage:** `resolveAllowedAddresses` is asserted to
  allow exactly `MAX_VALIDATED_ADDRESSES`, reject `MAX_VALIDATED_ADDRESSES + 1`
  with `too_many_addresses`, reject the reviewer's 128-address case, and
  respect a caller-supplied `maxAddresses` override.
- **Falsifiable ordered-fallback coverage, real sockets:** a test spies on
  `node:net`'s `connect` and drives a real `createPinnedDispatcher` through
  two loopback addresses — one with nothing listening (`127.0.0.2`, real
  `ECONNREFUSED`, not a mock) and one with a real HTTP server (`127.0.0.1`) —
  asserting both the exact dial order and that the fallback succeeds. A second
  test asserts the connector attempts exactly as many connections as
  addresses supplied (three unreachable loopback addresses, exactly three
  dial attempts, no more) — the bound is now enforced at the connector level
  itself (`boundedFallbackConnect` slices to `MAX_VALIDATED_ADDRESSES`), not
  merely a property that happened to hold because every production caller
  passed an already-bounded list from the resolver.
- **Web Push guard coverage (`test/web-push-notifications.test.js`):**
  `guardWebPushEndpoint` is asserted to block a non-public endpoint, block the
  Terra P1 addresses, block non-`https:` endpoints, and fail closed on an
  oversized DNS answer — all using the guard function directly (the smallest
  concept-correct seam), not a crypto/VAPID harness. A falsifiable real-socket
  test spies on `node:tls`'s `connect` (the pinned `https.Agent`'s dial path)
  with an unresolvable `.invalid` endpoint hostname and asserts the literal
  validated address is dialed. `createPinnedHttpsAgent`'s return value is
  asserted to be a real `https.Agent` instance (required by `web-push`'s
  `instanceof` check). Confirmed falsifiable by reverting
  `web-push-notifications.js` to its pre-fix `origin/main` state and
  re-running the suite: the module fails to load at all (`guardWebPushEndpoint`
  does not exist), the strongest possible confirmation that the guard did not
  exist before this change. All pre-existing Web Push tests (VAPID/encryption/
  fanout/store behavior, exercised via the pre-existing mocked-`sender`
  injection seam) remain green, unmodified, proving protocol correctness is
  untouched.
- `pnpm typecheck` green; `openspec validate fix-client-event-delivery-ssrf-guard --strict` green;
  `openspec validate --all --strict` green; `pnpm exec ultracite check` clean
  on touched `.ts`/`.d.ts` files; `git diff --check` clean.
- **Re-audit after this revision:** an Explore-agent-driven sweep of every
  outbound HTTP(S) call site in the codebase (outside `node_modules`/tests)
  confirmed all three guarded call sites correctly import and call
  `ssrf-guard.js`, and found no other externally-influenced call site and no
  new call site introduced by the fix that bypasses the guard. See
  `tmp/workstreams/ssrf-sendtime-bound-0717.md` for the full table.

## Residual risk

As of this revision, all three findings from the independent review
(`tmp/workstreams/ssrf-terra-final-0717.md`) are fixed and the Web Push finding
from the prior revision's Residual risk section is closed — see "Status" in
`tmp/workstreams/ssrf-sendtime-bound-0717.md` for the final disposition. What
remains, none of which is a known exploitable gap:

- The pinned connector tries validated addresses in resolution order and does not
  itself re-validate on a mid-request DNS change during connection retries within
  a single fetch/send attempt (not applicable here: the same validated,
  already-bounded address list is used for the whole attempt, so there's
  nothing left to re-validate against).
- IPv6 zone IDs and non-standard port encodings in resolved addresses are
  handled by `ipaddr.js`'s parsing (unchanged from its own behavior); this
  change does not add or alter handling for either.
- `MAX_VALIDATED_ADDRESSES = 8` is a judgment call, not a value derived from a
  formal capacity analysis. It is chosen to comfortably exceed realistic
  legitimate multi-region/dual-stack DNS answers while remaining small enough
  that even a full walk of the bound is cheap. If a legitimate deployment ever
  needs more than 8 addresses for a single callback/client_id/endpoint host,
  delivery would fail closed rather than degrade — this is the intended
  fail-closed behavior, not a bug, but is worth knowing as an operational
  characteristic.
- `createPinnedHttpsAgent`'s `agentOptions` passthrough (e.g.
  `rejectUnauthorized`) is not itself audited here beyond what
  `web-push-notifications.js` actually passes (nothing beyond the pinned
  addresses in production code — `agentOptions` defaults to `{}` at every real
  call site; only a test uses `{ rejectUnauthorized: false }` against a
  throwaway self-signed cert). A future caller passing an unsafe
  `agentOptions` override would be its own, separate review item.
- Independent review of this specific revision (the P1/P1/P2 closure) has not
  yet occurred — this design doc and the workstream report are the maker's
  account. A separate reviewer should re-verify the falsification proofs
  (documented exactly, reproducibly, in both files) before this is merged.
