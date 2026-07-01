# Connector Credential And Session Repair Prior Art

Date: 2026-07-01
Status: research corpus
Scope: reference-implementation browser/polyfill connectors, stored credentials, reusable sessions, scheduled collection, owner repair flows

## Question

What should the reference implementation do when a scheduled connector run can no longer use the connection's stored credential or reusable browser/session state?

## Sources

- Plaid, "Updating Items via Link", retrieved 2026-07-01: https://plaid.com/docs/link/update-mode/
- Plaid, "Items API / webhooks", retrieved 2026-07-01: https://plaid.com/docs/api/items/
- Google, "Using OAuth 2.0 to Access Google APIs", retrieved 2026-07-01: https://developers.google.com/identity/protocols/oauth2
- Zapier, "Manage your app connections", retrieved 2026-07-01: https://help.zapier.com/hc/en-us/articles/8496290788109-Manage-your-app-connections
- Nango, "Google OAuth invalid grant: Token has been expired or revoked", retrieved 2026-07-01: https://nango.dev/blog/google-oauth-invalid-grant-token-has-been-expired-or-revoked
- Nango, "Xero OAuth refresh token invalid_grant", retrieved 2026-07-01: https://nango.dev/blog/xero-oauth-refresh-token-invalid-grant/
- OpenAI Help Center, "Why am I receiving a 'Suspicious Activity Alert?'", retrieved 2026-07-01: https://help.openai.com/en/articles/10471992-why-am-i-receiving-a-suspicious-activity-alert
- OpenAI Help Center, "How can I keep my OpenAI accounts secure?", retrieved 2026-07-01: https://help.openai.com/en/articles/8304786-how-can-i-keep-my-openai-accounts-secure

## Findings

### 1. Repair is a connection lifecycle, not a failed-run detail

Plaid's update mode is explicitly for an existing Item after initial creation. It covers credential updates, expired authorization, additional consent, and OAuth permission restoration. Plaid says an `ITEM_LOGIN_REQUIRED` error or expiration/disconnect webhook means the Item should be sent through update mode, and that applications should ask the user to re-authenticate before continuing. The important shape is not "retry the failed job"; it is "put the existing connection into a repair flow".

Zapier's app-connection surface follows the same product model: connections have statuses such as active and expired, the owner can test a connection, and an expired connection gets a Reconnect action. Reconnecting applies to workflows using that connection. The problem is communicated at the connection level, not buried in an individual run timeline.

Implication for PDPP RI: a stored credential rejection or unusable session should set connection-level repair state. The next scheduled tick should see that state and defer, not submit the same stale credential again.

### 2. Password changes and policy changes are expected invalidation causes

Google documents that refresh tokens can stop working because of user actions and policy settings, including password changes for tokens with Gmail scopes, access revocation, long inactivity, token limits, time-bounded access, and admin session-length policy. OpenAI's own account-security guidance includes changing passwords, enabling 2FA, signing out of all devices, and clearing cookies/cache when suspicious activity persists; it also documents a "log out of all sessions" control that can take up to 30 minutes to propagate.

Implication for PDPP RI: the system should expect "was working yesterday, now needs repair" as a normal lifecycle transition. It should not treat repeated invalid credentials or logged-out browser sessions as surprising transient failures.

### 3. Terminal credential failures should stop retry storms

Nango's production guidance for OAuth `invalid_grant` is consistent across providers: retry once for rare partial failures, then mark the connection as needing re-auth, pause background syncs, and ask the user to reconnect in-product. It calls out stale-token and refresh-concurrency problems, but the product posture is the same once the stored secret is known unusable: do not keep retrying the same credential.

Implication for PDPP RI: when a connector has definitive provider evidence that a stored username/password or token is rejected, the stored credential must stop being considered usable for unattended runs until repaired or rotated.

### 4. Repair flow should be scoped to the existing connection

Plaid update mode is initialized for the existing Item; it does not create a duplicate Item. Zapier's reconnect action updates the existing app connection and its dependent workflows. Plaid also supports self-healing signals such as `LOGIN_REPAIRED`, telling applications to dismiss repair messaging if the Item is fixed elsewhere.

Implication for PDPP RI: repair should preserve the connector instance and record history. If the owner repairs the browser session or rotates a stored secret, the action should update the existing connection's credential/session state, clear the connection-level repair item, and resume eligible schedules.

### 5. The repair path must match the credential/session mechanism

For OAuth-style credentials, the repair path is reauthorization/update mode. For browser-session connectors, there are two distinct states:

- reusable browser/session state may be healthy even when no stored password is available;
- a stored username/password may be stale even if the browser happens to be logged in.

Implication for PDPP RI: copy and actions must not collapse these. A connection with a stored password that was rejected needs an explicit "update saved credential" or "repair stored login" path, not copy that says no credentials are stored. A browser-only connection can legitimately use a session-only "reconnect browser session" path.

## SLVP-Ideal Product Design For The RI

The reference implementation should model connector auth health as a small state machine:

- `ready`: the connection has a usable credential or reusable session for its configured refresh policy.
- `repair_required`: the last definitive auth result says the connection cannot continue without owner action.
- `repair_in_progress`: an owner-started flow is running and may update the connection's credential/session state.
- `repaired`: the owner repair flow completed and a verification probe proved the connection can authenticate again.

Scheduled runs are allowed only in `ready` or after `repaired` is promoted back to `ready`. A scheduled run that encounters a definitive auth rejection transitions the connection to `repair_required`, emits at most one owner-visible action for that state transition, and suppresses further automatic auth attempts until the owner repairs or dismisses/reconfigures the connection.

Owner-started repair must be connection-scoped and mechanism-specific:

- session-only/browser repair captures verified session state and does not claim to store a password;
- stored-secret repair rotates the stored credential atomically, records the rotation, and then runs an auth probe before clearing the repair item;
- mixed connectors can support both, but the UI must say which one the owner is doing.

## Non-Goals

- Do not silently capture a password typed into a browser panel unless the owner explicitly started a stored-credential capture/rotation flow.
- Do not create a duplicate connection to repair an existing one.
- Do not keep hourly scheduled runs submitting a credential that has already been rejected.
- Do not make "age of attention row" the primary truth for open vs. closed repair state. Age can suppress stale UI artifacts, but connection state must be closed by terminal/repaired/dismissed transitions.

