# SLVP-Ideal In-Dashboard Setup / Repair / Edit UX for Browser-Bound and Local-Device Connectors

**Date:** 2026-06-14  
**Scope:** Browser-bound (amazon, usaa, chase, reddit, chatgpt) and local-device (codex, claude-code) connectors — connectors the owner has data for that still dead-end in the dashboard.  
**Build on:** `slvp-ideal-connector-self-service-setup-2026-06-14.md` (static-secret prior art + no-dead-ends principle). Do not re-read that doc — the verdicts here assume it.  
**No app code changed.** Research + corpus only.

---

## 1. The Problem

These seven connectors have collected real data (amazon 2,868 records, chase 1,168, usaa 1,924, reddit 1,770, chatgpt 126k, codex/claude-code via local collector) but the dashboard currently dead-ends them:

| Connector | Disposition today | Owner sees |
|-----------|------------------|------------|
| amazon | `browser_bound_runbook` | "Packaged path pending" — no CTA |
| usaa | `browser_bound_runbook` | "Packaged path pending" — no CTA |
| chase | `browser_bound_runbook` | "Packaged path pending" — no CTA |
| reddit | `browser_collector_manual` | "Packaged path pending" — no CTA |
| chatgpt | `browser_bound_runbook` | "Packaged path pending" — no CTA |
| codex | `local_collector_enroll` | **Already self-service** (device-exporters form) |
| claude-code | `local_collector_enroll` | **Already self-service** (device-exporters form) |

**Key nuance:** codex and claude-code are NOT dead-ends. `sourceSetupAction` already routes them to `/dashboard/device-exporters?connector=claude_code`. The enrollment form exists, is deep-linked, and is proven. The local-device story is structurally solved — the gap is REPAIR (agent offline / re-enroll) and surface polish.

**The real gap is browser-bound:** five connectors whose data was collected via a local browser session (Patchright/neko on the owner's machine) but where the dashboard offers no CTA, no actionable path, and no way to trigger re-auth when the session expires.

---

## 2. Prior Art

### 2.1 Plaid Link — The Gold Standard for Session-Based Re-Auth (Browser-Bound Analog)

**URL:** https://plaid.com/docs/link/update-mode/  
**URL:** https://plaid.com/docs/link/

Plaid is the closest production analog to PDPP's browser-bound problem: it drives a user's logged-in bank session (credentials + MFA) on behalf of an application, without the application ever seeing the credential. Key patterns directly applicable:

**Initial setup (Link flow):**
Plaid Link is an embedded, hosted flow — not a form. The host application mints a `link_token` (server-side, carries TTL), renders the Plaid Link SDK (iframe or redirect), the user authenticates, and Plaid returns a `public_token` that the host exchanges server-side for an `access_token` (the persisted credential reference). The end user never re-types their bank password into the host app. The link token is scoped and short-lived (30 minutes). Presentation: native SDK (web modal/iframe), native iOS/Android SDKs, or Hosted Link (pure redirect URL, for webviews where you don't control the frontend).

**Session expiry = ITEM_LOGIN_REQUIRED:**  
When a bank session or OAuth token expires, Plaid sets the Item to `ITEM_LOGIN_REQUIRED` and fires a `PENDING_EXPIRATION` then `ITEM_LOGIN_REQUIRED` webhook. The host app surfaces a repair CTA that re-opens Link **in update mode** — the _same_ Link component used for initial setup, but scoped to the specific `access_token`. The user re-authenticates in the minimum steps required (if only an OTP expired, only OTP is shown). On repair, Plaid fires `LOGIN_REPAIRED` and the Item returns to healthy. The `access_token` / `connection_id` is unchanged; history is preserved.

**Critical design decisions from Plaid:**
1. Session-based setup is a **hosted flow** (the mechanism), not a form. The host cannot capture the session credential — it only gets an opaque token after the flow.
2. Repair = same mechanism as initial setup, scoped to the existing connection. No new connection ID.
3. The broken state is a named, action-bearing state — not a dead end. `ITEM_LOGIN_REQUIRED` → "Reconnect your account" CTA → update-mode Link.
4. Plaid never stores the raw session cookie. The connector receives the session (via the managed browser flow) and emits structured records.

**PDPP mapping:** Plaid's `link_token` ↔ PDPP's `browser-enrollment-shell` (already built: `POST /_ref/connectors/:connectorId/browser-enrollment-shell`, 2h TTL, owner-session cookie only). Plaid's Link session ↔ PDPP's neko/Patchright browser surface. Plaid's `ITEM_LOGIN_REQUIRED` ↔ PDPP's `needs_attention` / `browser_session_expired` connection state. Plaid's update mode ↔ PDPP's "reconnect" CTA that re-opens the browser enrollment flow for an existing `connection_id`.

### 2.2 Nango — Managed Browser Auth (Session-Capture Pattern)

Nango (https://www.nango.dev/) is a managed integration platform that handles OAuth and, for non-OAuth providers, custom auth flows including session-cookie capture. Their pattern for session-based connectors:
- The user initiates setup inside the Nango-hosted Connect UI (an embedded component or redirect).
- For session-based connectors, Nango opens a managed browser (headless or visible), the user logs in interactively in that browser, Nango captures the resulting session cookies/tokens, and stores them encrypted.
- Re-auth: when Nango detects a failed API call due to session expiry, it marks the connection `ERROR: REFRESH_TOKEN_EXPIRED` and fires a webhook. The host shows a reconnect CTA that re-opens the Connect UI for the same `connectionId`.
- The user does NOT need to find the connector in a catalog again — the reconnect deep-links directly to the specific connection's auth flow.

**PDPP mapping:** The Nango pattern confirms the design principle: re-auth should be a first-class, connection-scoped action, not a new-connection create flow. The `connection_id` is the anchor; setup and repair share the same in-dashboard surface.

### 2.3 Tailscale — Device Enrollment and Agent Health (Local-Device Pattern)

**URL:** https://docs.tailscale.com/kb/1123/machine-enrollment/  
**URL:** https://tailscale.com/kb/1028/key-expiry (from prior research)

Tailscale is the canonical reference for how to present "install an agent on a device and track its health" — directly applicable to PDPP's local-device (codex/claude-code) connectors.

**Initial enrollment:**  
1. Owner visits the admin console (the equivalent of PDPP's device-exporters page).
2. Console generates an auth key (one-time or reusable, with TTL).
3. Owner runs one command on the target device: `tailscale up --authkey=<key>`.
4. Device appears in the admin console immediately with status `Connected`.
5. The console renders the full enrollment command (copy-pasteable), a deep-link to the machine page, and the auth key expiry.

The PDPP enrollment form already mirrors this exactly: generates a short-lived enrollment code, renders the full `pdpp collector enroll` + `pdpp collector run` commands, copy-button included.

**Agent health + re-enroll:**  
Tailscale distinguishes four states for a device: `Connected`, `Idle`, `Offline`, `Expired`/`Key Expired`. The expired/offline distinction matters: `Offline` = agent not currently connected (transient), `Key Expired` = the auth credential needs renewal (requires action). The admin console shows a banner on the device entry for key expiry, with a CTA to generate a new auth key. The user runs `tailscale up --authkey=<new-key>` on the device.

**PDPP mapping:** The PDPP device-exporters page already shows enrolled devices with heartbeat status (`fresh`, `stale`, `never`). The gap is the **repair CTA** — when a device goes stale or its enrollment is revoked, there is no in-page "Re-enroll this device" button that generates a new code pre-scoped to that device/connector combination and renders the command. This is the Tailscale key-renewal pattern applied to PDPP.

### 2.4 Datadog / Monitoring Agents — "No Dead Ends" for Infra-Prerequisite Connectors

Datadog's agent onboarding (https://docs.datadoghq.com/agent/basic_agent_usage/) is a third pattern: for connectors that require a running agent on infrastructure the user controls, Datadog:
1. Shows the **specific install command** for the user's OS (auto-detected or picker).
2. Shows a live "waiting for data" state while the agent installs — the page polls and flips to success.
3. For agent-offline states, shows a banner on the specific host with a copy-paste re-install command.

The key pattern: **infra prerequisites do not become dead ends**. The page shows exactly what must happen and gives the user the command to do it. PDPP's device-exporters page already does this for initial setup. The gap is the repair surface for existing enrolled devices.

### 2.5 Personal Finance Aggregators (Mint/Monarch Money) — Browser-Session-Based Bank Access

For context on the browser-session / screen-scraping pattern at consumer scale:

- **Plaid** (covered in §2.1) migrated ~75% of bank connections to API/OAuth by 2025, deliberately shrinking the screen-scraping surface. The remaining screen-scraped banks are treated as a legacy path, and `ITEM_LOGIN_REQUIRED` is the primary failure mode (session expiry, password change, new MFA device).
- **Finicity/MX/Akoya** (Plaid competitors): same pattern — hosted link flow, session managed by the aggregator, `LOGIN_REQUIRED` failure state with reconnect CTA.
- The universal consumer pattern for browser-session-based bank access: (a) embedded/hosted browser or iframe where the user logs in, (b) aggregator captures session, (c) on expiry, a "Reconnect" CTA re-opens the same embedded login flow scoped to the existing connection.

The PDPP browser-bound connectors (usaa, chase) are the same model: no public API, must drive a logged-in browser session. The session capture is local (Patchright on the owner's machine, not a cloud aggregator), but the UX pattern for setup and repair is identical to Plaid.

### 2.6 Browser Extensions for Data Collection (Instacart Receipt Capture, etc.)

Some personal data tools use browser extensions for session-based data access (e.g., Ramp, Brex receipt capture, expense tools that "connect" to your bank by running in the browser). The extension pattern:
- **Setup**: Install extension → extension surfaces a "Connect" button on the provider's page → user clicks while logged in → extension captures session context.
- **Repair**: Extension detects session expiry on next visit → shows a badge/notification → user clicks to "Reconnect" (re-runs the session capture).

This is analogous to PDPP's local browser collector (the connector runs Patchright locally, visits the site, captures data while the user is logged in). The "reconnect" is re-running the connector with a fresh login flow.

**Key insight from extensions:** the UX works because there is a clear trigger moment (the user is on the provider's site, already logged in). PDPP's browser-bound connectors don't have this ambient trigger — the user must explicitly initiate a session-capture run. This makes the CTA design more important: the dashboard must tell the user exactly when and how to trigger a re-collect session, not leave them guessing.

---

## 3. The SLVP-Ideal Verdict — Per Modality

### 3A. LOCAL-DEVICE CONNECTORS (codex, claude-code)

**Confidence: 95%**

**Current state:** Already self-service for initial setup. The enrollment form at `/dashboard/device-exporters` is deep-linked, generates the enrollment code, and renders the exact CLI commands. `codex` and `claude-code` are in `SUPPORTED_LOCAL_COLLECTOR_CONNECTORS`, `sourceSetupAction` routes them correctly.

**The gap — Setup:** None for initial setup. Verdict: **no work needed**.

**The gap — Repair:** Three repair scenarios with no current in-dashboard path:
1. **Agent offline (stale):** Device heartbeat goes stale. The device row shows `stale` badge. No CTA to re-enroll or diagnose. The user must navigate back to the enrollment form manually.
2. **Device revoked:** If the owner revokes a device, it goes to `revoked` state. No "Re-enroll this device" action that pre-fills the form with the same `connector_id` and `local_binding_name`.
3. **New device:** Adding the same connector (e.g., `claude_code`) on a second device requires navigating to the form and manually entering the connector ID — no shortcut from an existing connection.

**The gap — Edit:** No "change display name" or "change local_binding_name" on an enrolled device row. Minor, but part of SLVP-ideal edit parity.

**SLVP-ideal for local-device repair:**  
Mirror the Tailscale key-renewal pattern. On a stale or revoked device row, surface a **"Re-enroll"** inline action that:
1. Calls `POST /_ref/device-exporters/enrollment-codes` with the device's known `connector_id` and `local_binding_name` pre-filled.
2. Renders the resulting `pdpp collector enroll ...` command inline on the device row (collapsible, copy-button).
3. Clears the stale state on next heartbeat.

No new route needed — the existing enrollment code endpoint already handles this. The change is entirely console UI: a "Re-enroll" button on `DeviceRow` that expands an inline enrollment command panel.

**Fix surface:**
- `/home/user/code/pdpp/apps/console/src/app/dashboard/device-exporters/` — `page.tsx` `DeviceRow` component + `enrollment-form.tsx` action (or a new inline `ReenrollAction` component).
- `actions.ts` — `createEnrollmentCodeAction` can be called from the inline button with pre-filled params.
- No server changes required.

### 3B. BROWSER-BOUND CONNECTORS — INITIAL SETUP (amazon, usaa, chase, reddit, chatgpt)

**Confidence: 88%** (88% on the SLVP-ideal design; 60% on when it's fully shippable, because it depends on infra the owner controls)

**The problem:** These connectors need a hosted headed browser session (neko + Patchright) to collect data. Today the data was collected via a monorepo proof run (`PDPP monorepo checkout + pnpm run`) — NOT an owner-usable dashboard path. The dashboard correctly shows "Packaged path pending" but gives no actionable forward path.

**What's already built (the surprise):**  
The reference implementation has the server-side primitives for in-dashboard browser enrollment already built:

1. **Browser-enrollment shell** (`ref-browser-enrollment-shell.ts`): `POST /_ref/connectors/:connectorId/browser-enrollment-shell` — creates a draft `connection_id` with a 2h TTL, owner-session cookie only. This is the Plaid `link_token` equivalent. Built, tested (15 tests), not yet wired to a console UI.

2. **Neko/Patchright browser surface** (`docker/neko/`, `packages/remote-surface/`): A hosted headed Chromium (Patchright-patched, VP8 WebRTC streaming via neko) that connectors can drive remotely via CDP. The surface allocator (`neko-surface-allocator-server.ts`) manages containers and leases.

3. **Streaming viewer** (`apps/console/src/app/dashboard/runs/[runId]/stream/`): A full in-dashboard stream viewer — `neko-client.ts` (WebRTC client), `stream-viewer.tsx` (React component). Currently used for assisted-refresh runs. The viewer works for any run that emits browser-surface assistance.

4. **Assistance detection** (`run-assistance.ts`): `requiresBrowserSurfaceAssistance()` — detects when a run needs the owner's browser surface. The enrollment run just needs to emit the same assistance shape.

**What is NOT yet built (the gaps):**
- A console "Connect with browser" page/CTA that calls the browser-enrollment-shell endpoint.
- An enrollment run that starts the connector in session-capture mode (not full-collect) and emits the `run.interaction_required` assistance event.
- A page at e.g. `/dashboard/connect/browser-session/[connectorId]` that:
  1. Creates the browser-enrollment shell.
  2. Starts an enrollment run.
  3. Embeds the existing stream viewer for that run.
  4. On completion, flips the shell to `active`.

**SLVP-ideal flow for browser-bound initial setup:**

1. **Entry point:** On a browser-bound connector's source card or connection card, a "Connect" / "Add account" CTA (replacing "Packaged path pending") → navigates to `/dashboard/connect/browser-session/[connectorId]`.
2. **Connect page** (`/dashboard/connect/browser-session/[connectorId]`):
   - Server action: `POST /_ref/connectors/:connectorId/browser-enrollment-shell` → `connection_id` + TTL.
   - Server action: start enrollment run (bounded: session-establish only, not full collect).
   - Page renders: "Log in to [Amazon] — your browser will open below. Once logged in, PDPP will confirm your session and start collecting."
   - Embeds the existing `StreamSurface` component (from `runs/[runId]/stream/stream-viewer.tsx`) — the user sees the hosted Chromium and logs in.
   - On run completion: shell flips to `active`, page shows success + "First sync running."
3. **Disposition flip:** `browser_bound_runbook` → `browser_session_connect` (a new disposition, or promotion to `local_collector_enroll` analog) once the infra proof is complete.

**The infra prerequisite (the honest hard part):**  
For the neko browser surface to work, a neko container must be running and reachable. Today, neko profiles for these connectors exist in `tmp/neko-profiles/` (produced by proof runs on the owner's machine). The neko surface allocator and Docker neko image are in the repo. But:

- If the PDPP deployment has no neko container running (`neko-surface-allocator-server.ts` finds no available surface), the flow fails with no actionable owner path.
- The `sourceSetupStatus` for `browser_bound_runbook` currently reads "Packaged path pending" — which is honest. Flipping it to "Connect" before the neko infra is deployed would be dishonest.

**The honest no-dead-end treatment for NOW (pre-neko deployment):**  
The current "Packaged path pending" copy is honest but not actionable. The SLVP-ideal improvement that can ship TODAY without the neko infra:

- Replace "Packaged path pending" (zero CTA) with a named state + a real runbook link + a copy-pasteable command.
- Disposition: `browser_bound_runbook` → the status badge changes from "Packaged path pending" to "Needs local setup" with amber tone.
- `sourceSetupGuidance`: "This connector collects data by driving your logged-in browser session. To add an account now, run the local browser collector from the [browser-collector runbook](`docs/operator/browser-collector-proof-runbook.md`). In-dashboard setup is coming."
- `sourceSetupAction`: returns a CTA linking to the runbook — not `null` (which currently renders no button).

This eliminates the dead end while being honest about what needs to happen.

### 3C. BROWSER-BOUND CONNECTORS — REPAIR / RE-AUTH (session expired)

**Confidence: 85%**

**The Plaid parallel:** When a neko browser session expires (the connector visits Chase and finds the session logged out), the connection health will degrade. The `needs_attention` state is the equivalent of `ITEM_LOGIN_REQUIRED`.

**SLVP-ideal repair flow (mirrors Plaid update mode):**

1. Connection enters `needs_attention` with a reason of `browser_session_expired` (or similar).
2. Connection detail page shows a repair banner: "Your [Chase] session has expired. Log in again to resume collection."
3. CTA: "Reconnect" → same path as initial setup (`/dashboard/connect/browser-session/[connectorId]?connectionId=<existing>`), but scoped to the existing `connection_id`.
4. The browser-enrollment shell is created for the EXISTING connection, not a new one (the `connection_id` is preserved, same as Plaid update mode).
5. Owner logs in via the embedded neko surface → session is refreshed → connection returns to healthy.

**What's missing today:** The repair CTA on the connection detail page. The `ref-browser-enrollment-shell.ts` route has the `abandon-enrollment` endpoint but no explicit "re-enroll existing connection" mode. An edit to support `?connectionId=existing` scope would need a server-side delta.

**Fix surface for repair (when neko infra is available):**
- Connection detail page: add a repair banner for `needs_attention` browser-bound connections.
- The CTA should link to the same browser-session connect page with `?connectionId=existing`.
- Server side: `POST /_ref/connectors/:connectorId/browser-enrollment-shell` should accept an optional `connectionId` to re-enroll an existing (not create new).

**Fix surface for repair (NOW, pre-neko):**
- Connection detail page: when connection state is `needs_attention` and disposition is browser-bound, show a banner: "Session expired. To re-authenticate: [link to runbook]." This is the honest forward path without requiring neko infra.

---

## 4. The No-Dead-Ends Principle Applied

The prior art and the PDPP codebase agree on the principle: no state should be a blank wall. The table below shows the SLVP-ideal treatment for each scenario:

| State | Current | SLVP-ideal (pre-neko) | SLVP-ideal (post-neko) |
|-------|---------|----------------------|------------------------|
| Browser-bound, no connection yet | "Packaged path pending" — zero CTA | "Needs local setup" + runbook CTA | "Connect" CTA → `/dashboard/connect/browser-session/[connectorId]` |
| Browser-bound, session expired | No repair surface (health shows degraded) | Banner + runbook re-auth link | "Reconnect" CTA → same connect page, `?connectionId=existing` |
| Local-device, agent stale | `stale` badge — no CTA | "Re-enroll" inline button → new enrollment code + command | Same (infra already exists) |
| Local-device, no connection yet | ✅ Works today (enrollment form deep-link) | ✅ No change | ✅ No change |

**The adversarial case for "genuinely can't be self-service yet":**

The strongest objection is: the neko browser surface requires a running neko container at the PDPP deployment. If the owner hasn't deployed a neko service, the "Connect" CTA opens a browser-session page that immediately fails. This is worse than "Packaged path pending" — it promises something it can't deliver.

**The answer:** The ideal is NOT to flip the CTA to "Connect" before the neko infra is provably available. The ideal is:

1. **Pre-neko deployment:** The status check (`canUseBrowserSessionEnroll()`) returns false → the disposition stays `browser_bound_runbook` → but the guidance line changes from "Packaged path pending" (no path) to "Needs local setup" + a real CTA pointing at the runbook. The owner is not left at a wall — they're given exactly what they need to do (run the local collector, follow the runbook). The copy acknowledges in-dashboard setup is coming.

2. **Post-neko deployment:** `canUseBrowserSessionEnroll()` returns true (server health check on the neko surface allocator) → the disposition promotes to `browser_session_connect` → the "Connect" CTA appears → the neko-embedded flow runs.

This is exactly how Plaid handles partial rollouts: Hosted Link exists as a fallback when the native SDK can't be used. The PDPP analog: the runbook path is the fallback when the neko surface isn't deployed.

---

## 5. Exact Fix Surface in PDPP

### 5.1 Local-Device — Repair (Quick Win, No Server Changes)

**File:** `/home/user/code/pdpp/apps/console/src/app/dashboard/device-exporters/page.tsx`  
**Change:** Add a `ReenrollButton` on `DeviceRow` for `stale` / `revoked` devices. On click, call `createEnrollmentCodeAction` with the device's known `connector_id` + `local_binding_name` pre-filled, expand an inline panel with the resulting enrollment command. Copy-button provided.

**File:** `/home/user/code/pdpp/apps/console/src/app/dashboard/device-exporters/enrollment-form.tsx`  
**Change:** Accept an optional `prefillConnectorId` + `prefillLocalBindingName` that pre-populates the form (for the re-enroll case). The form already handles `defaultConnectorId`; this extends that pattern.

**What's needed:** Zero server changes. The `POST /_ref/device-exporters/enrollment-codes` endpoint already exists and works. The change is entirely in the console UI.

### 5.2 Browser-Bound — Copy and CTA (Immediate, No Infra Required)

**File:** `/home/user/code/pdpp/apps/console/src/app/dashboard/lib/source-setup-presentation.ts`

Current `browser_bound_runbook` guidance: "Browser setup will move into the dashboard. Existing collected data remains usable; the packaged in-dashboard add path is still pending."

**Change guidance to:** "This source collects data by driving your logged-in browser session locally. Existing data is usable. To add an account or re-authenticate now, follow the [browser-collector runbook]. In-dashboard setup is tracked and coming."

**Change action** for `browser_bound_runbook` (currently returns `null`):  
Return a CTA with `href: BROWSER_BOUND_RUNBOOK_PATH` and `label: "Open runbook"` — turning the dead end into a real forward path.

**Current `browser_collector_manual` guidance** is identical ("Packaged path pending"). Same fix applies.

**What's needed:** 3-line change in `source-setup-presentation.ts` + a `sourceSetupAction` case for the two browser-bound dispositions. No server changes.

**Tests that need updating:** `source-copy-negative.test.ts` pins the forbidden copy set. The new guidance must not contain any forbidden strings — it doesn't. The `forward-disposition.test.ts` may pin that `browser_bound_runbook` returns `null` for `sourceSetupAction`; if so, that test needs updating to expect the runbook link.

### 5.3 Browser-Bound — Full In-Dashboard Setup (Post-Neko Infra, Multi-Slice)

This is the Phase 5 design already specced in the codebase (found in session memory as "RI Browser Dashboard Setup v1"). The slices:

- **Slice 1 (done):** Two-gate honesty model + packaged-pending copy floor. Already committed.
- **Slice 2 (server, owner gate):** The browser-enrollment-shell route (`ref-browser-enrollment-shell.ts`) is already built and tested. OpenSpec delta to `reference-connector-instances` is needed — this is the stop boundary. **Already done** per `ref-browser-enrollment-shell.ts` existing in tree.
- **Slice 3 (enrollment run):** Bounded enrollment run (session-establish mode, not full collect). The run-target registry, surface allocator, and run-interaction route all exist. New: a connector "enrollment-only" run mode that drives login and emits identity without ingesting all records.
- **Slice 4 (console surface):** `/dashboard/connect/browser-session/[connectorId]` page. Creates shell, starts enrollment run, embeds `StreamSurface` from the existing stream viewer. This is the user-visible "log in in your browser" surface.
- **Slice 5 (flip + proof):** Per-connector live proof run → flip `browser_bound_runbook` → `browser_session_connect` (or equivalent). Proof must be committed as one reviewable unit with the flip.
- **Slice 6 (repair/reconnect):** The `?connectionId=existing` mode on the connect page. Small, once slices 1–5 are done.

**Fix surface for Slice 4:**
- New file: `/home/user/code/pdpp/apps/console/src/app/dashboard/connect/browser-session/[connectorId]/page.tsx`
- Reuse: `apps/console/src/app/dashboard/runs/[runId]/stream/stream-viewer.tsx` → `StreamSurface` component
- Server action: calls `POST /_ref/connectors/:connectorId/browser-enrollment-shell` + enrollment run start
- `sourceSetupAction` for `browser_session_connect` disposition: returns `href: /dashboard/connect/browser-session/[connectorId]`, `label: "Connect"`

**Fix surface for `sourceSetupAction` to add runbook CTA (today):**
```
case "browser_bound_runbook":
case "browser_collector_manual":
  return { href: BROWSER_BOUND_RUNBOOK_PATH, label: "Open runbook" };
```

### 5.4 Browser-Bound — Repair CTA on Connection Detail (Post-Neko)

**File:** Connection detail page (wherever connection health + `needs_attention` state is shown).  
**Change:** When `disposition ∈ BROWSER_BOUND_CONNECTORS` and state is `needs_attention`, show a banner: "Session expired. Reconnect to resume collection." with a "Reconnect" button → `/dashboard/connect/browser-session/[connectorId]?connectionId=[existing]`.

The existing static-secret repair pattern (§8.3 of `slvp-ideal-connector-self-service-setup-2026-06-14.md`) applies here: same CTA shape, different target page.

---

## 6. The Disposition Map — Where Each Connector Ends Up

| Connector | Today | Pre-neko ideal | Post-neko ideal |
|-----------|-------|----------------|-----------------|
| amazon | `browser_bound_runbook` → "Packaged path pending", null CTA | `browser_bound_runbook` → "Needs local setup", "Open runbook" CTA | `browser_session_connect` → "Connect", neko-embedded flow |
| usaa | `browser_bound_runbook` → same | same | same |
| chase | `browser_bound_runbook` → same | same | same |
| chatgpt | `browser_bound_runbook` → same | same | same |
| reddit | `browser_collector_manual` → "Packaged path pending", null CTA | `browser_collector_manual` → "Needs local setup", "Open runbook" CTA | `browser_session_connect` → "Connect" (or promoted to `static_secret_connect` if Reddit API key path proven) |
| codex | `local_collector_enroll` → "Add now", enrollment form ✅ | no change | no change |
| claude-code | `local_collector_enroll` → "Add now", enrollment form ✅ | no change | no change |

---

## 7. Adversarial Self-Check

**Objection 1: "The neko flow is complex — should we just leave browser-bound as packaged-path-pending and focus on the runbook?"**

Counter: The existing copy IS honest. The problem is it gives the owner no path forward. "Packaged path pending" with no CTA leaves the owner with zero actionable next step. Plaid, Nango, and every personal data tool agree: even a broken state must have a repair CTA. The pre-neko fix (runbook CTA) costs < 10 lines of code and eliminates the dead end today.

**Objection 2: "The neko browser flow requires the owner to run neko. If neko isn't deployed, the full flow fails."**

Counter: This is true and must be respected by the disposition gate. The fix is NOT to show "Connect" unless `canUseBrowserSessionEnroll()` is confirmed true (server health check on neko availability). Until neko is deployed, the disposition stays `browser_bound_runbook` — but with the runbook CTA added. No new dead end, no dishonest promise.

**Objection 3: "These browser-bound connectors (usaa, chase) require the owner to be logged into their bank in the neko browser. This is fundamentally interactive and can't be automated."**

Counter: Correct, and the design accommodates this. The neko surface is interactive — the owner drives it. The embedding in the dashboard is not a "click and it happens automatically" flow; it is "click, a browser window opens in the dashboard, log in, and PDPP captures the session." This is exactly the Plaid Link model. The owner is always the one who authenticates — PDPP just provides the hosted browser.

**Objection 4: "Reddit might have an API now. Should it be static-secret?"**

Counter: Reddit has an OAuth API (not just a PAT). If `reddit` gets a credential_capture block pointing at the Reddit OAuth or a personal use script token, it can promote to `static_secret_connect` — and the browser-collector path becomes redundant. This is a valid parallel track. The browser-bound status is correct for Reddit's current manifest classification; if the manifest gains OAuth support, the disposition would update automatically via the planner.

---

## 8. Sources

1. Plaid Link update mode — https://plaid.com/docs/link/update-mode/ (fetched 2026-06-14)
2. Plaid Link overview — https://plaid.com/docs/link/ (fetched 2026-06-14)
3. Tailscale machine enrollment — https://docs.tailscale.com/kb/1123/machine-enrollment/ (fetched 2026-06-14)
4. Tailscale key expiry (from prior research) — https://tailscale.com/kb/1028/key-expiry
5. PDPP source: `reference-implementation/server/routes/ref-browser-enrollment-shell.ts` — browser-enrollment shell routes, 2h TTL, owner-session cookie security model
6. PDPP source: `reference-implementation/server/connection-setup-plan.ts` — `BROWSER_BOUND_CONNECTORS`, `isBrowserBoundConnector`, `BROWSER_BOUND_RUNBOOK_PATH`
7. PDPP source: `apps/console/src/app/dashboard/device-exporters/` — enrollment form, deep-link handling, `BrowserBoundEnrollmentNotice`
8. PDPP source: `apps/console/src/app/dashboard/lib/source-setup-presentation.ts` — disposition → copy/CTA/tone mapping
9. PDPP source: `apps/console/src/app/dashboard/lib/connection-modality.ts` — console-side modality projection
10. PDPP source: `apps/console/src/app/dashboard/runs/[runId]/stream/` — neko streaming viewer, already built and used for assisted-refresh runs
11. PDPP source: `docker/neko/` — neko/Patchright browser container, Dockerfile, neko.yaml config
12. Prior session research: "Onboarding Capability Inventory" worker report — neko seams, surface allocator, run-target registry
13. Prior session research: "RI Browser Dashboard Setup v1" worker report — Phase 5 slices, what exists vs. what is missing
14. Plaid screen-scraping context — https://quatrohive.com/plaids-screen-scraping-gamble-how-a-6b-bet-reshaped-global-fintech-infrastructure/ (cited in prior research)
15. `slvp-ideal-connector-self-service-setup-2026-06-14.md` — static-secret prior art, Plaid repair gold standard (§2.3), no-dead-ends principle (§6), edit/repair gap (§8.3)
