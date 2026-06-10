# Connection Onboarding Prior Art — 2026-06-10

**Status:** Captured
**Owner:** Research worker (for PDPP self-service connection onboarding design)
**Created:** 2026-06-10
**Scope:** UX patterns for "add a data source account" flows — directly informing PDPP's flow where an owner connects sources like Gmail, GitHub, Amazon, Chase, and ChatGPT via pasted credentials/tokens or interactive browser login.

---

## Sources

| Label | URL | Retrieved |
|-------|-----|-----------|
| plaid-link-docs | https://plaid.com/docs/link/ | 2026-06-10 |
| plaid-link-web | https://plaid.com/docs/link/web/ | 2026-06-10 |
| plaid-link-oauth | https://plaid.com/docs/link/oauth/ | 2026-06-10 |
| plaid-link-update-mode | https://plaid.com/docs/link/update-mode/ | 2026-06-10 |
| plaid-errors | https://plaid.com/docs/errors/ | 2026-06-10 |
| plaid-link-customization | https://plaid.com/docs/link/customization/ | 2026-06-10 |
| plaid-returning-user | https://plaid.com/docs/link/returning-user/ | 2026-06-10 |
| stripe-connect-onboarding | https://stripe.com/docs/connect/onboarding | 2026-06-10 |
| stripe-hosted-onboarding | https://stripe.com/docs/connect/hosted-onboarding | 2026-06-10 |
| stripe-embedded-onboarding | https://stripe.com/docs/connect/embedded-onboarding | 2026-06-10 |
| stripe-api-verification | https://stripe.com/docs/connect/handling-api-verification | 2026-06-10 |
| zapier-connect-app | https://zapier.com/help/create/basics/connect-your-app-to-zapier | 2026-06-10 |
| zapier-manage-connections | https://zapier.com/help/manage/user-settings/manage-connections | 2026-06-10 |
| zapier-connection-errors | https://zapier.com/help/create/basics/troubleshoot-connection-errors-in-zapier | 2026-06-10 |
| zapier-zap-action | https://zapier.com/help/create/basics/set-up-your-zap-action | 2026-06-10 |
| notion-import | https://notion.so/help/import-data-into-notion | 2026-06-10 |
| github-importer | https://docs.github.com/en/migrations/importing-source-code/using-github-importer/importing-a-repository-with-github-importer | 2026-06-10 |
| github-importer-about | https://docs.github.com/en/migrations/importing-source-code/using-github-importer/about-github-importer | 2026-06-10 |

**Note on Zapier:** Zapier's help center pages are SPA-rendered; plain HTTP fetches returned only navigation chrome, not body content. Details marked *[inferred]* are reconstructed from partial source text and cross-referenced with widely documented Zapier behavior; they are not confirmed by a direct source quote.

---

## 1. Plaid Link — Canonical Financial Account Connection Modal

### 1.1 Flow structure

Plaid Link is a modal (or embedded iframe) flow with a documented set of view states. The canonical non-OAuth flow proceeds through these named views, which are exposed as `onEvent` `TRANSITION_VIEW` events:

**Step 1 — CONSENT**
Opening screen. Displays the app name, Plaid branding (or co-branded with the app's logo/color), and a standardized privacy disclosure: "[App name] uses Plaid to connect your [account type]." A link to Plaid's end-user privacy policy is shown. The user must acknowledge before proceeding. If the *Returning User Experience* is enabled, the user may optionally enter their phone number here to be "remembered" for faster reconnects across participating apps.

**Step 2 — SELECT_INSTITUTION**
Search-first institution picker. The user types to filter across thousands of institutions. Popular/recent institutions may appear as tiles without search. The `SELECT_INSTITUTION` event fires with institution id and name when the user picks one.

**Step 3 — CREDENTIAL**
Per-institution credential entry form. For most institutions: username + password matching the institution's online banking login. The institution's logo is shown prominently. Plaid does not store credentials beyond the session; they are passed directly to the institution's API.

**Step 4 — LOADING**
Intermediate state while Plaid authenticates against the institution. No time estimate shown.

**Step 5 — MFA** (if required)
Multi-factor authentication step. MFA types include: `code` (OTP via SMS/email), `device` (pick device to receive code), `questions` (security questions), `selections` (pick from a list). The `mfa_type` is surfaced in `onEvent` metadata.

**Step 6 — ACCOUNT_SELECT**
The user selects which accounts to share (checking, savings, credit, investment, etc.). Configurable by the integrating app as: single-account, multi-account, or all-accounts-preselected. Accounts shown with name, type, and masked number. If the institution's OAuth flow already handled account selection, this pane may be skipped.

**Step 7 — CONNECTED**
Success state. "Your [institution] account is connected." Then `HANDOFF` event fires, followed by `onSuccess`.

**OAuth path divergence (step 3 onward):** Instead of CREDENTIAL, the user sees an OAUTH screen, then `OPEN_OAUTH` fires and the user leaves Link to authenticate at the institution's own website/app. After completing OAuth and being redirected back, the flow jumps directly to CONNECTED — no CREDENTIAL or MFA steps.

Documented event sequence (non-OAuth), from plaid-link-oauth:
```
OPEN (view_name=CONSENT)
TRANSITION_VIEW (view_name=SELECT_INSTITUTION)
SELECT_INSTITUTION
TRANSITION_VIEW (view_name=CREDENTIAL)
SUBMIT_CREDENTIALS
TRANSITION_VIEW (view_name=LOADING)
TRANSITION_VIEW (view_name=MFA, mfa_type=code)
SUBMIT_MFA
TRANSITION_VIEW (view_name=LOADING)
TRANSITION_VIEW (view_name=CONNECTED)
HANDOFF
onSuccess
```

Documented event sequence (OAuth with redirect_uri), from plaid-link-oauth:
```
OPEN (view_name=CONSENT)
TRANSITION_VIEW (view_name=SELECT_INSTITUTION)
SELECT_INSTITUTION
TRANSITION_VIEW (view_name=OAUTH)
OPEN_OAUTH
... (user completes OAuth at institution) ...
TRANSITION_VIEW (view_name=CONNECTED)
HANDOFF
onSuccess
```

### 1.2 Status callbacks

Three primary callbacks are exposed to the integrating application (source: plaid-link-web):

**`onSuccess(public_token, metadata)`**
Fired once when the user successfully links an Item. `metadata` contains:
- `institution`: `{ id, name }`
- `accounts`: array of `{ account_id, name, mask, type, subtype, verification_status }`
- `link_session_id`
- `transfer_status`

The `public_token` is a short-lived token exchanged server-side for a permanent `access_token`.

**`onExit(error, metadata)`**
Fired when the user closes Link without completing, or when a Link initialization error occurs. `error` is nullable; when non-null it contains:
- `error_type`: broad category (e.g., `ITEM_ERROR`, `INSTITUTION_ERROR`, `API_ERROR`)
- `error_code`: specific code (e.g., `INVALID_CREDENTIALS`, `INSTITUTION_DOWN`)
- `error_message`: developer-readable string
- `display_message`: user-readable string, or `null` for non-user-action errors

`metadata` includes `status` (point of exit: e.g., `requires_credentials`, `requires_questions`, `requires_account_selection`, `institution_not_found`), `institution`, and `link_session_id`.

**`onEvent(eventName, metadata)`**
Fired at each view transition and user action. Stable events suitable for programmatic use: `OPEN`, `EXIT`, `HANDOFF`, `SELECT_INSTITUTION`, `ERROR`. Informational/analytics events (e.g., `SUBMIT_CREDENTIALS`, `SUBMIT_MFA`, `TRANSITION_VIEW`) are subject to change without notice. Most events fire at end-of-session, except `OPEN` and `LAYER_READY` which fire in real time.

### 1.3 OAuth path details

OAuth is required for connections to most major US banks and all European institutions (source: plaid-link-oauth):
- After institution selection, Link shows an intermediate screen explaining the redirect.
- The user is sent to the institution's own website/app.
- After OAuth completion, the institution redirects back to a `redirect_uri` registered by the Plaid integrator.
- Link resumes — the integrator re-initializes Link with the same `link_token` plus the OAuth state parameters returned in the redirect.
- CREDENTIAL and MFA steps are skipped entirely.
- Bank of America (and others) require periodic re-authorization: Plaid sends a `PENDING_DISCONNECT` webhook up to one week before forced disconnect. If the Item is not repaired via update mode within that window, it enters `ITEM_LOGIN_REQUIRED`.

### 1.4 Trust and security framing

Source: plaid-link-customization, plaid-returning-user.

- The Consent pane is standardized and controlled by Plaid, not the integrator. Headlines are product-mapped: "connects your bank account," "verifies your employment," "verifies your income." Custom copy at this step is not permitted.
- Co-branding (app logo + brand color) is supported on the Consent pane; Plaid's "Secured by Plaid" mark is always present.
- Credential entry happens inside Plaid's iframe — the integrating app never sees credentials. This is a structural trust claim, not just copy: Plaid's visual container signals that credentials are going to Plaid → institution, not to the app.
- The Returning User Experience uses an opt-in phone number + OTP to pre-match users to previously connected accounts across participating apps, further reducing credential re-entry.

### 1.5 Error and retry UX

Key error codes, from plaid-errors and plaid-link-web:

| Error code | Type | Meaning | Recovery path |
|---|---|---|---|
| `INVALID_CREDENTIALS` | `ITEM_ERROR` | Wrong username/password | In-flow: "The username or password provided were not recognized." Retry in place. |
| `ITEM_LOGIN_REQUIRED` | `ITEM_ERROR` | Credentials expired or consent revoked | Triggers update mode (see §1.6). |
| `INSTITUTION_DOWN` | `INSTITUTION_ERROR` | Institution temporarily unavailable | In-flow message; suggests retry later. |
| `INSTITUTION_NOT_RESPONDING` | `INSTITUTION_ERROR` | Slow/hung response | Similar. |
| `PRODUCTS_NOT_SUPPORTED` | `ITEM_ERROR` | Institution lacks requested product | Inline error. |
| `PRODUCT_NOT_READY` | `ITEM_ERROR` | Async data not yet available (Signal, Assets, Income) | App-side wait-and-retry; not a Link-flow error. |
| `MFA_NOT_SUPPORTED` | `ITEM_ERROR` | MFA type Link cannot handle | Inline error. |

Rule: `display_message` is populated with a human-readable string for user-action errors; it is `null` for service errors. Integrators should show a generic fallback when `display_message` is null.

### 1.6 Update mode — broken connection recovery

Source: plaid-link-update-mode.

Update mode is a re-entry flow for Items that already exist but need repair:

- **Trigger:** `ITEM_LOGIN_REQUIRED` error, password change, expired OAuth consent, or proactive re-authorization.
- **Invocation:** Re-initialize Link with a `link_token` configured with the existing Item's `access_token` (or `user_token` for multi-item users). The user lands directly at the credential or OAuth step for the specific institution — institution selection is skipped.
- **Multi-item repair:** If a user has multiple broken Items, Link surfaces the most-recently-broken one. The integrator must loop Link sessions (one `link_token` per Item) to repair all.
- **Additional permissions:** Update mode can also request new OAuth scopes or add new account types without requiring full re-authentication.
- **Pre-emptive renewal:** Update mode can be launched before expiry to proactively renew OAuth authorization.

### 1.7 Multi-account model

- A single Plaid "Item" represents one connection to one institution and may include multiple accounts (checking + savings at the same bank).
- The `onSuccess` callback returns an `accounts` array with one entry per shared account.
- The Account Select pane configuration choices: one account only, user selects multiple, or all accounts pre-selected.
- Multiple Items (connections to different institutions, or multiple logins at the same institution) each require their own Link flow and return their own `public_token`/`access_token`.

Source: plaid-link-customization, plaid-link-web.

---

## 2. Stripe Connect Onboarding — Progressive Requirements Collection

### 2.1 Two modes: hosted vs. embedded

Source: stripe-hosted-onboarding, stripe-embedded-onboarding.

**Hosted onboarding:** Stripe generates a time-limited Account Link URL (`POST /v1/account_links`). The user navigates to a Stripe-hosted page (`https://connect.stripe.com/...`), completes onboarding, and is redirected back via `return_url`. The URL expires after a few minutes; expiry or back-navigation sends the user to `refresh_url`.

**Embedded onboarding:** The `<account-onboarding>` Connect JS component is rendered within the platform's own UI. No redirect; the user never leaves the platform's domain. The component is initialized via `stripeConnectInstance.create('account-onboarding')`.

### 2.2 Flow structure

Unlike Plaid (credential-first) or Zapier (credential-at-connect), Stripe Connect collects *business and identity information* — not login credentials. The form is driven by Stripe's Account requirements API.

Typical steps (order varies by country, business type, and risk model):

1. **Business type** — Individual vs. Company vs. Non-profit. This gates subsequent fields.
2. **Business profile** — Name, website, industry category, product description, support contact.
3. **Personal information** — Legal name, date of birth, address, SSN/TIN (last 4 or full, per risk).
4. **Representatives and owners** — For companies: beneficial owners (>25% equity) and control persons. Each person may require their own identity fields.
5. **Bank account** — Routing + account number (US), IBAN (EU), sort code + account number (UK), etc.
6. **Identity verification** — If automated checks fail, a document upload step is inserted (government ID, passport). Handled via Stripe Identity; the onboarding form renders the document upload UI automatically.
7. **Terms of service acceptance** — Stripe's terms and any platform-configured additional terms.

### 2.3 The currently_due / eventually_due model

Source: stripe-hosted-onboarding.

Two requirement buckets control what the form collects:

- **`currently_due`** — Must be collected now to unblock account capabilities. Used for incremental onboarding: collect only what's needed today, prompt for more later.
- **`eventually_due`** — Should be collected now to avoid future disruption. Used for up-front onboarding: collect everything in one session.

Set via `collection_options[fields]` when creating the Account Link:
- `fields=currently_due` → incremental (collect minimum to activate)
- `fields=eventually_due` → up-front (collect everything now)

The integrator chooses per-account-link — the same account can use different strategies at different points in its lifecycle.

### 2.4 Resumable onboarding state

Source: stripe-hosted-onboarding, stripe-api-verification.

Onboarding state is stored server-side in the Stripe Account object. Key behaviors:
- Partially filled fields persist between sessions. On resume, the form renders only the remaining requirements.
- Stripe sends `account.updated` webhooks when requirements change (e.g., a verification check fails and adds a new `currently_due` field).
- When a deadline passes with unmet `currently_due` requirements, those fields move to `past_due` and the corresponding capabilities are disabled.
- The platform re-sends the user through onboarding with a new Account Link; the form knows exactly which fields remain. "You don't need to identify the specific requirements, because the onboarding interface knows what information it needs to collect." (stripe-hosted-onboarding)

### 2.5 Return URL and refresh URL

Source: stripe-hosted-onboarding.

- **`return_url`** — The user lands here after completing or exiting. Stripe does *not* pass a `?completed=true` parameter. The platform must check the Account's `requirements` object via API to determine if onboarding is actually complete.
- **`refresh_url`** — The user lands here if the Account Link URL is expired, already visited (back/forward navigation), or pre-fetched by a messaging client's link preview. The platform must generate a fresh Account Link and redirect the user again.

Design implication: the return page cannot assume success. It must always make an API call to evaluate requirements state.

### 2.6 Embedded component events

Source: stripe-embedded-onboarding.

```javascript
const accountOnboarding = stripeConnectInstance.create('account-onboarding');
accountOnboarding.setOnExit(() => { /* user left the flow */ });
accountOnboarding.setOnStepChange((stepChange) => {
  console.log(`User entered: ${stepChange.step}`);
});
accountOnboarding.setCollectionOptions({
  fields: 'eventually_due',
  futureRequirements: 'include',
});
```

The `setOnStepChange` callback fires on each form section transition, enabling analytics and custom progress indicators.

### 2.7 Verification failure handling

Source: stripe-api-verification.

When automated identity checks fail:
- New `currently_due` fields appear (e.g., `person.verification.document`).
- The hosted/embedded form inserts a document upload UI automatically.
- After submission, Stripe processes asynchronously and sends `account.updated` when done.
- `requirements.disabled_reason` describes why capabilities are disabled: `rejected.incomplete_verification`, `rejected.fraud`, `listed`, `action_required.requested_capabilities`, etc.
- Platforms can generate remediation/appeal links for certain disabled reasons.

### 2.8 Networked onboarding (multi-account reuse)

Source: stripe-embedded-onboarding.

Embedded onboarding supports "networked onboarding": if the person owns multiple Stripe accounts, they can reuse identity and business information from an existing account instead of re-entering it. This is a direct "remember what you told us before" pattern.

---

## 3. Zapier App Connections — Credential-First at Scale

### 3.1 Overview

Zapier connects to thousands of apps across heterogeneous auth models: OAuth 2.0, API keys, basic auth, session cookies, custom token schemes. The "connect account" UX must accommodate all of these from a single entry point in the Zap editor.

*Note: Zapier's help center pages rendered as SPA content that did not expose body text over plain HTTP fetch. Details below are reconstructed from partial source text (zapier-zap-action) and marked [inferred] where primary-source confirmation was unavailable.*

### 3.2 Flow structure: connecting an account during Zap setup

Source: zapier-zap-action (direct), remainder [inferred].

1. **App + event selection** — In the Zap editor, the user selects an app (e.g., Slack) and an event type (e.g., "Send channel message").

2. **"Sign in to [App]"** — A modal/popover appears with a "Connect a new account" primary action plus a dropdown listing existing connected accounts for that app. If no accounts exist, only the connect button shows. *[inferred]*

3. **Auth handoff** — Clicking "Connect" opens an appropriate auth surface:
   - **OAuth apps:** A new browser window opens to the external app's OAuth authorization page; on completion the window closes and Zapier receives the token. *[inferred]*
   - **API key / token apps:** An inline form renders labeled credential fields (e.g., "API Key," "Subdomain"). Per-app inline help text links directly to the specific settings page in the target app where the credential is found. *[inferred]*

4. **Synchronous validation ("test step")** — Immediately after credentials are submitted, Zapier makes a live test API call to the target app. Source: zapier-zap-action. A loading state is shown. On success, the account is added and selected. On failure, an error message surfaces the API-returned reason, and an "AI-powered troubleshooting" option appears to review the error and suggest fixes.

5. **Account available in dropdown** — The connected account appears as "[App] ([email or label])" or a user-defined name. Subsequent Zap steps can independently select any connected account for that app. *[inferred]*

### 3.3 Credential validation: synchronous at connect time

Zapier validates credentials **at connect time, not deferred.** The test API call runs before the connection is saved. This means:
- The user learns immediately whether credentials work.
- Invalid credentials cannot be saved — there is no "broken connection" state that results from initial setup.
- Error messages surface the downstream app's raw error text, which varies significantly by app quality.

Source: zapier-zap-action ("Test step" / "Test your action" section).

### 3.4 Failure and retry UX

Source: zapier-zap-action (direct); remainder [inferred].

- **Inline error on auth failure:** The modal stays open with an error message below the credential fields. No saved state; the user corrects and re-submits. *[inferred]*
- **Broken connection after initial setup:** When a Zap uses a broken connection (token expired, password changed), Zapier auto-pauses the Zap after repeated failures and emails the owner. Source: zapier-zap-action ("Zapier will automatically turn off your Zap if... multiple errors occur each time the Zap tries to run. An email notification will be sent.").
- **Reconnect flow:** From "My Apps" (account settings → Connected Accounts), users see all connected accounts with a status indicator. Broken connections surface a "Reconnect" action. *[inferred]*
- **AI-powered troubleshooting:** For test-step failures, an inline option uses AI to analyze the error and suggest resolution steps. Source: zapier-zap-action.
- **Zap History:** Full log of every Zap run, including `Data in` (inputs) and `Data out` (outputs or error) per step, enabling post-facto diagnosis. Source: zapier-zap-action.

### 3.5 Multiple accounts per app

Source: [inferred].

- Zapier fully supports multiple connections for the same app (e.g., two Gmail accounts, two Slack workspaces).
- Each connection is labeled in the dropdown by the account identifier returned by the app's auth flow (email address, workspace name, etc.).
- Users can rename connections from "My Apps."
- Each Zap step independently chooses which account to use — the account selection is per-step, not per-Zap.

### 3.6 Inline per-app help

For each app's connection form, Zapier renders inline help text authored by the app developer in Zapier's developer platform. This typically includes a direct link to the exact settings page in the target app where the credential can be found, plus step-by-step instructions (e.g., "Go to [App] → Settings → API → Generate new token"). Source: zapier-zap-action (partial).

### 3.7 Broken connection surface levels

Source: zapier-zap-action (email/auto-pause); remainder [inferred].

Zapier surfaces broken connections at multiple levels:
- **In the Zap editor:** Warning badge on the affected step. *[inferred]*
- **In "My Apps":** Per-connection health status. *[inferred]*
- **Via email:** Owner notification when a Zap is auto-paused. Source: zapier-zap-action.
- **In Zap History:** Full error detail for every failed run, including the raw error from the downstream app. Source: zapier-zap-action.

---

## 4. GitHub Importer + Notion Import — Incremental Progress During Long-Running First Sync

Selected as the fourth study for its "background work just started, show incremental progress" UX. Two products covered together because they show different ends of the same spectrum.

### 4.1 Why these products

GitHub Importer and Notion Import both represent: (a) a simple setup form followed by (b) work that runs in the background for minutes to hours, (c) with the user needing to do something productive while waiting. This maps directly to PDPP's first-collection problem: after a source is connected, the initial data collection may take minutes to an hour.

### 4.2 GitHub Importer flow

Source: github-importer, github-importer-about.

1. **Source URL + credentials form** — The user enters the remote repository URL and (if private) authentication credentials (username + password or personal access token). Fields also include: destination owner, repository name, visibility. The form is minimal — 5 fields total.

2. **"Begin import"** — Single submit action.

3. **Immediate redirect to a progress page** — The user is redirected to a "Preparing your new repository" page. They do not wait on the form; forward motion is instant.

4. **Named-stage progress display** — The import progresses through labeled stages shown on the status page:
   - Detecting (analyzing source)
   - Importing (cloning commits)
   - Indexing
   - Checking for large files
   - Complete

   Each stage shows its status. The user can navigate away — the import continues in the background on GitHub's servers.

5. **Interstitial enrichment (author attribution)** — If the import detects commits whose email addresses don't match GitHub accounts, an attribution mapping prompt appears *on the progress page during the import*, not after. The wait time becomes productive: the user completes optional enrichment while the import runs.

6. **Email notification on completion** — For imports that take more than a few seconds, GitHub sends an email when the repository is ready. The user does not need to keep the browser open.

7. **Repository immediately browseable on completion** — No secondary "activation" step.

### 4.3 Credential validation timing (GitHub Importer)

GitHub Importer does not validate credentials synchronously at form submission. The `git clone` operation (which uses the credentials) begins asynchronously after the redirect. If credentials are wrong, the error appears on the progress page, not on the form — potentially after the user has navigated away. *[inferred from flow structure; primary source does not explicitly state the error timing]*

This contrasts with Zapier's synchronous model. The trade-off: long clone operations can't block the form submit, but auth errors are discovered later.

### 4.4 Notion Import flow

Source: notion-import.

Notion's import system handles both file uploads (PDF, Markdown, CSV, Word, HTML) and connected app imports (Evernote, Confluence, Asana, Trello):

**File imports:**
- Two entry points: `Settings → Import`, or type `/import` on any Notion page.
- For PDFs and document types: select file → processing begins immediately in the background.
- Progress tracking: `Settings → Import → In progress` tab shows upload time, status, and file size per import. A `Complete` tab shows finished imports.
- Multiple files can be imported at once for PDFs, HTML, Markdown, Word, and plain text.

**Evernote import (OAuth-connected source):**
1. `Settings → Import → Evernote`
2. Sign in to Evernote (OAuth)
3. Authorize Evernote → Notion connection
4. Select notebooks to import → click Import
5. Notebooks appear in the Notion sidebar as pages *while the import is running* (not only when complete). Notes appear as items in a list database.
6. Each note can be repositioned within Notion immediately.

**Limitations disclosed upfront:** "There's no progress bar or status tracking, and Evernote rate limits can force long backoffs during import." Notion explicitly documents the limitation and advises: "If an import appears stuck, wait to see if it resumes, then try importing smaller batches." Source: notion-import.

This is an honest anti-pattern acknowledgment: the product works but the feedback loop is incomplete, and the docs own it.

**What imports / What doesn't import:** Documented per source type before the user begins. Tables may reformat, images may not render, font colors not preserved, toggles/callouts may appear as plain text. Size limits are stated: 5 MB per PDF on Free, 20 MB on paid plans.

### 4.5 What the "first sync" UX teaches

- **Redirect immediately** to a status page rather than blocking on the form. Instant forward motion reduces anxiety.
- **Named stages** (not an undifferentiated spinner) tell the user exactly where in the process the work is.
- **Background operation:** The user can leave and return. The process does not require the browser to stay open.
- **Interstitial enrichment:** An optional improvement step offered *during* the wait turns idle time into productive time (author attribution in GitHub Importer).
- **Partial materialization:** In Notion's Evernote import, notebooks appear in the sidebar while the import is in progress — not only when complete. The user gets progressive partial value.
- **Email on completion:** For long operations, async notification removes polling pressure.
- **Upfront limitations disclosure:** Telling the user what won't be imported *before* they start prevents "where's my data?" confusion post-import.

---

## 5. Transferable Patterns

### P1 — Consent-before-credential: declare what access is requested before asking for credentials

**Rationale:** Plaid's Consent pane is the industry model. Users grant credentials more willingly when they first understand exactly what data will be shared and by whom. For PDPP, each source type should show a brief "This will collect: [X, Y, Z]" disclosure before any credential prompt, including what is not collected.

### P2 — Synchronous credential validation at submit, where feasible

**Rationale:** Zapier and Plaid both validate credentials immediately (Zapier's test-step, Plaid's LOADING→CREDENTIAL→result cycle). Users should learn within the same interaction whether their credentials worked. For PDPP sources where a synchronous check is cheap (API key ping, OAuth token exchange result), validate immediately and surface errors inline. Do not silently save broken credentials.

### P3 — Name the stages during long work

**Rationale:** GitHub Importer shows named stages (Detecting → Importing → Indexing → Checking large files) rather than an undifferentiated spinner. PDPP's first-collection phase should show named milestones: "Authenticating → Discovering data → Collecting records → Building index" — whatever is meaningful for the specific source.

### P4 — Redirect immediately to a status page; do not block the setup form

**Rationale:** GitHub Importer redirects to a progress page on submit. For PDPP, once a source connection is saved and collection starts, navigate to a per-connection status page immediately. The setup form should not hold the user while collection runs.

### P5 — Background operation: work continues regardless of browser state

**Rationale:** GitHub Importer explicitly supports leaving the page — the import continues server-side. PDPP's first collection should run as a background job. The user must be able to close the console and return to find current status.

### P6 — Update mode / reconnect: land the user at the exact repair step, not the start

**Rationale:** Plaid's update mode skips institution selection and delivers the user directly to the credential or OAuth step for the specific broken connection. For PDPP, a "reconnect" action for a broken source should pre-fill the source form, highlight what changed (e.g., "Your token may have expired"), and focus the user on the single thing that needs fixing — not a blank add-source form.

### P7 — Surface broken connections at three levels: list, detail, and notification

**Rationale:** Zapier surfaces broken connections in the Zap editor, in "My Apps," and via email. PDPP should show health status at the connections list level (a status badge per source), in connection detail (what failed and when), and via an alert (email or in-console notification for the owner).

### P8 — Disclosure upfront: what will and won't be collected, with known limitations

**Rationale:** GitHub Importer and Notion both document "What imports / What doesn't" before the user begins. For PDPP, each connector should surface its data coverage on the add-source screen: "Collects: Gmail emails (all labels), attachments (≤25 MB). Does not collect: calendar events (add separately)." Include known rate limits or collection time estimates.

### P9 — Per-source inline help: link directly to where the credential lives in the target app

**Rationale:** Zapier's app connection forms include inline help links pointing to the exact settings page in the target app where the API key or token is found. For PDPP's token-paste sources (GitHub PAT, ChatGPT export, etc.), inline a direct link and screenshot path: "Create at GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)."

### P10 — Distinguish auth-method paths clearly: OAuth vs. interactive-browser vs. token-paste

**Rationale:** Plaid's flow branches visibly at institution selection (OAuth vs. credential). PDPP sources span three modes — OAuth (Gmail, GitHub), interactive browser login (Chase), and token/export-file paste (ChatGPT data export, Amazon order history). These warrant different UI treatments and trust framing. Do not use a single generic credential form for all three.

### P11 — Multi-connection model: allow multiple connections of the same source type, labeled by account

**Rationale:** Zapier and Plaid both support multiple accounts per provider (two Gmail accounts, two Chase logins). PDPP should allow multiple connections per connector type, each labeled by its account identifier (e.g., "Gmail — personal@gmail.com," "Gmail — work@company.com"), and display them separately in status and health views.

### P12 — Resumable state: partial setup is not a failure; persist progress and resume

**Rationale:** Stripe Connect stores partial form state server-side; re-entry picks up exactly where the user left off. For PDPP sources requiring multi-step setup (e.g., OAuth authorization followed by configuration), save partial state. Show "Continue setup" rather than "Add source" on a card where setup was started but not completed.

---

## 6. Anti-Patterns Observed

### AP1 — Blocking form while long work runs; no progress feedback

Notion's Evernote import documents: "There's no progress bar or status tracking, and Evernote rate limits can force long backoffs during import." An import that appears stuck with no feedback causes users to abandon or double-submit. Always provide a named-stage progress view for work that may take more than a few seconds.

### AP2 — Sending the user back to the add-source start for reconnect

Sending a user back to the beginning of the setup flow to repair a broken connection wastes their time and increases abandonment. The reconnect path should be distinct from the initial add-source path — pre-seeded with what is known, focused on what changed.

### AP3 — Deferred credential validation with no early feedback

GitHub Importer defers auth validation to the background clone attempt. If credentials are wrong, the error may surface minutes later on a progress page the user has already left. For sources where a synchronous check is cheap, prefer immediate validation. Reserve deferred validation only when a synchronous check isn't meaningful (e.g., a data export that must be fetched asynchronously anyway).

### AP4 — Generic error messages without actionable next steps

Plaid explicitly notes `display_message` is null for non-user-action errors. Many integrations stop at "Something went wrong." Error messages should always address: (a) what failed, (b) whether it is a user action or a service issue, (c) what the user should do next. Zapier's inline AI troubleshooting is the leading example.

### AP5 — Undifferentiated spinner for multi-stage, multi-minute async work

A single "Loading…" indicator during a 10-minute first collection provides no orientation. Users cannot tell whether the operation is near completion, stuck, or progressing normally. Named stages and (where possible) progress counts (e.g., "1,204 records collected so far") dramatically improve perceived reliability.

### AP6 — No async notification for long first syncs

GitHub Importer sends an email on import completion. For PDPP sources whose first collection may take 10–60 minutes, leaving the user waiting on a browser tab is unreasonable. Notify on completion (email, or an in-console notification badge) so the user can return to the data when it is ready.

### AP7 — Silent failure: broken sources that stop collecting with no visible health signal

Zapier auto-pauses Zaps and emails the owner when connections break. A source that silently fails — collecting no new data, showing no health degradation — is far worse than a noisy failure. PDPP must health-check connections on each collection attempt, surface degradation in the connection list immediately, and never let a source silently stop working without the owner knowing.
