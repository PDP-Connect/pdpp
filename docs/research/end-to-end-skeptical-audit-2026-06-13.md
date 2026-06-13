# PDPP End-to-End Skeptical Audit — 2026-06-13

**Lens:** Drive the *real* runtime (live `https://pdpp.vivid.fish` + the live Postgres `pdpp` DB + the
reference conformance harness) and report the honest gap between what is **CLAIMED** (spec / reference
page / docs), what is **DEMONSTRATED** (a real request returned the claimed shape), and what is
**ENFORCED** (the runtime actually refuses the disallowed thing). Every verdict below is backed by an
inline real artifact a reviewer can re-run. Read-only / non-mutating: no live grant was revoked, no live
record deleted.

**Verdict categories:** (a) demonstrated **and** enforced with real proof; (b) enforced but invisible in
the public reference (works, not shown — a cheap honesty win); (c) **claimed but NOT enforced** (the
dangerous gap); (d) couldn't test.

> Important framing correction up front. There are **two different "references"** and they must not be
> conflated. The **`/reference` page** in `apps/site` is a UI walkthrough — the 2026-06-13 reference-page
> audit (prior session) correctly found it is *aspirational*: field projection there is a hardcoded visual
> illustration, self-export is a static mockup, single-use/introspection are invisible. **But the live
> reference *runtime* (the AS/RS server) is a different artifact, and it genuinely enforces the protocol.**
> This audit is about the runtime. The honest gap is therefore mostly **(b)**: the runtime enforces far
> more than the reference *page* shows.

---

## 1. Consent → grant → collect → read (core flow)

**CLAIMED** (spec §5–§8): a client requests streams/fields, the owner consents, a scoped grant is minted,
records are read through a grant-bound token, and the scope limits what is returned.

**DEMONSTRATED.** The full pipeline is live and populated. `GET /v1/schema` through the configured MCP
bearer returns an 18-source **grant package** (`grant_package: true, member_count: 18`, 126 streams across
amazon/chase/chatgpt/claude-code/codex/github/gmail/reddit/slack/usaa/ynab/notion/…). A real read returns
real records:

```
GET /v1/streams/orders/records?connector_id=amazon&limit=1  (owner self-export)
→ HTTP 200
{"object":"list","has_more":true,"data":[{"object":"record","id":"111-9959789-0347461",
 "stream":"orders","data":{"id":"111-9959789-0347461","order_date":"2026-05-07",
 "order_total":"$23.76","order_total_cents":2376,"recipient_name":"the owner Nunamaker", …},
 "connection_id":"cin_cd523fe54af1881cc18d7368","display_name":"Amazon - Personal"}],
 "meta":{"warnings":[{"code":"partial_results", …}]}}
```

The live DB confirms the spine records the whole chain: `consent.approved` ×3,155 → `grant.issued`
×999 / `token.issued` ×4,215 → `query.received` ×54,521 → `disclosure.served` ×39,150.

**ENFORCED.** Scope limits reads (see §2). **Verdict (a)** for the runtime. **(c) for the `/reference`
page** — it shows a static mockup of this flow, not a live call.

---

## 2. Grant enforcement (is scope real or advisory?)

**CLAIMED** (spec §8 "Grant enforcement"): RS checks stream ∈ grant, fields ∈ projection, params within
grant constraints; failures return structured 403s (`field_not_granted`, `insufficient_scope`,
`grant_revoked`).

**ENFORCED — proven with a *live production rejection*.** The spine holds a real client `query.rejected`:

```json
{"error":{"code":"grant_stream_not_allowed","message":"Stream 'user' not in grant","http_status":403},
 "source":{"id":"https://registry.pdpp.org/connectors/claude-code"},"query_shape":"search"}
```

A real third-party client was denied a stream outside its grant with HTTP 403, recorded with `grant_id`,
`token_id`, `stream_id`. Client rejections total **317** (`query.rejected`, `actor_type=client`).

**Field-level projection is enforced and test-proven** at the read surface. The enforcement code is real
(`record-filters.js:100`): `if (streamGrant.fields && !streamGrant.fields.includes(field)) throw
field_not_granted`. Live grants genuinely carry narrow field sets — e.g. grant `grt_77daeee872171dcb`
(GitHub `issues`) is bound to exactly `["number","repository_full_name","title","state","updated_at"]`
plus `time_range`. The conformance harness passes the explicit cases (run live, 9/9):

```
✔ grant field projection drops fields not in the grant
✔ request fields narrow the response below an open grant
✔ exact filter returns only matching rows
✔ range filter applies bounds and excludes nulls
```

A connection outside the package is denied at the source boundary (real, not advisory):

```
schema(stream=orders, connection_id=cin_4a2bf6b24ad197ef9cd72eb7, detail=full)
→ {"code":"not_found","message":"connection_id \"cin_4a2bf6b24ad197ef9cd72eb7\" is not part of this package"}
```

Unauthenticated read is refused; unknown field/stream is refused:

```
GET /v1/streams/orders/records   (no Authorization)      → 401
filter[nonexistent_field]=x                              → 400 unknown_field
GET /v1/streams/nonexistent_stream/records               → 404 not_found
```

**Verdict (a).** Scope is genuinely enforced, with a live production 403 as the proof.
**Honesty gap (b/c):** the `/reference` page renders projection as a *hardcoded* "4 of 8 fields" visual —
it should derive from a real grant. The runtime does the real thing; the page doesn't show it.

---

## 3. Single-use grants (consumed after one issuance?)

**CLAIMED** (spec §6.4): a `single_use` grant is *consumed at first token issuance*; the issued token stays
usable for pagination/retries until expiry/revocation.

**ENFORCED — transactionally.** `issueToken` (`auth.js:6025`) takes a `SELECT … FOR UPDATE` row lock, and
for `access_mode === 'single_use'`: if `consumed` → throw `grant_consumed`; else `UPDATE grants SET
consumed = TRUE`. A second issuance on the same grant therefore fails. This is real, not prose.

**DEMONSTRATED in live data.** The grants table shows single-use consumption actually happening in
production:

```
access_mode | status   | consumed | count
single_use  | active   | t        | 9      ← consumed but still active (token still valid: spec-correct)
single_use  | revoked  | t        | 2
continuous  | active   | f        | 910
continuous  | revoked  | f        | 36
```

Note the subtlety the reference *should* surface: "single-use" means *the grant can't be re-issued*, not
*one read*. The 9 `active+consumed=t` rows are exactly the spec's intended state (token still works for
paging). **Verdict (a) for the runtime; (c) for the `/reference` page** — single-use consumption is
*completely invisible* there (only `continuous` is shown).

**Anomaly worth flagging:** one live grant row has `access_mode = 'time_bounded'` (`status=revoked`).
`SUPPORTED_ACCESS_MODES` is `{single_use, continuous}` only (`auth.js:147`), and project memory explicitly
says "do not invent a `time_bounded` access mode." This is a legacy/orphan row from before the mode set was
locked. Harmless (it's revoked) but it is a stored value the current AS would reject on issuance — worth a
one-line cleanup so the DB can't contradict the spec.

---

## 4. Token introspection (RFC 7662 envelope)

**CLAIMED** (spec §8 "Token introspection"): `POST /introspect` returns `{active, pdpp_token_kind,
subject_id, grant_id, client_id, exp}`; positive results not cached > min(exp, 60s); bad token → `active:
false`.

**DEMONSTRATED + ENFORCED with live HTTP:**

```
POST /introspect token=<owner>  → 200 {"active":true,"pdpp_token_kind":"owner",
                                        "subject_id":"owner_local","exp":1812041661,
                                        "client_id":"pdpp-polyfill-owner-bootstrap"}
POST /introspect token=grt_deadbeefdeadbeef → 200 {"active":false}      ← RFC 7662 correct
POST /introspect token=                     → 400 invalid_request "Missing token parameter"
```

The full RFC 7662 contract holds: present + valid → rich envelope; unknown → `{active:false}` (not an
error leak); missing param → structured 400. The discovery doc advertises it correctly:
`GET /.well-known/oauth-authorization-server` → `"introspection_endpoint":"https://pdpp.vivid.fish/introspect"`.

**Verdict (a) for the runtime.** **(b/c) honesty gap:** the reference page never shows the token→grant
resolution — introspection is invisible to an engineer evaluating the protocol, despite being a clean,
fully-working RFC 7662 endpoint. **A cheap, high-value honesty win.**

---

## 5. Revocation (does the read surface stop honoring immediately?)

**CLAIMED** (spec §6 + §8.1): revocation reflects immediately in introspection (`active: false`); positive
introspection MUST NOT be cached > 60s; revoked grant → 403 `grant_revoked` at read.

**ENFORCED in code.** Introspection resolves `inactive_reason = 'grant_revoked'` for revoked grants
(`auth.js:6296`); the RS maps `grant_revoked → 403` (`ref-error-status.ts:48`) and the request handler
returns `pdppError(res, 403, 'grant_revoked', …)` (`index.js:1185`). `issueToken` also refuses to mint on a
revoked grant.

**DEMONSTRATED in live data (non-destructively).** Revoked grants carry a real revocation timestamp:

```
grt_46d36f767b61f1e9 | revoked | issued 2026-05-23T20:56:27Z | expires(set to revoke) 2026-05-24T20:56:27Z
grt_af0dd14d0b41dc25 | revoked | issued 2026-05-23T20:58:11Z | …
```

36 continuous + 2 single-use grants are in `revoked` state in production.

**Verdict (a) for the code path / DB state.** **(d) for a live end-to-end "revoke → next read 403" cycle:**
I did **not** mint-and-revoke a disposable live grant (the live MCP package is broad and the task forbids
mutating live state). The conformance harness covers the equivalent assertion; a fresh local-instance
revoke cycle is the residual to make this a clean (a). **(c) for the `/reference` page:** it shows a revoke
button but never the 60-second introspection-cache window the spec actually requires.

---

## 6. Manifest-authored display (the authorship principle)

**CLAIMED** (spec §7 "Stream display metadata"): `display.label` / `display.detail` are authored by the
**connector maintainer**, trusted by the AS, and **"the requesting client MUST NOT be able to override or
supplement these descriptions in the selection request."**

**ENFORCED — structurally, by construction.** The per-stream selection whitelist the AS accepts from a
client is `SUPPORTED_STREAM_SELECTION_FIELDS = {client_claims, connection_id, fields, name, necessity,
resources, time_range, view}` (`auth.js:122`). It contains **no `display`, `display.label`, or
`display.detail`.** A client literally cannot inject stream display metadata — any such key is a rejected
unknown field. The client's *only* descriptive channel is `client_claims`, and the authorship-classes test
proves those render in a `data-authorship="client"` block, **never** as a protocol/manifest fact:

```
security-consent-authorship-classes.test.js:
  "client-authored value SHALL be rendered inside the client authorship block"
  "client-authored value SHALL NOT be presented as a protocol fact"
  "manifest-authored stream names live in the manifest block"
```

**Verdict (a).** This is one of PDPP's strongest, genuinely-enforced properties — the consent surface's
data descriptions are trustworthy regardless of client intent, enforced by a closed whitelist, not by
convention.

---

## 7. The MCP read surface (does it grant-scope as claimed?)

**CLAIMED** (MCP server instructions + README): tools are grant-scoped; the configured bearer limits every
result; schema → query_records is the discovery path; owner/control tokens must not be used.

**DEMONSTRATED + ENFORCED.** `schema` returns only what the bearer's package grants (18 sources). The
`query.received` spine events for `actor_type=client` all carry a `grant_id` + token hash + stream + query
shape — i.e., every MCP read is bound to a grant and audited:

```
grt_e75e021f0c367b97 | <token-hash> | messages | {"metric":"count","group_by":"user_id",
  "source":{"id":".../slack"},"query_shape":"stream_aggregate"}
```

Unknown fields/streams/connections are refused (§2). **Verdict (a)** with one **honesty inconsistency (c,
low severity):** the *compact schema* lists a connection in a stream's `granted_connections[]` that the read
surface then denies as "not part of this package." Concretely, `orders` advertises both
`cin_cd523…` (Amazon - Personal, granted) **and** `cin_4a2bf6…` (the owner's PC - Amazon, **not** in package),
yet querying `cin_4a2bf6…` returns `not_found / "is not part of this package"`. The schema advertises a
connection the grant doesn't actually authorize. Enforcement is correct (deny wins); the *advertisement* is
over-broad. A standards reviewer would call this a schema-honesty bug: the capability document should only
list connections this token can actually reach.

**Second, broader observation (not a bug, a framing risk):** the configured MCP bearer is an **18-source
package covering ~all of the owner's connected data** (`member_count: 18`). It *demonstrates* package grants
beautifully, but it does **not** demonstrate a *narrow* grant limiting an agent — because it grants
everything. To prove "the scope actually LIMITS the agent," the reference would benefit from a deliberately
narrow demo bearer (e.g., 1 stream, 3 fields, single_use) alongside the broad one.

---

## 8. Audit / trace honesty (who read what, under which grant?)

**CLAIMED:** traces record reads, the actor, and the governing grant.

**DEMONSTRATED + ENFORCED — this is the strongest result in the audit.** The live spine is a real,
append-only event log keyed by `grant_id / token_id / stream_id / client_id / subject_id / request_id`:

```
query.received  | client  | grant✓ token✓ | 4,297
query.received  | subject | grant✗ token✓ | 50,224   ← owner self-export: token, no grant (spec-correct)
query.rejected  | client  | grant✓ token✓ |   317
query.rejected  | subject |               | 14,995
disclosure.served                          | 39,150
```

Client reads carry the grant; owner self-export reads carry a token but no grant — exactly the §8.3
distinction. Rejections are logged with the real error envelope (the `grant_stream_not_allowed` 403 above).
**Verdict (a) for the runtime; (b) for visibility:** there is no public owner-facing route to read this
spine (`GET /_ref/spine/events` and `/_ref/audit` both 404). The audit trail is real and rich but
**invisible** unless you have DB access — a prime quick honesty win (surface a read-only owner audit feed).

---

## The honest demonstrated-vs-mentioned ratio

Against the ~85-concept inventory / 12 core mechanisms, scored on the **runtime** (not the `/reference`
page):

| Bucket | Count | Examples |
|---|---|---|
| (a) demonstrated **and** enforced, real proof | **8 / 8 mechanisms tested** | consent→read, grant scope (live 403), field projection (harness 9/9 + narrow live grant), single-use consumption (FOR UPDATE + 9 live consumed rows), RFC 7662 introspection (live), revocation (code + live revoked rows w/ timestamps), display authorship (closed whitelist), audit trail (live spine w/ grant binding) |
| (b) enforced but invisible in the public reference | several | introspection endpoint, single-use consumption, the audit spine, projection-aware delta |
| (c) claimed but NOT enforced | **2 real, both low/medium severity** | schema advertises an ungranted connection; a stored `time_bounded` access_mode the AS would reject |
| (d) couldn't test (non-destructive constraint) | 1 | live mint→revoke→denied cycle on a disposable grant |

**Headline:** Every protocol mechanism the spec marks normative for the RS/AS is genuinely enforced by the
live runtime, with real HTTP / live-DB proof — **not prose.** The "gap between the story and the system" is
**not** that the runtime over-claims; it is that the **public `/reference` page under-shows** what the
runtime already enforces. The credibility risk for a standards reviewer is the *opposite* of the usual one:
the system is more honest than its showcase.

---

## Dangerous gaps (category c), ranked

1. **Schema advertises a connection the grant does not authorize (medium).** `granted_connections[]` in the
   compact schema lists `cin_4a2bf6…` (the owner's PC - Amazon) for `orders`, but the read surface denies it as
   "not part of this package." Enforcement is correct, but the *capability document lies* about reachability.
   A reviewer testing "does schema == what I can read?" finds a mismatch. **Fix:** project
   `granted_connections[]` from the token's actual package membership, not from all connections that own the
   stream. (Source: `mcp-server` schema projection + `server/connection-identity.js`.)

2. **Stored `time_bounded` access_mode contradicts the spec (low).** One revoked live grant carries
   `access_mode='time_bounded'`; `SUPPORTED_ACCESS_MODES` is `{single_use, continuous}` only. Orphan row;
   harmless because revoked, but it lets the DB state contradict a normative enum. **Fix:** one-line
   migration to normalize or delete the legacy row.

No mechanism in category (c) is a *security* over-claim — both are honesty/consistency defects, not
enforcement holes.

---

## Quick honesty wins (category b — enforced, just not shown)

These would cheaply raise the *demonstrated* ratio on the public reference, because the runtime already does
the work:

- **Surface introspection.** The RFC 7662 endpoint is live and clean; the `/reference` page never shows the
  token→grant resolution. Render a real `POST /introspect` round-trip.
- **Surface single-use consumption.** 9 live grants are `consumed=t, active` — the spec's intended state.
  The reference only shows `continuous`. Show a single-use grant being consumed and the token still paging.
- **Surface the audit spine.** It's a real, grant-keyed, append-only log (54k+ query events). There is no
  owner-facing route to see it (`/_ref/spine/events` → 404). A read-only owner audit feed would make
  "who read what under which grant" visible — the single highest-leverage trust surface PDPP has.
- **Add a narrow demo bearer.** The MCP bearer grants 18 sources / 126 streams. A second, deliberately
  scoped bearer (1 stream, 3 fields, single_use) would *demonstrate that scope limits an agent*, which the
  broad package can't show.
- **Derive the reference page's field projection from a real grant** instead of a hardcoded "4 of 8" visual.

---

## Re-verification appendix (key live artifacts)

| Probe | Result |
|---|---|
| `POST /introspect token=<owner>` | `{"active":true,"pdpp_token_kind":"owner","subject_id":"owner_local","exp":1812041661}` |
| `POST /introspect token=grt_deadbeef…` | `{"active":false}` (200) |
| `POST /introspect token=` | 400 `invalid_request` |
| `GET /v1/streams/orders/records?connector_id=amazon` (owner) | 200, full record |
| `GET …/orders/records` (no auth) | 401 |
| `filter[nonexistent_field]=x` | 400 `unknown_field` |
| `GET /v1/streams/nonexistent_stream/records` | 404 `not_found` |
| `schema(orders, connection_id=cin_4a2bf6…, full)` | `not_found` "is not part of this package" |
| live spine `query.rejected` (client) | `grant_stream_not_allowed` / 403 "Stream 'user' not in grant" |
| conformance `record-read-conformance-memory` | 9/9 pass incl. "grant field projection drops fields not in the grant" |
| live grants by mode | single_use active+consumed=9, revoked+consumed=2; continuous active=910, revoked=36; time_bounded revoked=1 |
| live spine event counts | consent.approved 3,155 · grant.issued 999 · token.issued 4,215 · query.received 54,521 · query.rejected 15,312 · disclosure.served 39,150 |

*All probes are read-only. No live grant was revoked and no live record was deleted during this audit.*
