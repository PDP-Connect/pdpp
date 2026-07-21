# IANA IPv4/IPv6 Special-Purpose Address Registries — snapshot and policy derivation

**Access date:** 2026-07-18.
**Fetch method:** `curl -sL <url> -o <file>` against the primary-source CSV download links published on each registry's own IANA page (not a summarization by an AI model or a third-party mirror). Raw output stored verbatim below and vendored as executable data at `reference-implementation/server/iana-special-purpose-registry.js`.

## Primary sources

- IPv4 Special-Purpose Address Registry (HTML): https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml
- IPv4 Special-Purpose Address Registry (CSV, the exact source vendored below): https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
- IPv6 Special-Purpose Address Registry (HTML): https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml
- IPv6 Special-Purpose Address Registry (CSV, the exact source vendored below): https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv

## Why this exists

The prior revision of `fix-client-event-delivery-ssrf-guard` (commit `dfde1ded0`) built its
global-unicast allow policy on `ipaddr.js@2.3.0`'s hardcoded `range()` classifier, treating
`range() === 'unicast'` as if it were affirmative registry evidence. It is not: in `ipaddr.js`,
`'unicast'` is the *default fallthrough* for any address that does not match one of the library's
own hardcoded `SpecialRanges` entries — which are themselves a snapshot of the IANA registries at
whatever point `ipaddr.js` was last updated, not a live or even a recently-refreshed one.

An independent security review (GPT-5.6 Sol, `tmp/workstreams/ssrf-sol-final-0717.md`) proved this
empirically: `ipaddr.js@2.3.0` does not know about several rows the *current* (2026-07-18) IANA
IPv6 registry lists as not globally reachable, because those rows were added to the registry after
`ipaddr.js@2.3.0` shipped:

- `64:ff9b:1::/48` — IPv4-IPv6 Translation, local-use (RFC 8215, added 2017-06). `ipaddr.js` only
  knows the older `64:ff9b::/96` global-use translation prefix (RFC 6052) and defaults everything
  under `64:ff9b:1::/48` to `unicast`. Reproduced: `64:ff9b:1::7f00:1` (embedding IPv4 loopback
  `127.0.0.1`) classified `unicast` by `ipaddr.js`.
- `100:0:0:1::/64` — Dummy IPv6 Prefix (RFC 9780, added 2025-04, newer than `ipaddr.js@2.3.0`).
- `3fff::/20` — Documentation (RFC 9637, added 2024-07).
- `5f00::/16` — Segment Routing (SRv6) SIDs (RFC 9602, added 2024-04).

This is a structural problem with treating any single third-party library's snapshot as the policy
authority without a documented update mechanism: the registry changes over time (four new rows in
the last two years alone, as shown above), and a library dependency updates on its own release
cadence, not the registry's. The fix is not "find a better library" — it is to make the policy
source an explicit, reviewable, dated snapshot of the actual registry, checked into this repository
where its staleness is visible and testable, with a documented update procedure.

## Full registry snapshots (raw CSV, as fetched 2026-07-18)

### IPv4 Special-Purpose Address Registry

```csv
Address Block,Name,RFC,Allocation Date,Termination Date,Source,Destination,Forwardable,Globally Reachable,Reserved-by-Protocol
0.0.0.0/8,"""This network""","[RFC791], Section 3.2",1981-09,N/A,True,False,False,False,True
0.0.0.0/32,"""This host on this network""","[RFC1122], Section 3.2.1.3",1981-09,N/A,True,False,False,False,True
10.0.0.0/8,Private-Use,[RFC1918],1996-02,N/A,True,True,True,False,False
100.64.0.0/10,Shared Address Space,[RFC6598],2012-04,N/A,True,True,True,False,False
127.0.0.0/8,Loopback,"[RFC1122], Section 3.2.1.3",1981-09,N/A,False [1],False [1],False [1],False [1],True
169.254.0.0/16,Link Local,[RFC3927],2005-05,N/A,True,True,False,False,True
172.16.0.0/12,Private-Use,[RFC1918],1996-02,N/A,True,True,True,False,False
192.0.0.0/24 [2],IETF Protocol Assignments,"[RFC6890], Section 2.1",2010-01,N/A,False,False,False,False,False
192.0.0.0/29,IPv4 Service Continuity Prefix,[RFC7335],2011-06,N/A,True,True,True,False,False
192.0.0.8/32,IPv4 dummy address,[RFC7600],2015-03,N/A,True,False,False,False,False
192.0.0.9/32,Port Control Protocol Anycast,[RFC7723],2015-10,N/A,True,True,True,True,False
192.0.0.10/32,Traversal Using Relays around NAT Anycast,[RFC8155],2017-02,N/A,True,True,True,True,False
"192.0.0.170/32, 192.0.0.171/32",NAT64/DNS64 Discovery,"[RFC8880][RFC7050], Section 2.2",2013-02,N/A,False,False,False,False,True
192.0.2.0/24,Documentation (TEST-NET-1),[RFC5737],2010-01,N/A,False,False,False,False,False
192.31.196.0/24,AS112-v4,[RFC7535],2014-12,N/A,True,True,True,True,False
192.52.193.0/24,AMT,[RFC7450],2014-12,N/A,True,True,True,True,False
192.88.99.0/24,Deprecated (6to4 Relay Anycast),[RFC7526],2001-06,2015-03,,,,,
192.88.99.2/32,6a44-relay anycast address,[RFC6751],2012-10,N/A,True,True,True,False,False
192.168.0.0/16,Private-Use,[RFC1918],1996-02,N/A,True,True,True,False,False
192.175.48.0/24,Direct Delegation AS112 Service,[RFC7534],1996-01,N/A,True,True,True,True,False
198.18.0.0/15,Benchmarking,[RFC2544],1999-03,N/A,True,True,True,False,False
198.51.100.0/24,Documentation (TEST-NET-2),[RFC5737],2010-01,N/A,False,False,False,False,False
203.0.113.0/24,Documentation (TEST-NET-3),[RFC5737],2010-01,N/A,False,False,False,False,False
240.0.0.0/4,Reserved,"[RFC1112], Section 4",1989-08,N/A,False,False,False,False,True
255.255.255.255/32,Limited Broadcast,"[RFC8190]
        [RFC919], Section 7",1984-10,N/A,False,True,False,False,True
```

### IPv6 Special-Purpose Address Registry

```csv
Address Block,Name,RFC,Allocation Date,Termination Date,Source,Destination,Forwardable,Globally Reachable,Reserved-by-Protocol
::1/128,Loopback Address,[RFC4291],2006-02,N/A,False,False,False,False,True
::/128,Unspecified Address,[RFC4291],2006-02,N/A,True,False,False,False,True
::ffff:0:0/96,IPv4-mapped Address,[RFC4291],2006-02,N/A,False,False,False,False,True
64:ff9b::/96,IPv4-IPv6 Translat.,[RFC6052],2010-10,N/A,True,True,True,True,False
64:ff9b:1::/48,IPv4-IPv6 Translat.,[RFC8215],2017-06,N/A,True,True,True,False,False
100::/64,Discard-Only Address Block,[RFC6666],2012-06,N/A,True,True,True,False,False
100:0:0:1::/64,Dummy IPv6 Prefix,[RFC9780],2025-04,N/A,True,False,False,False,False
2001::/23,IETF Protocol Assignments,[RFC2928],2000-09,N/A,False [1],False [1],False [1],False [1],False
2001::/32,TEREDO,"[RFC4380]
        [RFC8190]",2006-01,N/A,True,True,True,N/A [2],False
2001:1::1/128,Port Control Protocol Anycast,[RFC7723],2015-10,N/A,True,True,True,True,False
2001:1::2/128,Traversal Using Relays around NAT Anycast,[RFC8155],2017-02,N/A,True,True,True,True,False
2001:1::3/128,DNS-SD Service Registration Protocol Anycast,[RFC9665],2024-04,N/A,True,True,True,True,False
2001:2::/48,Benchmarking,[RFC5180][RFC Errata 1752],2008-04,N/A,True,True,True,False,False
2001:3::/32,AMT,[RFC7450],2014-12,N/A,True,True,True,True,False
2001:4:112::/48,AS112-v6,[RFC7535],2014-12,N/A,True,True,True,True,False
2001:10::/28,Deprecated (previously ORCHID),[RFC4843],2007-03,2014-03,,,,,
2001:20::/28,ORCHIDv2,[RFC7343],2014-07,N/A,True,True,True,True,False
2001:30::/28,Drone Remote ID Protocol Entity Tags (DETs) Prefix,[RFC9374],2022-12,N/A,True,True,True,True,False
2001:db8::/32,Documentation,[RFC3849],2004-07,N/A,False,False,False,False,False
2002::/16 [3],6to4,[RFC3056],2001-02,N/A,True,True,True,N/A [3],False
2620:4f:8000::/48,Direct Delegation AS112 Service,[RFC7534],2011-05,N/A,True,True,True,True,False
3fff::/20,Documentation,[RFC9637],2024-07,N/A,False,False,False,False,False
5f00::/16,Segment Routing (SRv6) SIDs,[RFC9602],2024-04,N/A,True,True,True,False,False
fc00::/7,Unique-Local,"[RFC4193]
        [RFC8190]",2005-10,N/A,True,True,True,False [4],False
fe80::/10,Link-Local Unicast,[RFC4291],2006-02,N/A,True,True,False,False,True
```

## Policy derivation: what "deny" means for this SSRF guard

The registry's `Globally Reachable` column is the direct authority for whether a block should be
treated as denied by `isGlobalUnicastAddress`. The derivation rule applied when generating
`server/iana-special-purpose-registry.js`:

- A row with `Globally Reachable: True` is NOT denied by this registry (it may still be an
  anycast/protocol-assignment address rather than a normal host, but it is registry-affirmed
  reachable and this guard does not further distinguish reachability from "is this a sane webhook
  destination" — that is out of scope for an SSRF address-reachability check).
- A row with `Globally Reachable: False`, `N/A`, or blank (deprecated/terminated rows have blank
  cells) IS denied.
- **6to4 (`2002::/16`) is `Globally Reachable: N/A`, not `True`.** The registry does not affirm
  global reachability for 6to4 space itself — 6to4 is a *transport mechanism*, and whether a given
  6to4 address is reachable depends on relay availability, which the registry does not and cannot
  encode. This guard therefore denies `2002::/16` outright, unconditionally, regardless of the
  embedded IPv4 payload. This is a deliberate behavior change from the prior revision, which
  recursively allowed 6to4 addresses whose embedded IPv4 was itself public — that treated `N/A` as
  equivalent to `True`, which it is not.
- **NAT64 (`64:ff9b::/96`, global-use) is `Globally Reachable: True`.** This block is genuinely
  registry-affirmed reachable, so `isGlobalUnicastAddress` unwraps its embedded IPv4 (the standard
  NAT64 translation payload) and recurses — an embedded public IPv4 is allowed, an embedded
  non-public IPv4 is denied. This preserves the deliberate distinction the registry itself makes
  between `64:ff9b::/96` (global, `True`) and `64:ff9b:1::/48` (local-use, `False`) — the latter is
  denied outright as a normal special-purpose row match, with no embedded-address unwrapping (its
  own reachability is already `False`).
- **Multicast** (`224.0.0.0/4` IPv4 per RFC 5771, `ff00::/8` IPv6 per RFC 4291) is not in the
  special-purpose registry at all — it is governed by the separate IPv4/IPv6 Multicast Address
  Space registries — but is denied unconditionally and independently of both registry tables,
  because multicast addresses are categorically not unicast destinations by definition, not merely
  by IANA special-purpose classification. Verified against
  https://www.iana.org/assignments/ipv4-address-space/ipv4-address-space.xhtml
  (accessed 2026-07-18): `224/8`–`239/8` are documented as "Multicast (formerly 'Class D')" under
  RFC 5771.
- **IPv4-mapped IPv6** (`::ffff:0:0/96`) is `Globally Reachable: False` in its own right, but this
  guard's actual behavior is to unwrap the embedded IPv4 and recurse — an IPv4-mapped address whose
  embedded IPv4 is itself global-unicast (e.g. `::ffff:8.8.8.8`) is allowed, matching how these
  addresses are actually used on the wire (as a dual-stack representation of an IPv4 destination,
  not as a distinct IPv6 destination).

## Verification: this snapshot closes every address Sol reproduced

```
64:ff9b:1::808:808   → denied  (64:ff9b:1::/48 row, Globally Reachable: False)
64:ff9b:1::7f00:1    → denied  (same row; also embeds loopback, doubly denied)
100:0:0:1::1         → denied  (100:0:0:1::/64 row, Globally Reachable: False)
2002:0808:0808::1    → denied  (2002::/16 row, Globally Reachable: N/A — denied outright,
                                 no longer conditionally allowed via embedded-IPv4 recursion)
3fff::1              → denied  (3fff::/20 row, Globally Reachable: False)
5f00::1              → denied  (5f00::/16 row, Globally Reachable: False)
```

All six addresses from Sol's reproduction are denied under this snapshot. See
`reference-implementation/test/ssrf-guard.test.js` for the executable, table-driven assertion of
this and every other registry row.

## Update mechanism (documented per Sol's requirement — do not claim future allocations are closed by construction)

This is a **dated snapshot**, not a live feed. `server/iana-special-purpose-registry.js` embeds the
access date (`SNAPSHOT_DATE = '2026-07-18'`) and the two source URLs above as executable constants,
so staleness is visible at the call site, not just in this document.

**What this snapshot proves:** every address that was in either registry as of 2026-07-18 is
correctly classified by `isGlobalUnicastAddress`, verified by the table-driven test suite against
every row of both registries plus multicast (defined separately) plus every mapped/tunneled
representation.

**What this snapshot does NOT prove:** that a special-purpose range IANA allocates *after*
2026-07-18 will be denied. It will not be, until this file is regenerated. This is the same
limitation any allow-list-of-explicit-ranges has — the previous revision's claim that an allow-list
closes future allocations "by construction" was itself imprecise (an *unbounded* allow policy like
"deny everything except a maintained affirmatively-reachable list" is closed by construction; a
policy built by copying rows out of a registry snapshot is not, unless the snapshot itself is kept
current).

**To update this snapshot:**
1. Re-fetch both CSVs from the primary-source URLs above.
2. Diff against the CSV blocks embedded in this document; note every added/changed/removed row.
3. Regenerate `server/iana-special-purpose-registry.js`'s `IPV4_SPECIAL_PURPOSE_ROWS` /
   `IPV6_SPECIAL_PURPOSE_ROWS` arrays from the new CSVs (mechanical transcription — each row's
   `Address Block` and `Globally Reachable` value; termination-dated/deprecated rows with blank
   `Globally Reachable` cells are treated as denied).
4. Update `SNAPSHOT_DATE` and this document's access date and CSV blocks together, in the same
   change.
5. Add a table-driven test case for any newly added row before merging the update.
6. This document (not just the code comments) is the durable record of what was checked, when, and
   why — do not let it drift from the vendored data file.
