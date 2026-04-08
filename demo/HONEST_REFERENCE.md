# Toward an Honest Reference Implementation

Gaps between what the current reference implementation shows and what the spec actually says.
Ordered roughly by how misleading the gap is — not by implementation difficulty.

---

## Spec violations (actively wrong)

### 1. Single-use grants must not persist STATE
**Spec:** "The runtime does not persist STATE from single_use collection runs."  
**Current:** STATE is always persisted after a run, regardless of grant access_mode. The incremental sync feature (cursor-based changes_since) is only valid for `continuous` grants.  
**Fix:** Track grant access_mode in the run context. Only persist STATE when `access_mode: continuous`. Single-use runs get `state: null` in the START message and any STATE messages emitted are discarded.

### 2. cursor and changes_since tokens are from distinct token spaces
**Spec (client conformance §4):** "Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces. MUST NOT use a `next_cursor` value as a `changes_since` parameter."  
**Current:** Not enforced anywhere client-side.  
**Fix:** Use distinct state slots for pagination cursors vs. sync cursors. Never substitute one for the other.

---

## Protocol fictions (shows outcomes, not the actual protocol)

### 3. Connector runtime is not a real process boundary
**Spec:** The runtime spawns a connector as a child process. Communication is stdin/stdout JSONL. The runtime sends `START`, reads `RECORD`/`STATE`/`INTERACTION`/`DONE` from stdout.  
**Current:** `instagram-script.js` runs as an `AsyncFunction` inside the browser-server Node.js process. It calls injected JS functions (`ingestRecord`, `broadcast`, `emitState`) directly — no process boundary, no JSONL, no START message.  
**Fix:** Browser-server becomes a real runtime harness: spawns `node connector.js`, pipes START to stdin (with `bindings.browser_automation.ws_url` pointing to the Chromium CDP endpoint), reads JSONL from stdout, routes RECORD→RS ingest, STATE→state store, INTERACTION→UI, DONE→finalize.

### 4. DONE message is missing
**Spec:** `DONE` must be the final message emitted by every connector, in all cases including failure. The runtime only persists STATE upon receiving a successful DONE.  
**Current:** The script returns (or throws). The runtime infers completion from the Promise resolving.  
**Fix:** Connector emits `{ type: "DONE", status: "succeeded", records_emitted: N }` as its last stdout line. Runtime gates STATE persistence on this.

### 5. Binding matching not performed before spawn
**Spec:** "Before spawning a connector, the runtime checks the manifest's `runtime_requirements.bindings` against its own capabilities. If the runtime cannot satisfy a required binding, the run MUST fail before the connector process is spawned."  
**Current:** Script runs unconditionally.  
**Fix:** Runtime reads manifest `runtime_requirements.bindings`, checks each required binding against its own capability list, fails fast with a clear error if unmet.

### 6. START message does not reach the connector
**Spec:** "The runtime derives the collection request from the grant and passes only what the connector needs to know" via START. "The connector never sees the raw grant."  
**Current:** The script receives `ownerToken`, `connectorId`, `grantIssuedAt` directly — these are authorization artifacts the connector shouldn't see.  
**Fix:** Runtime translates grant into START fields (`collection_mode`, `state`, `bindings`). Connector never receives token or grant ID.

### 7. SKIP_RESULT not implemented
**Spec:** Connector emits `{ type: "SKIP_RESULT", stream, reason, message }` when a stream or resource is intentionally skipped (rate limit, unavailable, etc.).  
**Current:** Silently skips. The scraper hits empty results and moves on with no signal to the runtime.  
**Fix:** Emit SKIP_RESULT when a stream yields nothing due to a known condition.

---

## Missing grant fields

### 8. Retention policy not shown to user at consent time
**Spec:** Grants carry a `retention` object (`max_duration`, `on_expiry: delete|anonymize`) as a policy commitment by the data recipient. This is a first-class part of the consent surface.  
**Current:** No retention field in issued grants. Consent card never shows the user how long Audience Lens will keep their data or what happens on expiry.  
**Fix:** Selection request includes `retention`. Consent card surfaces it ("Audience Lens will delete your data after 90 days").

### 9. Grant expiry not shown to user
**Spec:** `expires_at` on the grant controls how long the authorization itself is active — distinct from data temporal scope.  
**Current:** Grants have no visible expiry. UI never shows "this access expires on…"  
**Fix:** Show `expires_at` in the grant inspector and consent card.

---

## RS conformance gaps

### 10. HTTP 410 on expired cursor not handled
**Spec (RS §7, client conformance §5):** RS returns 410 when a `changes_since` cursor has expired. Client MUST perform a full re-sync rather than retrying.  
**Current:** Not implemented in RS. Client has no 410 handler.  
**Fix:** RS prunes old versions after a configurable window and returns 410. Client detects 410 and resets cursor state.

### 11. Tombstones not shown in changes_since responses
**Spec:** `changes_since` for `mutable_state` streams should include tombstone entries for deleted records (with `deleted: true`).  
**Current:** Only appends/upserts are shown. Deletions are invisible to incremental sync.

---

## AS conformance gaps

### 12. Selection request shape is not RFC 9396
**Spec:** Selection requests use the RFC 9396 `authorization_details` envelope: `{ type: "https://pdpp.org/data-access", ... }`.  
**Current:** `/api/grant` accepts a flat custom JSON shape. Not spec-shaped.  
**Fix:** Wrap selection in `authorization_details` array. AS validates `type` field.

### 13. Grant-scoped vs. global state not distinguished
**Spec:** Global state (proactive archival, no grant) and grant-scoped state (keyed by `grant_id`, for `continuous` grants) are separate namespaces.  
**Current:** One flat state map per connector. No grant_id scoping.

---

## Architecture

### 14. Multi-connector: no primary connector
**Current:** Instagram is hardcoded as the primary flow. Gmail is bolted on afterward. The personal server concept — that it holds data from many independent connectors — isn't structurally represented.  
**Fix:** Personal server panel shows a connector registry. Each connector is independent. The client app (Audience Lens) requests streams by name; the AS resolves which connector(s) can fulfill them. No connector is primary.

### 15. Consent card is the trust surface — treat it that way
The consent UI is where users decide what to share, with whom, for how long, for what purpose. Currently it's a thin interstitial. TMHD makes it the centerpiece: shows purpose code, retention commitment, grant expiry, exact fields being shared, and which view was requested — all legible to a non-technical user.
