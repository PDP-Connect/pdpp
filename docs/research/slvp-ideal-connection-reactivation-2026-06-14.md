# SLVP-Ideal Connection Reactivation — Research & Verdict

**Date:** 2026-06-14  
**Question:** Should a data-access protocol provide an owner action to REACTIVATE a revoked connection that still has collected data, and what is the SLVP-ideal model?  
**Confidence:** 91%

---

## 1. Problem Statement

A `connector_instances` row can be set to `status = 'revoked'` via `POST /v1/owner/connections/:id/revoke`. Revoke is explicitly zero-cascade and data-preserving: records stay readable, no cascade to sibling connections or device edges. The system comment says a revoked connection is "reversible only by an explicit owner re-initiate, never silently" — but **there is no re-initiate route**. The only recoveries are:

1. Delete the connection entirely and start fresh (loses nothing at the store level if you re-enroll, but the connection identity (`connection_id`) changes, disrupting any downstream grants or references).
2. Manually flip the DB row (not an owner affordance).

For a Reddit connection with 1 770 records, the practical owner experience is: "I revoked it by accident / intentionally for a while, and now I want to turn collection back on for the same account." The system forces them to start over even though the data, config, and identity are all intact.

---

## 2. Prior Art

### 2.1 Plaid — Items and Update Mode (gold standard)

**Sources:** https://plaid.com/docs/link/update-mode/ · https://plaid.com/docs/api/items/ · https://plaid.com/docs/errors/item/#item_login_required

Plaid's canonical lifecycle states for an Item (= a user's login at one financial institution):

| State | Meaning | Recovery |
|---|---|---|
| `HEALTHY` | Normal collection | — |
| `PENDING_EXPIRATION` | Consent expires in 7 days (UK/EU) | Pre-emptive update mode |
| `PENDING_DISCONNECT` | Consent expires in 7 days (US/CA) | Pre-emptive update mode |
| `ITEM_LOGIN_REQUIRED` | Auth broken (password change, OAuth consent revoked, session expired) | Link **update mode** |
| `ERROR` (other) | Non-auth runtime errors | Varies |

**The critical design decision:** Plaid never creates a new Item when auth fails. It sends the _same_ `access_token` into Link update mode (`/link/token/create` with `access_token` in the body). Link re-auths and the Item is repaired in place. The `LOGIN_REPAIRED` webhook fires when the item exits the bad state. History, records, and the application's `access_token` reference are all unchanged.

**What Plaid calls "revoke" (deauthorize):** `POST /item/remove` permanently removes an Item; once removed, it returns `ITEM_NOT_FOUND` and the only recovery is creating a new Item from scratch. There is no "soft revoke that keeps data but stops collection" concept in Plaid — but the equivalent is `ITEM_LOGIN_REQUIRED`, where collection stops because auth is broken but data is preserved and recovery is in-place.

**Canonical distinction:**
- `ITEM_LOGIN_REQUIRED` = collection paused due to auth failure; recovery = re-auth in place (update mode), same Item identity
- `/item/remove` = permanent deletion; no recovery

### 2.2 Stripe Connect — OAuth Deauthorize

**Source:** https://stripe.com/docs/connect/oauth-reference (deauthorize section)

`POST https://connect.stripe.com/oauth/deauthorize` disconnects a connected account. After deauthorization, the account cannot be accessed by the platform. There is **no platform-side "reactivate"** — to reconnect, the user must go through the OAuth connect flow again, which creates a new authorization but may link back to the same Stripe account (same `stripe_user_id`). Stripe treats deauthorize as terminal from the platform's perspective.

**Stripe's implicit model for "pausing":** Stripe Connect has no formal "pause" state. The closest analogues are:
- Capabilities restricted/unrestricted (e.g., `payouts: inactive` → `active`)
- Account-level restrictions (which are Stripe-managed, not platform-initiated pauses)
- Dashboard-level account suspension

Stripe does NOT offer a platform API to pause and then resume an account's connection. If an account disconnects/deauthorizes, reconnect = new OAuth flow = same underlying Stripe account but treated as a re-initiation.

**Verdict on Stripe:** Stripe treats deauthorize as terminal; reconnect goes through the same OAuth flow as initial connect. This is appropriate for payment processing (where dormant authorization has compliance risk) but is _not_ the right model for a data-access protocol where the value is the accumulated historical data.

### 2.3 Nango — Connection Lifecycle

**Source:** docs.nango.dev (SPA-rendered; docs index confirms `guides/api-authorization/re-authorization` exists but could not be extracted from SPA)

From what is accessible about Nango's model (from indexed prior research in this session):

Nango distinguishes:
- **Active connection** — OAuth tokens current, collection running
- **Connection with expired/invalid credentials** — Nango surfaces this as a connection needing re-authorization; it exposes a re-auth flow that **reuses the existing connection ID** and swaps the underlying token
- **Deleted connection** — `DELETE /connection/{id}` removes it; data (if any) is discarded by the integration host

Nango's re-authorization model is structurally similar to Plaid's update mode: the connection identity persists and the underlying credential is refreshed. This is the correct model when the thing you care about is the persistent identity and its accumulated state.

### 2.4 Merge.dev — Linked Accounts

Merge calls the abstraction a "Linked Account." Their disconnect flow removes the linked account and data access. There is no published "pause then resume" flow — a disconnected account must be re-linked.

### 2.5 Synthesis from Prior Art

All four platforms distinguish at least two terminal-or-near-terminal operations:
1. **Credential/auth failure** (Plaid: `ITEM_LOGIN_REQUIRED`; Nango: re-auth needed) — recoverable in place by re-authing with the same connection identity
2. **Deliberate disconnect/delete** (Plaid: `/item/remove`; Stripe: `/oauth/deauthorize`; Merge: delete linked account) — terminal from the platform's perspective, though re-connecting the same underlying account may produce a new connection

The SLVP platforms consistently treat **"stop collection due to a broken credential"** differently from **"permanently destroy the connection."** A voluntary owner "stop" (like PDPP's revoke) maps more closely to the former category than the latter — it's a deliberate pause of collection, not a destruction of the relationship.

---

## 3. PDPP-Specific Analysis

### 3.1 Current Status Enum

`connector_instances.status` CHECK constraint (db.js line 174):
```
CHECK (status IN ('active', 'paused', 'revoked', 'draft'))
```

`VALID_STATUSES` in `connector-instance-store.js`:
```javascript
const VALID_STATUSES = new Set(['active', 'paused', 'revoked', 'draft']);
```

The DB and store already carry `paused` as a valid status value. **`paused` is never set by any current route.** The status gate in `resolveOwnerConnectorInstanceNamespace` throws `connector_instance_inactive` for any status that is not `active` — so `paused` and `revoked` are functionally equivalent at the collection layer: both stop new runs.

`updateStatus` signature:
```javascript
updateStatus(connectorInstanceId, { status, updatedAt, revokedAt = null })
```

This method can already flip a connection to any VALID_STATUS. The revoke route calls `updateStatus(id, { status: 'revoked', ... })`. A reactivate route would call `updateStatus(id, { status: 'active', ... })`. **No new store method is required.**

### 3.2 Source Kind and Credential Implications

`VALID_SOURCE_KINDS`:
```javascript
const VALID_SOURCE_KINDS = new Set(['account', 'local_device', 'browser_collector', 'manual']);
```

The credential-safety question breaks cleanly by source kind:

| source_kind | Credential type | Revoke invalidates cred? | Reactivate safety |
|---|---|---|---|
| `manual` | No live credential (manual upload) | No — data already collected | Pure status flip — safe immediately |
| `local_device` | Local device binding (no cloud credential) | No — device session managed separately | Pure status flip — safe; device re-enrollment handled by device layer |
| `browser_collector` | Browser session credential | Possibly — session may have expired | Status flip is safe; first run will surface credential error if session expired |
| `account` | OAuth token / static secret | Yes if OAuth token was rotated or revoked upstream | Status flip alone may be insufficient — first run will fail with auth error |

**Key insight:** "Reactivate" as a pure status flip (`revoked → active`) is safe for all source kinds because:
1. The worst case is that the first collection run after reactivation fails with a credential/auth error — this is a recoverable, non-destructive failure. The data stays intact.
2. The `connector_instance_inactive` resolution gate already protects against ingest on non-active connections; reactivation simply removes that gate.
3. The collection run outcome (fail-with-credential-error) is exactly the right signal for the owner: "reactivated, but you need to re-supply credentials."

Crucially, PDPP differs from Stripe Connect in that credentials are stored _within_ PDPP (static secrets in the store, or local device sessions). The connection object survives a credential failure; the owner can fix the credential and resume. This is architecturally closer to Plaid's update-mode model than to Stripe's hard-deauthorize model.

### 3.3 The Duplicate Connection Risk

The stated concern ("re-initiate a fresh connection risks a duplicate connection") is real: the `connectorInstanceId` is deterministically derived from `ownerSubjectId + connectorId + sourceKind + sourceBindingKey`. If an owner re-initiates a fresh connection for the same source account, the deterministic key will produce the **same `connectorInstanceId`** — so there is no actual duplication at the DB level. However:
1. The re-initiation flow would find the existing (revoked) row and might not know what to do with it.
2. If the flow creates a new row for the same key (e.g., by treating the revoked row as nonexistent), it would produce a conflict or create a logical duplicate.

A reactivate route avoids this ambiguity entirely by explicitly flipping the existing row — identity is preserved, no re-initiation flow needed.

---

## 4. The Lifecycle State-Machine Recommendation

### 4.1 Recommended States

```
         ┌──────────┐
         │  draft   │  ← static-secret pre-activation; invisible to read surfaces
         └────┬─────┘
              │ first successful ingest (activateDraft)
              ▼
         ┌──────────┐
    ┌───▶│  active  │◀────────────── reactivate ─────────────────┐
    │    └────┬─────┘                                             │
    │         │ revoke (owner explicit)                           │
    │         ▼                                                   │
    │    ┌──────────┐                                             │
    │    │ revoked  │─────────────────────────────────────────────┘
    │    └──────────┘
    │
    │    ┌──────────┐
    └────│  paused  │  ← future: system-initiated pause (rate limit, quota, etc.)
         └──────────┘
                                          (deleted = row removed, not a status)
```

### 4.2 State Definitions

| State | Semantics | Who sets it | Collection allowed | Readable |
|---|---|---|---|---|
| `draft` | Configured but not yet validated; credential not proven | System (static-secret setup path) | No | No (hidden from all read surfaces) |
| `active` | Normal; collection runs allowed | System (draft activation), owner (reactivate) | Yes | Yes |
| `revoked` | Owner-explicitly stopped; data preserved | Owner (revoke action) | No | Yes |
| `paused` | System-initiated pause (reserved for future use) | System | No | Yes |

### 4.3 Allowed Transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| `draft` | `active` | System | First successful ingest (`activateDraft`) |
| `active` | `revoked` | Owner | `POST /v1/owner/connections/:id/revoke` |
| `revoked` | `active` | Owner | `POST /v1/owner/connections/:id/reactivate` ← **MISSING** |
| `active` | `paused` | System | (reserved for future rate-governance) |
| `paused` | `active` | System | (reserved for future rate-governance) |

### 4.4 What "revoke" means vs. "paused"

The current `revoked` state carries the right semantics for **voluntary owner action** (not a system-managed pause). Introducing a separate `paused` for "the system stopped this" is prudent future-proofing (rate governors, quota pauses) but is out of scope for this change. The recommendation is to keep `revoked` as the owner-explicit state and add `reactivate` as its inverse — not to rename revoke to paused.

---

## 5. VERDICT

**Yes — PDPP should add a `reactivate` owner action. Confidence: 91%.**

### 5.1 Rationale

1. **The current model is wrong for the common case.** An owner who revokes a Reddit connection with 1 770 records and then wants to resume collection should not be forced into a re-initiation flow. Re-initiation: (a) is confusing because "connect" implies starting from scratch, (b) risks confusion about whether data is preserved, and (c) could theoretically cause issues if the re-initiation path doesn't handle the existing (revoked) row correctly.

2. **Prior art overwhelmingly endorses in-place recovery.** Plaid's update mode, Nango's re-authorization — the SLVP platforms treat auth-stopped connections as recoverable in place. PDPP's revoke is closer in spirit to "auth failure stops collection" than to "hard delete."

3. **The implementation is trivial.** The store's `updateStatus` method already accepts `'active'` as a target. The revoke route's pattern (ownership check → active-status gate → store flip → audit emit → 200) applies exactly to reactivation with two changes: the guard becomes "must be revoked, not active" and the target status is `'active'`.

4. **The credential nuance is handled by the existing run/ingest pipeline.** A reactivated connection with a stale credential will fail on its next collection run with a typed credential error — the same health projection machinery that handles any other credential failure. Reactivate does not need to validate or re-supply credentials; the run lifecycle handles that. (This is exactly how Plaid's update mode works: the Item is "repaired" by re-auth, which is a separate action from the Item existing in a broken state.)

5. **The revoked → active flip does not violate any durability guarantee.** The revoke durability guard (`ensureDefaultAccountConnection` + resolver) was built to prevent _silent_ resurrection of revoked rows by system processes. An explicit owner reactivate is the opposite of silent — it is deliberate owner intent.

### 5.2 Adversarial Check: Strongest Case Against

**Argument: "Revoke should be terminal; force re-initiate for cleanliness."**

- Claim: Making revoke reversible weakens its semantics. If owners can freely revoke/reactivate, "revoke" becomes indistinct from "pause." Force a fresh connection for a clean slate.
- Rebuttal: This argument holds only if there is a meaningful difference between a revoked-then-reactivated connection and a fresh connection with the same account. There isn't — the data model is identical (same `connectorInstanceId` key, same records, same schedule). The only difference is that re-initiation destroys the connection identity (`connection_id` changes), which is strictly worse for anything that references that ID (grants, audit records). The "clean slate" argument is a rationalization for workflow complexity, not a real safety property.
- Second rebuttal: Stripe's terminal-deauthorize model makes sense for _payment processing_ where a dormant OAuth grant is a compliance liability. PDPP's collected data has no equivalent compliance risk from a dormant connection status. The analogy does not apply.

**Verdict on counter-argument: Does not win.** The cost of preventing accidental revoke-recovery (complexity, duplicate-connection risk, data confusion) exceeds the benefit of "clean slate" aesthetics.

---

## 6. Fix Surface (Exact Implementation Plan)

### 6.1 New Route

```
POST /v1/owner/connections/:connectionId/reactivate
POST /v1/owner/connectors/:connectorId/reactivate  (connector-only addressing, same ambiguity path as revoke)
```

Pattern: exact mirror of `owner-connection-revoke.ts` with:
- Active-status guard inverted: throw `connector_instance_not_revoked` (400) if the instance is already `active`; throw `connector_instance_not_found` (404) if foreign/unknown
- `updateStatus(id, { status: 'active', updatedAt: stamp, revokedAt: null })` — clears `revokedAt`
- Audit event family: `owner_agent.connection.reactivate`
- Response: `{ object: "owner_connection_reactivate", connection_id, connector_id, connector_key, status: "active", reactivated_at }`

### 6.2 Store Change

`updateStatus` already accepts `'active'` as a target (VALID_STATUSES includes it). No store API change needed. The `revokedAt: null` clear is already supported by the method signature (`revokedAt = null` default).

**One guard to add in the reactivate handler** (does not exist in revoke): the resolver's active-status gate (`connector_instance_inactive`) will reject a revoked connection — so the reactivate handler must use a _different_ resolver path or catch the `connector_instance_inactive` error and use the instance directly. The existing `revoke` route uses `resolveOwnerConnectorNamespace` which enforces the active-status gate. Reactivate needs to: resolve the raw instance (bypass the active gate), verify ownership, verify status is `revoked`, then flip to `active`. The `get(connectorInstanceId)` + ownership check is the right pattern here, not `resolveOwnerConnectorNamespace` with its active-status enforcement.

### 6.3 Control Document

Add `reactivate_connection` to the owner control document (metadata.ts `actions` array), family `reactivate_connection`, method `POST`, URL template `{rs_url}/v1/owner/connections/{connection_id}/reactivate`. Status `supported`.

### 6.4 UI Affordance

On the revoked-connection detail/card (console):
- Show a "Reactivate" button (or "Resume collection") in the danger zone — below the revoked status badge, above the Delete option
- Copy: **"Reactivate"** (primary action, filled button) — keeps your collected data, resumes collection for this connection
- Subtext: "Your [N] collected records are preserved. Collection will resume on the next scheduled run."
- If the connector uses `account` source kind with an OAuth credential, add: "You may need to re-authorize if your session has expired."
- Source kinds `manual` and `local_device`: no credential warning needed

### 6.5 Source-Kind Differentiation Summary

| source_kind | Reactivate type | Post-reactivate behavior |
|---|---|---|
| `manual` | Pure status flip | Connection returns to active; no collection runs occur (manual upload connector) |
| `local_device` | Pure status flip | Collection resumes if device is enrolled; device session managed by device layer |
| `browser_collector` | Status flip + warn | Collection resumes; first run may fail with expired browser session error |
| `account` (OAuth/static secret) | Status flip + warn | Collection resumes; first run may fail with expired credential error, surfaced as `needs_attention` |

In all cases, reactivate itself is a pure status flip. The credential freshness question is delegated to the collection run pipeline, which already handles it correctly.

---

## 7. Confidence Assessment

**91%** — high confidence. The four risk factors that would reduce this:

1. **(−3%) Unknown re-initiation flow behavior for existing revoked rows.** If the re-initiation flow has been designed to look for `active` rows only and create a new row when none is found, it may already handle revoked rows as "not found." In that case the duplicate-connection risk is moot (same deterministic ID prevents actual duplication), but the re-initiation path might produce a confusing error. This needs a quick check of the connect/setup flow before ship.

2. **(−3%) `resolveOwnerConnectorNamespace` active-status gate.** The reactivate handler cannot use the same resolver as revoke — it must use a lower-level get + ownership check. A subtle implementation error here (using the wrong resolver) would produce a confusing 400 instead of the expected 200. This is a mechanical risk, not a design risk.

3. **(−2%) `revokedAt` null-clearing in Postgres.** The `updateStatus` implementation uses SQLite-style parameter binding. The Postgres storage path needs the same `revokedAt: null` clear. Worth verifying before ship.

4. **(−1%) No paused→active transition design.** If `paused` becomes a system-managed state (rate governor), the reactivate handler should not flip `paused → active` (that would be a system override). The handler should guard `status === 'revoked'` explicitly, not `status !== 'active'`.

---

## 8. Sources

| Source | URL | Date accessed |
|---|---|---|
| Plaid Link — Update mode | https://plaid.com/docs/link/update-mode/ | 2026-06-14 |
| Plaid API — Items lifecycle | https://plaid.com/docs/api/items/ | 2026-06-14 |
| Plaid Errors — ITEM_LOGIN_REQUIRED | https://plaid.com/docs/errors/item/ | 2026-06-11 (indexed) |
| Stripe Connect OAuth reference (deauthorize) | https://stripe.com/docs/connect/oauth-reference | 2026-06-14 |
| Nango docs index | https://docs.nango.dev (SPA-rendered, not extractable) | 2026-06-14 |
| PDPP `connector-instance-store.js` | reference-implementation/server/stores/connector-instance-store.js | 2026-06-14 |
| PDPP `owner-connection-revoke.ts` | reference-implementation/server/owner-connection-revoke.ts | 2026-06-14 |
| PDPP `db.js` (schema) | reference-implementation/server/db.js | 2026-06-14 |
| PDPP `metadata.ts` (lifecycle comments) | reference-implementation/server/metadata.ts | 2026-06-14 |
