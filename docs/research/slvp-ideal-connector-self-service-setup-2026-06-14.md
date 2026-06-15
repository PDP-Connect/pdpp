# SLVP-Ideal Connector Self-Service Setup, Edit, and Repair

**Date:** 2026-06-14  
**Status:** Final — adversarially verified  
**Confidence:** 95%

---

## 1. The Problem

PDPP has a working, manifest-driven connector setup system for static-secret connectors (Gmail, GitHub, Slack). A connector that declares `setup.credential_capture` in its manifest gets a real in-UI form. A connector that omits it is classified as `not_self_service` and shown "Not supported yet" — a dead end with no owner path forward.

YNAB is the exemplar gap. It has:
- A full working connector (`packages/polyfill-connectors/connectors/ynab/index.ts`)
- 22,593 real records collected
- A correct injection entry in `STATIC_SECRET_CONNECTOR_REGISTRY` (maps `YNAB_PERSONAL_ACCESS_TOKEN` / `YNAB_PAT`)
- A proven store path (noted in connection-setup-plan.ts: "ynab store path also proven; token is provider-side dead — not a capture-path failure")

But its manifest (`packages/polyfill-connectors/manifests/ynab.json`) has no `setup.modality` and no `setup.credential_capture`, so `classifyConnectorSetupModality()` falls through the `api_network` branch, finds no credential_capture, and returns `"unsupported"`. The owner sees "Not supported yet."

The same gap exists for any static-secret connector missing a credential_capture block, and in a different form for connectors that are genuinely browser-bound, OAuth-pending, etc. — which today just show dead ends.

the owner's demand: *"all connectors should be editable in the UI by now including YNAB"* — and the bar is SLVP-ideal, not acceptable.

---

## 2. Prior Art — How SLVP Products Model Connector Setup, Edit, and Repair

### 2.1 Airbyte — The Schema-Driven Form Standard

**Architecture:** Every Airbyte connector ships a `connectionSpecification` — a JSONSchema document embedded in the connector's `spec.json`. Airbyte's UI auto-renders this schema as an input form. The spec declares:
- Field names, labels, types, `description`, `examples`, `placeholder`
- `airbyte_secret: true` to mark fields that should be masked (rendered as password inputs, never echoed in API responses)
- `oneOf` for multi-mode auth (e.g., OAuth vs. API key as alternative credential types)
- `order` for field sequencing in the rendered form

**Source:** https://docs.airbyte.com/connector-development/connector-specification-reference  
**Protocol ref:** https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol (Actor Specification section)

**Key insight:** The UI renders any spec it is given. There is no per-connector UI code. A new connector gets a form for free by declaring its spec. Airbyte can even render a live preview of the spec form in a Storybook component while you develop it.

**Edit/repair:** Airbyte's "Edit source" flow re-renders the same spec form pre-populated with the existing non-secret values. Secrets are omitted from pre-population (never echoed) but a masked placeholder indicates they are set. The owner re-enters only what changed. No separate "edit" vs. "repair" UI — one form handles all three flows.

**No dead ends:** Connectors in a disconnected/error state show the same edit form with an error banner explaining what failed. The owner is always one form submission away from re-activating.

### 2.2 Nango — Managed Auth + Per-Connector Config Fields

**Architecture:** Nango stores a `providers.yaml` (its equivalent of manifests) that declares per-provider auth type, credential fields, and connection configuration fields (e.g., subdomain, tenant ID). Nango's pre-built Connect UI auto-renders the required input fields from this config for any provider.

**Source:** https://docs.nango.dev (full docs: https://nango.dev/docs/llms-full.txt)

For API-key / static-token auth (non-OAuth), Nango's Connect UI shows a form with the credential fields declared for that provider. For headless auth (custom UI), the developer must build the form themselves but Nango still handles storage and validation.

**Credential validation on entry:** Nango performs credential checks at capture time for providers that support it — it rejects invalid credentials before storing them. Error state: `invalid_credentials`. This is the "Zapier test step" pattern: validate before commit, never store a known-bad secret.

**Re-authorization flow:** When a connection enters `invalid_credentials` state:
1. Nango fires a webhook (auth webhook, revoked token event)
2. The host app shows a **Reconnect** button
3. A reconnect session token is generated on the backend
4. The same frontend auth flow is opened with the reconnect token (operation = `override`)
5. On success, Nango fires an `auth` webhook with `operation = override` — the same `connection_id` is preserved

**Critical pattern:** Repair is architecturally identical to setup — same flow, same UI, same API — just triggered on an existing `connection_id` instead of creating a new one. There is no separate "repair mode" UI. The credential is replaced in place; the connection ID, history, and schedule are preserved.

**Source:** Nango full docs — re-authorize section: https://nango.dev/docs/guides/auth/auth-guide#re-authorize-an-existing-connection

### 2.3 Plaid — The Gold Standard for Repair UX

Plaid is the canonical reference for the "repair" (not just setup) flow. Key patterns:

**Item lifecycle state machine:** A Plaid Item has exactly one state at a time:
- `HEALTHY` — collecting normally
- `PENDING_EXPIRATION` — credential will expire soon (7-day warning, UK/EU)
- `ITEM_LOGIN_REQUIRED` — credential expired/revoked; owner must re-enter
- Generic `ERROR` — other failure

**Update mode (repair flow):** When an Item hits `ITEM_LOGIN_REQUIRED`, the host app opens Link in "update mode" — the same Plaid Link component used for initial setup, but scoped to the specific Item. The user re-authenticates. Only the minimum required re-auth steps are shown (if only an OTP expired, only the OTP is re-asked).

**`LOGIN_REPAIRED` webhook:** When the Item exits the broken state — even if the repair happened in a different app — Plaid fires `LOGIN_REPAIRED`. The host app is told to stop showing the repair CTA. This is the cleanest "recovery is a state transition, not a button click" pattern in production.

**Key design choice:** Plaid does NOT retry on `ITEM_LOGIN_REQUIRED`. The item sits broken until the owner acts. The error is presented as a clear, actionable state with a single repair CTA — not buried in logs.

**Source:** https://plaid.com/docs/link/update-mode/

### 2.4 Stripe — Credential Masking and Rotation UX

Stripe's API key management defines the gold standard for credential display and rotation:

**Never echo a secret:** In live mode, Stripe shows a secret key exactly once — at creation time. It cannot be revealed later. If lost, rotate (revoke + issue replacement).

**Rotate (not delete+recreate):** Stripe provides atomic key rotation — the old key is revoked and a replacement is generated in one operation, with no downtime window between. Scheduled rotation is also supported.

**Masked display:** Existing keys are shown as `sk_live_...****` — the prefix is visible for identification, the body is masked. This lets the owner confirm which key is in use without exposing the secret.

**Restricted keys:** Stripe supports scoped keys with explicit permission sets, making it safe to create purpose-limited credentials for specific integrations.

**Source:** https://stripe.com/docs/keys

### 2.5 Merge — Embedded Link + Re-auth

Merge Link is an embedded iFrame component that handles the complete auth flow for any integration. For re-authentication, Merge provides a re-link URL that re-opens the same Link flow for a specific Linked Account. The Linked Account ID and all collected history are preserved; only the credential is refreshed.

Merge's architecture is noteworthy because the auth UI is entirely driven by integration metadata — there is no per-integration UI code in the host app.

**Source:** https://docs.merge.dev/merge-unified/merge-link/overview/

### 2.6 Linear / Vercel — API Token Setup UX

Both Linear and Vercel use a simple, universal pattern for API token-based integrations:
- Clear instruction text: where to find the token, what scope to request
- A `type="password"` input (masked, no autocomplete)
- A "Test connection" or "Verify token" step before saving
- After save: the token is never shown again; a masked indicator shows it is set
- To rotate: "Regenerate" or "Replace token" — a new input field appears, the old is overwritten on submit

This matches the PDPP `credential_capture` field model exactly.

---

## 3. The Ideal Architecture — Verdict

**MANIFEST-DRIVEN SETUP FORM IS THE SLVP-IDEAL PATTERN. Confidence: 95%.**

The convergent answer across Airbyte (connectionSpecification), Nango (providers.yaml + Connect UI), Merge (Link), and PDPP's own existing pattern (credential_capture) is identical:

> Every connector declares its credential fields in a schema. A single generic UI component renders any schema as a form. No connector ever has a dead end — the form handles setup, edit, and repair identically.

PDPP already has this architecture. The `credential_capture` block in a manifest is PDPP's equivalent of Airbyte's `connectionSpecification`. The `static-secret` connect page already renders any `credential_capture` schema generically. The infrastructure is complete. The gap is purely manifest coverage — connectors that are registered as static-secret but are missing the `credential_capture` declaration.

---

## 4. The Setup / Edit / Repair State Model

The SLVP ideal collapses these three flows into ONE form with a context-aware trigger:

| Flow | Trigger | What's different | Connection ID |
|------|---------|-----------------|---------------|
| **Setup** | Owner adds new connection | No pre-population; new connection ID created on submit | New |
| **Edit** (credential rotation) | Owner chooses "Update credential" on a healthy connection | Non-secret fields pre-populated; secret field empty with "••• set" indicator | Preserved |
| **Repair** | Connection enters `needs_attention` / `blocked` state; owner clicks "Reconnect" CTA | Same form as edit; error context shown ("Your YNAB token was rejected — it may have been revoked") | Preserved |

**The key Plaid/Nango insight:** Repair is not a separate flow — it is edit triggered from an error state. The connection ID, all history, and the schedule are preserved. Only the stored credential is replaced.

**The Stripe insight:** The secret is never pre-populated and never echoed. The form shows a masked "set" indicator for existing connections, not the actual secret.

**PDPP's existing connection-setup-plan.ts already specifies this:** "the reference SHALL replace the stored secret and record a rotation timestamp AND the connection, its `connection_id`, its history, and its schedule SHALL be preserved."

---

## 5. Validation on Entry — The Zapier Test Step Pattern

PDPP already implements this correctly for Gmail and GitHub via the `probeCredential` hook in `credential-probe.ts`. The SLVP ideal:

1. Owner submits the credential form
2. A bounded synchronous call (≤10s) validates the credential against the provider: IMAP LOGIN for Gmail, `GET /user` for GitHub, `GET /user` for YNAB
3. On success: echoes non-secret account identity ("Connected as @youraccount in YNAB")
4. On failure: returns a typed error with owner-causal copy ("YNAB rejected this token — it may have been revoked. [Create a new token ↗]"); stores NOTHING; form state preserved
5. The credential is stored only after the probe succeeds

This is identical to Nango's credential check at capture time and Airbyte's source testing step.

**For connectors without a probe:** The flow degrades gracefully — credential is stored, connection activates at `first_sync`, failure at first sync carries the repair CTA. This is honest and correct. Forcing every connector to implement a probe before it can have a UI form would be wrong — it would create exactly the dead ends we are eliminating.

---

## 6. The "No Dead Ends" Principle — Honest Fallback for Genuinely Unsupported Connectors

Not every connector can be fully self-service today. The SLVP ideal handles each case without a dead end:

| Connector class | Current PDPP | SLVP-ideal treatment |
|----------------|-------------|---------------------|
| Static-secret (PAT/API key) | "Not supported yet" if missing credential_capture | Manifest declares credential_capture → generic form, immediate setup |
| Browser-bound (ChatGPT, Chase, etc.) | "Packaged path pending" + runbook link | Correct: named state, named blocker, link to runbook. This is honest. |
| OAuth (not yet proven) | "Not supported yet" | Named state ("OAuth setup pending"), link to setup docs or issue tracker; NOT a blank dead end |
| Genuinely inaccessible | — | "Data not available via API" with a brief explanation. Still not a blank wall. |

The key principle: every dead-end "Not supported yet" must be replaced with either (a) a working form, or (b) an honest named state with a path — a runbook link, a documentation link, a "notify me when available" affordance, or a clear explanation. The owner must never be left wondering "is this a bug or a product decision?"

---

## 7. Adversarial Self-Check — Strongest Case Against Full Generalization

**The objection:** Some connectors legitimately cannot be self-service. Browser-bound connectors (ChatGPT, Chase, Amazon) require a desktop session capture tool; a web form cannot collect the credential. Forcing a `credential_capture` block on them would be dishonest — the form would exist but the connector would still fail.

**The answer:** Full generalization does NOT mean every connector gets a static-secret form. It means every connector's manifest truthfully declares how it IS set up, and the UI renders that declaration honestly. The three-tier model:

1. **Static-secret connectors with `credential_capture`:** get the form (YNAB, Reddit, YNAB)
2. **Browser-bound connectors:** get the packaged-path-pending state with runbook — correct today
3. **OAuth connectors pending proof:** get a named "OAuth setup pending" state, NOT "Not supported yet"

The generalization being proposed is not "make every connector a form." It is "make every connector's manifest truthful about what it needs, and make the UI always render that truth into a path — never a blank wall."

**The remaining real limit:** Connectors that haven't been written yet, or where PDPP genuinely has no collection path (e.g., a closed API with no public access), are honestly labeled "not available" with an explanation. The bar is "honest + provides a path or explanation" — not "all connectors collect data today."

---

## 8. Exact Fix Surface for PDPP

### 8.1 YNAB — The Immediate Fix (One Manifest Block)

YNAB's manifest at `packages/polyfill-connectors/manifests/ynab.json` needs a `setup` block added at the top level (alongside the existing `human_interaction`, `refresh_policy`, `public_listing`):

```json
"setup": {
  "modality": "static_secret",
  "credential_capture": {
    "kind": "personal_access_token",
    "label": "YNAB personal access token",
    "description": "Use a YNAB Personal Access Token for the budget account this connection should collect.",
    "submit_label": "Create YNAB connection and start first sync",
    "fields": [
      {
        "name": "secret",
        "label": "YNAB Personal Access Token",
        "type": "password",
        "required": true,
        "secret": true,
        "autocomplete": "off",
        "help_url": "https://app.ynab.com/settings/developer",
        "help_text": "Create a Personal Access Token in your YNAB developer settings, then paste it here.",
        "env": [
          "YNAB_PERSONAL_ACCESS_TOKEN",
          "YNAB_PAT"
        ]
      }
    ]
  }
}
```

This is the COMPLETE fix for YNAB. No server code, no UI code — the infrastructure already handles it. After this change:
- `classifyConnectorSetupModality("ynab", manifest)` returns `"static_secret"` (because `staticSecretCredentialCaptureFromManifest(manifest)` finds the block)
- `buildConnectorCatalog` produces disposition `"static_secret_connect"`
- `addAccountSupport` returns `"self_service"`
- `sourceSetupAction` returns `href: /dashboard/connect/static-secret/ynab, label: "Add account"`
- The existing connect form renders the field
- `buildConnectionScopedSecretEnv("ynab", ...)` already knows the env var names

The only missing piece after this: adding YNAB to `STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS` in `connection-setup-plan.ts` once an end-to-end proof run succeeds (same pattern as gmail/github/slack). Until then, YNAB gets a real form but with `proofGate: "static_secret_live_proof_missing"` — the UI will show the form but with a warning. Given that the YNAB store path is already noted as proven in the comments, this proof should be straightforward.

**Additionally:** add a `probeCredential` transport for YNAB in `credential-probe-transport.ts`. YNAB's API: `GET https://api.ynab.com/v1/user` with `Authorization: Bearer <token>`. Returns `{ data: { user: { id } } }`. This gives the "Connected as YNAB account <id>" echo. Without the probe, the form still works — it just validates at first sync instead of at entry.

### 8.2 General Fix Surface — All Unblocked Static-Secret Connectors

The pattern for any static-secret connector missing credential_capture:

1. **Add `setup.modality: "static_secret"` and `setup.credential_capture` to the manifest** — follows the github.json shape exactly
2. **Verify the connector is in `STATIC_SECRET_CONNECTOR_REGISTRY`** (static-secret-injection.ts) — if not, add it
3. **Add to `STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS`** after a successful end-to-end proof run
4. **Optionally add a `probeCredential` transport** for the "Connected as X" confirmation at entry

### 8.3 Edit and Repair Flows — What Exists vs. What Is Missing

**What already exists:**
- The `static-secret` connect form renders any `credential_capture` schema (setup done)
- The connection store spec says credential rotation preserves `connection_id` and history

**What is missing (the UX debt registered at P2):**
- No "Update credential" affordance on an existing healthy connection's detail page
- No "Reconnect" CTA on a connection in `needs_attention` / `blocked` state that links back to the credential form
- No `?connectionId=<existing>` parameter on the static-secret form that switches it from "create new" to "replace credential on existing connection" mode

The SLVP ideal for repair: on the connection detail / records page, when connection state is `needs_attention` or `blocked`:
- Show a banner: "This connection needs your attention — the credential was rejected. [Re-enter credential →]"
- The link goes to `/dashboard/connect/static-secret/<connectorId>?connectionId=<existingId>`
- The form renders identically to setup, but on submit it calls a PATCH/replace-credential endpoint instead of POST/create-connection
- The connection ID, history, and schedule are preserved; only the stored secret is replaced

For OAuth connectors, the equivalent is a "Reconnect" CTA that re-initiates the OAuth flow for the existing `connection_id`.

---

## 9. The Disposition Collapse

Under the SLVP ideal, the "not_self_service" dead-end class should shrink to near-zero. The current disposition map:

| Disposition | addAccountSupport | SLVP-ideal change |
|------------|------------------|-------------------|
| `local_collector_enroll` | `self_service` | No change needed |
| `static_secret_connect` | `self_service` | No change needed; EXPAND membership (add YNAB etc.) |
| `manual_upload_connect` | `self_service` | No change needed |
| `browser_collector_manual` | `packaged_path_pending` | No change; honest + runbook |
| `browser_bound_runbook` | `packaged_path_pending` | No change; honest + runbook |
| `manual_upload_pending` | `packaged_path_pending` | No change; honest + path |
| `provider_auth_deployment_blocked` | `deployment_prerequisite` | No change; honest blocker |
| default (incl. YNAB today) | `not_self_service` | FIX: each connector in this bucket should either (a) get a credential_capture block and move to `static_secret_connect`, or (b) get an explicit disposition with an honest named state and a path |

---

## 10. Sources

| Source | URL | Retrieved |
|--------|-----|-----------|
| Airbyte connector specification reference | https://docs.airbyte.com/connector-development/connector-specification-reference | 2026-06-14 |
| Airbyte protocol (connectionSpecification) | https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol | 2026-06-14 |
| Nango docs (full) | https://nango.dev/docs/llms-full.txt | 2026-06-14 |
| Nango docs index | https://docs.nango.dev/llms.txt | 2026-06-14 |
| Plaid Link update mode | https://plaid.com/docs/link/update-mode/ | 2026-06-14 |
| Plaid quickstart | https://plaid.com/docs/quickstart/ | 2026-06-14 |
| Stripe API keys | https://stripe.com/docs/keys | 2026-06-14 |
| Stripe Connect overview | https://stripe.com/docs/connect/ | 2026-06-14 |
| Vercel integration install | https://vercel.com/docs/integrations/install-an-integration | 2026-06-14 |
| Merge Link overview | https://docs.merge.dev/merge-unified/merge-link/overview/ | 2026-06-14 |
| PDPP source-setup-presentation.ts | apps/console/src/app/dashboard/lib/source-setup-presentation.ts | local |
| PDPP connection-setup-plan.ts | reference-implementation/server/connection-setup-plan.ts | local |
| PDPP static-secret-injection.ts | packages/polyfill-connectors/src/static-secret-injection.ts | local |
| PDPP credential-probe-transport.ts | packages/polyfill-connectors/src/credential-probe-transport.ts | local |
| PDPP manifests (github.json, gmail.json, ynab.json) | packages/polyfill-connectors/manifests/ | local |
