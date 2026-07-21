/**
 * Vendored snapshot of the IANA IPv4 and IPv6 Special-Purpose Address
 * Registries, used as the policy authority for `isGlobalUnicastAddress` in
 * `ssrf-guard.js`.
 *
 * This is a DATED SNAPSHOT, not a live feed. It proves that every address in
 * either registry as of `SNAPSHOT_DATE` is correctly classified — it does
 * NOT prove that a range IANA allocates after that date will be denied. See
 * openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md
 * for the full raw registry CSVs this file was transcribed from, the
 * derivation rules applied (in particular: why 6to4 is denied outright
 * rather than conditionally on its embedded IPv4), and the update procedure.
 *
 * Primary sources (re-fetch these, not a mirror, when updating):
 *   https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
 *   https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
 */

export const SNAPSHOT_DATE = '2026-07-18';
export const IPV4_REGISTRY_SOURCE_URL =
  'https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv';
export const IPV6_REGISTRY_SOURCE_URL =
  'https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv';

/**
 * Each row: [cidr, globallyReachable, name]. `globallyReachable` is the
 * registry's own "Globally Reachable" column value for that row, taken
 * verbatim: `true`, `false`, or `null` for `N/A` — deprecated/terminated
 * rows (blank cells in the source CSV) are recorded as `false` (denied).
 * A row is DENIED by this guard when `globallyReachable !== true`.
 */
export const IPV4_SPECIAL_PURPOSE_ROWS = [
  ['0.0.0.0/8', false, '"This network"'],
  ['0.0.0.0/32', false, '"This host on this network"'],
  ['10.0.0.0/8', false, 'Private-Use'],
  ['100.64.0.0/10', false, 'Shared Address Space'],
  ['127.0.0.0/8', false, 'Loopback'],
  ['169.254.0.0/16', false, 'Link Local'],
  ['172.16.0.0/12', false, 'Private-Use'],
  ['192.0.0.0/24', false, 'IETF Protocol Assignments'],
  ['192.0.0.0/29', false, 'IPv4 Service Continuity Prefix'],
  ['192.0.0.8/32', false, 'IPv4 dummy address'],
  ['192.0.0.9/32', true, 'Port Control Protocol Anycast'],
  ['192.0.0.10/32', true, 'Traversal Using Relays around NAT Anycast'],
  ['192.0.0.170/32', false, 'NAT64/DNS64 Discovery'],
  ['192.0.0.171/32', false, 'NAT64/DNS64 Discovery'],
  ['192.0.2.0/24', false, 'Documentation (TEST-NET-1)'],
  ['192.31.196.0/24', true, 'AS112-v4'],
  ['192.52.193.0/24', true, 'AMT'],
  // Deprecated 2015-03; the source CSV leaves Globally Reachable blank for
  // terminated rows — treated as denied.
  ['192.88.99.0/24', false, 'Deprecated (6to4 Relay Anycast)'],
  ['192.88.99.2/32', false, '6a44-relay anycast address'],
  ['192.168.0.0/16', false, 'Private-Use'],
  ['192.175.48.0/24', true, 'Direct Delegation AS112 Service'],
  ['198.18.0.0/15', false, 'Benchmarking'],
  ['198.51.100.0/24', false, 'Documentation (TEST-NET-2)'],
  ['203.0.113.0/24', false, 'Documentation (TEST-NET-3)'],
  ['240.0.0.0/4', false, 'Reserved'],
  ['255.255.255.255/32', false, 'Limited Broadcast'],
  // Multicast is governed by a separate IANA registry (RFC 5771), not the
  // special-purpose registry, but is denied unconditionally: multicast
  // addresses are categorically not unicast destinations.
  ['224.0.0.0/4', false, 'Multicast'],
];

export const IPV6_SPECIAL_PURPOSE_ROWS = [
  ['::1/128', false, 'Loopback Address'],
  ['::/128', false, 'Unspecified Address'],
  ['::ffff:0:0/96', false, 'IPv4-mapped Address'],
  ['64:ff9b::/96', true, 'IPv4-IPv6 Translation (global-use, RFC 6052)'],
  ['64:ff9b:1::/48', false, 'IPv4-IPv6 Translation (local-use, RFC 8215)'],
  ['100::/64', false, 'Discard-Only Address Block'],
  ['100:0:0:1::/64', false, 'Dummy IPv6 Prefix'],
  ['2001::/23', false, 'IETF Protocol Assignments'],
  // 6to4's own Globally Reachable value is N/A (a transport mechanism, not a
  // reachability guarantee) — denied outright per the derivation rule; see
  // the research doc. Deliberately NOT conditionally allowed based on the
  // embedded IPv4 payload (that was the prior revision's mistake).
  ['2001::/32', false, 'TEREDO'],
  ['2001:1::1/128', true, 'Port Control Protocol Anycast'],
  ['2001:1::2/128', true, 'Traversal Using Relays around NAT Anycast'],
  ['2001:1::3/128', true, 'DNS-SD Service Registration Protocol Anycast'],
  ['2001:2::/48', false, 'Benchmarking'],
  ['2001:3::/32', true, 'AMT'],
  ['2001:4:112::/48', true, 'AS112-v6'],
  // Deprecated 2014-03; blank Globally Reachable in the source CSV.
  ['2001:10::/28', false, 'Deprecated (previously ORCHID)'],
  ['2001:20::/28', true, 'ORCHIDv2'],
  ['2001:30::/28', true, 'Drone Remote ID Protocol Entity Tags (DETs) Prefix'],
  ['2001:db8::/32', false, 'Documentation'],
  ['2002::/16', false, '6to4 (Globally Reachable: N/A — denied outright)'],
  ['2620:4f:8000::/48', true, 'Direct Delegation AS112 Service'],
  ['3fff::/20', false, 'Documentation'],
  ['5f00::/16', false, 'Segment Routing (SRv6) SIDs'],
  ['fc00::/7', false, 'Unique-Local'],
  ['fe80::/10', false, 'Link-Local Unicast'],
  // Multicast is governed by RFC 4291 / a separate registry, denied
  // unconditionally, same rationale as IPv4.
  ['ff00::/8', false, 'Multicast'],
];
