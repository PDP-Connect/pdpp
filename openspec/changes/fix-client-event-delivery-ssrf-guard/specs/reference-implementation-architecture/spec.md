## ADDED Requirements

### Requirement: Client-event delivery SHALL guard against SSRF at send time

The reference client-event delivery worker SHALL, before issuing each outbound
delivery request to a subscription's `callback_url`, resolve the callback host
and refuse to send the request unless every resolved network address is a
global-unicast address. This is an ALLOW policy, not a deny policy: an address
SHALL be accepted only by explicitly qualifying as global-unicast, not merely
by failing to match a specific known-bad range.

The global-unicast classification SHALL be derived from a dated, vendored
snapshot of the IANA IPv4 and IPv6 Special-Purpose Address Registries
(`server/iana-special-purpose-registry.js`, snapshot date recorded in that
file and in
`openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md`),
using each registry row's own published "Globally Reachable" value as the
authority for that row — NOT a third-party IP-parsing library's own address-
range classification, which is itself an independent snapshot with no
documented currency guarantee relative to the registries. This snapshot SHALL
be treated as proving only that every address in either registry as of the
snapshot date is correctly classified; it SHALL NOT be represented as closing
the address space against IANA special-purpose allocations made after the
snapshot date. Denied categories include, at minimum, loopback, private (RFC
1918), CGNAT (100.64.0.0/10), link-local (169.254.0.0/16 and IPv6 fe80::/10,
including cloud metadata endpoints), multicast (governed by a separate IANA
registry, not the special-purpose registry, but denied unconditionally as a
non-unicast category regardless), unspecified, broadcast, IPv6 unique-local,
and every row in the vendored snapshot whose "Globally Reachable" value is not
`true` — including, but not limited to, the three TEST-NET ranges
(192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), the IPv4 benchmarking range
(198.18.0.0/15), and their IPv6 equivalents (documentation 2001:db8::/32 and
3fff::/20, benchmarking 2001:2::/48, local-use IPv4-IPv6 translation
64:ff9b:1::/48, the dummy prefix 100:0:0:1::/64, and Segment Routing SIDs
5f00::/16).

Every mapped or tunneled representation of a denied address SHALL classify
identically to its canonical form. Dotted and hex-form IPv4-mapped IPv6
(`::ffff:a.b.c.d`, `::ffff:HHHH:HHHH`, fully expanded `0:0:...:ffff:a.b.c.d`)
and NAT64/RFC 6052 GLOBAL-USE-embedded IPv4 (the exact block `64:ff9b::/96`,
which is itself registry-affirmed globally reachable) SHALL each be evaluated
against the embedded IPv4 address's own global-unicast status, not merely
permitted as an unrecognized-but-unblocked IPv6 literal. 6to4 (`2002::/16`)
SHALL be denied OUTRIGHT and unconditionally, regardless of its embedded IPv4
payload — the registry's own "Globally Reachable" value for this block is not
`true` (it is a transport mechanism whose actual reachability depends on relay
availability the registry cannot encode, not a reachability guarantee), so it
SHALL NOT be conditionally allowed based on inspecting the address embedded in
it. NAT64 LOCAL-USE (the distinct, non-overlapping block `64:ff9b:1::/48`)
SHALL likewise be denied outright via its own registry row, with no embedded-
address unwrapping.

The delivery request SHALL NOT follow HTTP redirects. This guard SHALL be
applied at delivery time on every attempt, not only at subscription-create
time, so that a callback host that resolves or re-resolves to a non-public
address after creation cannot be reached. A blocked delivery SHALL be treated
as a transient delivery failure that follows the existing retry, backoff, and
dead-letter path; it SHALL NOT crash the worker.

The address validated against the global-unicast allow policy SHALL be the
same address the delivery request connects to (send-time address binding).
Resolving the callback host once to validate it and then issuing the request
against the original hostname is NOT sufficient: the HTTP client may perform
its own, independent resolution when opening the connection, and a hostname
with a low-TTL or attacker-controlled DNS record can resolve differently
between the validating lookup and the connection (DNS rebinding). The delivery
worker SHALL therefore connect only to the literal address(es) that were
validated for a given attempt, not re-resolve the hostname at connection time.

The number of resolved addresses retained and attempted for a single delivery
SHALL be bounded to a small, documented maximum (`MAX_VALIDATED_ADDRESSES` in
`server/ssrf-guard.js`, 8 as of this requirement). A DNS answer that returns
more addresses than this bound SHALL cause the delivery attempt to fail closed
— be treated as blocked in full — rather than silently proceeding with a
truncated subset of the answer. This bound SHALL be enforced both by the
resolver (`resolveAllowedAddresses`, which rejects an oversized DNS answer in
full before any address is retained) AND, independently, by the connection
factories that dial the retained addresses (`createPinnedDispatcher`,
`createPinnedHttpsAgent`), which SHALL themselves attempt at most
`MAX_VALIDATED_ADDRESSES` of whatever address list they are given — a
defensive limit at the connector layer, not solely an invariant that holds
only because every current production caller happens to pass the resolver's
already-bounded output. Within the bound, the delivery worker SHALL attempt
the validated addresses in the order DNS returned them, falling back to the
next address only on a connection failure of the prior one (ordered
fallback), and SHALL NOT attempt more connections than validated addresses
were retained (bounded by the above).

Both the overall fallback sequence and each individual connection attempt
SHALL be single-settlement: the completion callback for a connection attempt,
and the completion callback for the overall fallback sequence, SHALL each be
invoked at most once, regardless of how many underlying socket events fire or
in what order. A connection attempt that reports success SHALL NOT
subsequently be reported as a failure (or vice versa) to the same caller, a
successful connection SHALL NOT be followed by an additional fallback attempt
after that success has already been reported, and a socket belonging to an
attempt whose outcome has already been reported by a DIFFERENT event SHALL be
destroyed rather than silently retained or re-reported.

The guard SHALL exempt only the same sanctioned local-development callback the
create-time validator permits — an `http://` URL whose host is the literal
`localhost`, `127.0.0.1`, `[::1]`, or `::1`. Because create-time validation
accepts `http://` for exactly those literal hosts and nothing else, this
exemption is not an SSRF vector: an attacker cannot register a public-looking
callback that later rebinds through it. All other callbacks (every `https://`
callback) SHALL be subject to the resolved-address check.

#### Scenario: A callback host resolves to a non-public address

- **WHEN** the delivery worker is about to post an event to a subscription whose
  `callback_url` host resolves to a loopback, private, link-local, or cloud
  metadata address (for example `127.0.0.1` or `169.254.169.254`)
- **THEN** the worker SHALL NOT issue the HTTP request
- **AND** the worker SHALL record the attempt as a failed delivery with no status
  code and a descriptive error, following the existing retry/backoff/dead-letter
  path

#### Scenario: A callback host resolves to an IANA special-purpose range that a deny-list style implementation would miss

- **WHEN** the delivery worker is about to post an event to a subscription whose
  `callback_url` host resolves to an IANA special-purpose address that is not
  globally reachable but is not RFC 1918 private, loopback, or link-local
  space either (for example a TEST-NET address `192.0.2.1`/`198.51.100.1`/
  `203.0.113.1`, a benchmarking address `198.18.0.1`, the IPv4 6to4 relay
  anycast address `192.88.99.1`, or an IPv6 range added to the registry after
  a given third-party classification library's release, such as
  `64:ff9b:1::/48` local-use translation, `100:0:0:1::/64`, `3fff::/20`, or
  `5f00::/16`)
- **THEN** the worker SHALL NOT issue the HTTP request, because the address
  does not have `true` for "Globally Reachable" in the vendored registry
  snapshot — regardless of whether it appears on any specific
  historically-hand-maintained denied-range enumeration

#### Scenario: A callback host re-resolves to a non-public address after creation

- **WHEN** a subscription's `callback_url` passed create-time validation because
  its host resolved to a public address, but at a later delivery attempt the host
  resolves to a non-public address
- **THEN** the worker SHALL refuse that delivery attempt at send time rather than
  relying only on the create-time check

#### Scenario: A callback host resolves differently between the SSRF check and the connection

- **WHEN** the delivery worker validates a callback host's resolved address as
  public, and the host's DNS record could answer with a different (possibly
  non-public) address on a subsequent, independent resolution within the same
  delivery attempt
- **THEN** the worker SHALL connect only to the address that was validated,
  not perform a second, independent hostname resolution when opening the
  connection
- **AND** this property SHALL hold even though the two conditions are not
  separately observable from the worker's HTTP-level behavior (there is no
  intermediate state where a validated-but-not-yet-connected request exists) —
  it SHALL be true by construction, verified by asserting the literal address
  passed to the underlying socket connection equals the validated address

#### Scenario: A callback host resolves to a 6to4 address, regardless of the embedded payload

- **WHEN** a subscription's `callback_url` host resolves to an IPv6 6to4
  address (`2002::/16`), including one whose embedded IPv4 payload is itself
  a global-unicast address
- **THEN** the worker SHALL NOT issue the HTTP request, because 6to4 is denied
  outright per its own registry row rather than conditionally allowed based on
  the embedded IPv4 address

#### Scenario: A callback host resolves to more addresses than the bound

- **WHEN** a callback host's DNS answer returns more resolved addresses than
  `MAX_VALIDATED_ADDRESSES`
- **THEN** the worker SHALL NOT issue the HTTP request to any of the resolved
  addresses
- **AND** the worker SHALL treat this as a failed delivery attempt, following
  the existing retry/backoff/dead-letter path, rather than silently
  connecting using a truncated prefix of the DNS answer

#### Scenario: The connection factory itself enforces the address-count bound

- **WHEN** the connection factory that dials validated addresses
  (`createPinnedDispatcher` or `createPinnedHttpsAgent`) is given a list of
  addresses longer than `MAX_VALIDATED_ADDRESSES`
- **THEN** the factory SHALL attempt at most `MAX_VALIDATED_ADDRESSES` of
  those addresses, independent of whether the caller already bounded the list

#### Scenario: A connection attempt that reports success is not later re-reported as a failure

- **WHEN** a single connection attempt's underlying socket emits a success
  event (for example TLS `secureConnect`) and subsequently emits a failure
  event (for example a post-handshake `error`) on the same socket
- **THEN** the attempt's completion callback SHALL be invoked exactly once,
  reporting the first event's outcome
- **AND** the fallback sequence SHALL NOT be advanced by the later, discarded
  event

#### Scenario: A connection attempt that reports failure is not later re-reported as a success

- **WHEN** a single connection attempt's underlying socket emits a failure
  event and subsequently emits a success event on the same (already-failed)
  socket
- **THEN** the attempt's completion callback SHALL be invoked exactly once,
  reporting the failure, and the socket SHALL be destroyed
- **AND** a late success event on that same socket SHALL NOT resurrect it as
  a reported success

#### Scenario: A delivery response is a redirect

- **WHEN** a delivery request to a public callback host returns a 3xx redirect
- **THEN** the worker SHALL NOT follow the redirect to a new (possibly non-public)
  location

#### Scenario: A callback host resolves to a public address

- **WHEN** the delivery worker posts an event to a subscription whose
  `callback_url` host resolves only to global-unicast addresses, within the
  address-count bound
- **THEN** the worker SHALL issue the delivery request normally, unchanged from
  prior behavior

#### Scenario: A sanctioned local-development callback is delivered

- **WHEN** the delivery worker posts an event to a subscription whose
  `callback_url` is an `http://` URL with the literal host `localhost`,
  `127.0.0.1`, `[::1]`, or `::1` (the same exception create-time validation
  permits)
- **THEN** the worker SHALL issue the delivery request normally without blocking,
  so the local-development receiver path is preserved

### Requirement: Web Push notification delivery SHALL guard against SSRF via an owner-supplied endpoint

The reference Web Push sender SHALL, before dispatching a push notification to
a subscription's `endpoint`, resolve the endpoint host and refuse to send
unless every resolved network address is a global-unicast address, using the
same allow policy (`isGlobalUnicastAddress`), address-count bound
(`MAX_VALIDATED_ADDRESSES`), and send-time address binding requirement defined
above for client-event delivery. `endpoint` SHALL be treated as externally
influenced even though it requires an authenticated owner session to register
or trigger: an owner-authenticated confused-deputy SSRF is still an SSRF, and
the guard SHALL NOT be weakened or omitted on the basis of the higher trust
bar to reach it.

Because the underlying Web Push send is performed by a third-party library
(`web-push`) that issues its own `https.request` internally rather than
through a `fetch` call this reference implementation controls, send-time
address binding SHALL be achieved by constructing a `node:https.Agent`
pinned to the validated address(es) and passing it as that library's
documented `agent` option — the only integration point available without
reimplementing or forking VAPID header generation or payload encryption. This
guard SHALL NOT alter VAPID header construction, payload encryption, TTL, or
any other Web Push protocol behavior; it SHALL only constrain which literal
network address the underlying connection is permitted to dial. A blocked
send SHALL be treated as a failed notification delivery through the sender's
existing failure-handling path (marking the subscription's failure state,
consistent with any other send failure), not a crash.

A single Web Push send SHALL be bounded by an explicit, short wall-clock
timeout on the underlying `https.request` (`WEB_PUSH_SEND_TIMEOUT_MS` in
`server/web-push-notifications.js`, of the same order of magnitude as the
other two guarded callers' bounds), because the `web-push` library only
installs Node's socket-inactivity timeout when the caller supplies this
option — without it, an allowed endpoint that accepts a connection and then
hangs or blackholes it would otherwise leave the send pending indefinitely,
stranding the fanout that awaits it and never releasing the pinned connection
resource. On this timeout firing, the send SHALL be treated as a failed
delivery, and the pinned agent SHALL be released (destroyed) exactly as on
any other outcome.

This send-time binding, address-count bound, and timeout SHALL be forwarded
by the actual production sending function that every fanout call site invokes
(`defaultSendNotification`), not merely available as capability in helper
functions that the production code path could in principle bypass. The pinned
agent SHALL be released (destroyed) after the send completes, regardless of
whether the send succeeded, failed, or timed out.

#### Scenario: A Web Push endpoint resolves to a non-public address

- **WHEN** the reference is about to send a push notification to a subscription
  whose `endpoint` host resolves to a loopback, private, link-local, cloud
  metadata, or other non-global-unicast address
- **THEN** the reference SHALL NOT issue the underlying HTTPS request
- **AND** the send SHALL be recorded as a failed delivery through the existing
  Web Push failure-handling path

#### Scenario: A Web Push endpoint resolves to an IANA special-purpose range

- **WHEN** a subscription's `endpoint` host resolves to an IANA special-purpose
  address that is not globally reachable (for example a TEST-NET or
  benchmarking address)
- **THEN** the reference SHALL NOT issue the underlying HTTPS request, using
  the same global-unicast allow policy as client-event delivery and CIMD

#### Scenario: A Web Push endpoint resolves to a public address

- **WHEN** a subscription's `endpoint` host resolves only to global-unicast
  addresses, within the address-count bound
- **THEN** the reference SHALL send the push notification normally, with VAPID
  headers and encrypted payload unchanged from prior behavior, using a
  connection pinned to the validated address

#### Scenario: The validated and connected addresses for a Web Push send must be the same value

- **WHEN** the reference validates a Web Push endpoint host's resolved address
  as public
- **THEN** the underlying HTTPS connection SHALL be made to that literal
  validated address, not a second, independent resolution of the endpoint
  hostname performed by the `web-push` library or Node's `https` module

#### Scenario: An allowed Web Push endpoint hangs indefinitely

- **WHEN** a Web Push endpoint's host passes the global-unicast check and the
  underlying HTTPS connection is accepted but the endpoint never responds and
  never closes the connection
- **THEN** the send SHALL be bounded by the configured timeout rather than
  remaining pending indefinitely
- **AND** on timeout, the send SHALL be treated as a failed delivery and the
  pinned connection resource SHALL be released

#### Scenario: The production sending function forwards the guard's pinned agent and timeout

- **WHEN** the reference's actual production Web Push sending function
  (`defaultSendNotification`, the function every fanout call site invokes as
  `sender`) sends to an allowed endpoint
- **THEN** the exact pinned agent and the exact configured timeout SHALL be
  the options passed to the underlying `web-push` library call, verifiable by
  observing those options at that call, not merely by observing that a
  separate guard helper function produces a pinned agent when called in
  isolation

#### Scenario: The pinned agent is released after every send outcome

- **WHEN** the production sending function completes a send to an allowed
  endpoint, whether the send succeeded, failed, or timed out
- **THEN** the pinned connection resource for that send SHALL be released
  (destroyed) in every case

## MODIFIED Requirements

### Requirement: CIMD metadata fetch IP filtering SHALL reject mapped and non-public addresses

Before fetching an external CIMD metadata document, the reference SHALL
require every DNS-resolved address for the `client_id` host to be a
global-unicast address — an ALLOW policy, not a deny policy, using the same
`isGlobalUnicastAddress` classifier (driven by the vendored IANA registry
snapshot, not a third-party library's own classification), mapped/tunneled-
representation handling (including the 6to4-denied-outright and NAT64
local-use-denied-outright rules), address-count bound, and connector-level
cap enforcement defined in the client-event delivery requirement above,
rather than a parallel enumeration of denied ranges that could omit an IANA
special-purpose range (as a prior, deny-list-based implementation of this
requirement did).

The address validated against this policy SHALL be the same address the
metadata fetch connects to (send-time address binding). Resolving the
`client_id` host once to validate it and then issuing the fetch against the
original hostname is NOT sufficient: the HTTP client may perform its own,
independent resolution when opening the connection, and a hostname with a
low-TTL or attacker-controlled DNS record can resolve differently between the
validating lookup and the connection (DNS rebinding). The reference SHALL
therefore connect only to the literal address(es) that were validated for a
given fetch, not re-resolve the `client_id` hostname at connection time. This
guarantee SHALL use the same mechanism and the same shared implementation
(`server/ssrf-guard.js`) as client-event delivery's and Web Push's send-time
address binding, rather than a parallel implementation that could drift out
of sync.

#### Scenario: IPv4-mapped loopback is rejected
- **WHEN** CIMD DNS resolution returns `::ffff:127.0.0.1`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP.

#### Scenario: CGNAT and broadcast IPv4 are rejected
- **WHEN** CIMD DNS resolution returns `100.64.0.1` or `255.255.255.255`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP.

#### Scenario: An IANA special-purpose range not in the vendored allow policy is rejected

- **WHEN** CIMD DNS resolution returns an IANA special-purpose address that is
  not globally reachable but is not RFC 1918/loopback/link-local space either
  (for example `192.0.2.1`, `198.18.0.1`, `198.51.100.1`, `203.0.113.1`, or an
  IPv6 range added to the registry after a given third-party classification
  library's release)
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP,
  because the resolved address does not have `true` for "Globally Reachable"
  in the vendored registry snapshot

#### Scenario: A client_id host resolves to a 6to4 address, regardless of the embedded payload

- **WHEN** CIMD DNS resolution returns an IPv6 6to4 address (`2002::/16`), for
  example `2002:c000:0204::1` (which embeds the public-looking payload
  `192.0.2.4`, itself a TEST-NET-1 address, and either way is irrelevant to
  the outcome)
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP,
  because 6to4 is denied outright per its own registry row rather than
  conditionally allowed or rejected based on the embedded IPv4 payload

#### Scenario: A client_id host resolves to more addresses than the bound

- **WHEN** a `client_id` host's DNS answer returns more resolved addresses
  than `MAX_VALIDATED_ADDRESSES`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP
  to any of the resolved addresses, rather than proceeding with a truncated
  prefix of the DNS answer

#### Scenario: A client_id host resolves differently between the SSRF check and the connection

- **WHEN** the reference validates a `client_id` host's resolved address as
  public, and the host's DNS record could answer with a different (possibly
  non-public) address on a subsequent, independent resolution within the same
  fetch attempt
- **THEN** the reference SHALL connect only to the address that was validated,
  not perform a second, independent hostname resolution when opening the
  connection
- **AND** this property SHALL hold by construction, verified by asserting the
  literal address passed to the underlying socket connection equals the
  validated address
