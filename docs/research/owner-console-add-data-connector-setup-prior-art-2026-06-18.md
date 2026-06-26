# Owner Console — Add Data / Connector Setup Prior Art (Honest Availability, Scopes, Validation, First-Sync Progress, Self-Host Operator Path)

**Date:** 2026-06-18
**Owner:** research lens (LENS 4 — Add Data / connector setup)
**Status:** Research + corpus only. No product code changed. No deploy. No live ops.
**Why this note exists (and what it extends):** Extends two existing, good docs — `slvp-ideal-connector-self-service-setup-2026-06-14.md` (static-secret manifest-driven form, no-dead-ends principle, Plaid repair gold standard, Stripe key masking) and `slvp-ideal-browser-device-connector-setup-2026-06-14.md` (browser-bound + local-device setup/repair, neko shell, Tailscale enrollment). Those docs nailed the *manifest-driven form* and *repair = setup scoped to existing connection* verdicts; this note does NOT re-derive them. It pushes into the gaps those docs left open and that the owner's complaints expose:
- **Honest availability** — never present an action ("Add account", "Connect") that cannot actually complete (owner: "feels fairly vibe-coded"; dead-end "Not supported yet" / "Packaged path pending" with no path).
- **Prerequisite + exact-scope disclosure BEFORE the owner starts** — what the owner must already have, and the *exact* provider-secret scope/permission to select.
- **Multi-account setup** — adding a second account of the same source without re-finding it in a catalog.
- **Validate-before-success** — never claim "Connected" before the credential is proven (owner: "1 needs review" with no basis; trust erosion).
- **Post-submit first-sync progress** — replace dead "submitted" / "blinking cursor; no progress indicator" with live progress.
- **The SELF-HOST OPERATOR first-run path** (Docker / Railway / Vercel / Supabase) — PDPP is self-hostable, so "add data" has a layer *below* connectors: the owner first stands up the instance. No prior PDPP doc covers operator first-run UX.

---

## 1. Prior-art sources

Each entry: URL + retrieval date 2026-06-18 + the specific observed pattern.

### 1.1 GitHub — personal access token creation (exact scope names, fine-grained tokens)
- **Classic PAT scopes:** https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps (retrieved 2026-06-18). Exact scope-name table observed: `(no scope)` = "read-only access to public information (user profile, repository info, gists)"; `repo` = "full access to public and private repositories including read and write… also grants access to manage organization-owned resources"; `repo:status`, `repo_deployment`, `public_repo` (narrower); plus `read:user`, `user:email`, `gist`, `notifications`, `read:org`, etc. The page itself warns: "Consider building a GitHub App instead of an OAuth app." Critical: there is **no read-only `repo` scope** — `repo` is all-or-nothing read+write across all repos.
- **PAT creation flow + fine-grained tokens:** https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens (retrieved 2026-06-18). Classic token creation is an explicit numbered flow: Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token → "Note" (descriptive name) → "Expiration" → **scope checkboxes**. The docs warn classic PATs "can access every repository that you can access" and recommend **fine-grained** tokens, which let you "restrict to specific repositories" and "specify fine-grained permissions instead of broad scopes." Fine-grained creation adds: Token name, Expiration (infinite allowed but may be blocked by org max-lifetime policy), **Resource owner**, **Repository access** (All / selected), and per-resource read-only/read-write **Permissions**. Hard limit (verbatim, from the "Creating a fine-grained personal access token" section): "There is a limit of 50 fine-grained personal access tokens you can create. If you require more tokens or are building automations, consider using a GitHub App for better scalability and management." Past that, GitHub steers you to a GitHub App.

### 1.2 Plaid — Link flow, OAuth handoff, multi-account, validate-before-store
- **Link overview:** https://plaid.com/docs/link/ (retrieved 2026-06-18). Setup is a *hosted* token-mediated flow, not a credential form: server mints a short-lived `link_token`, the SDK runs the user through institution-select → login → account-select, then returns a `public_token` exchanged server-side for an `access_token`. The host app never sees the bank password.
- **OAuth handoff / app-to-app:** https://plaid.com/docs/link/oauth/ (retrieved 2026-06-18). Observed: some banks (Chase) support an **App-to-App** experience — instead of typing the password, the bank's own app launches (Face ID / Touch ID), then redirects back. On iOS this requires an Apple App Association file mapping the redirect URI to the app; with webviews, app-to-app is "not automatic" and Plaid "strongly recommends" a mobile SDK or Hosted Link with a Universal Link `redirect_uri`. The handoff is testable in Sandbox (`ins_132241` "First Platypus Bank - OAuth App2App"). Key pattern: the *handoff out and back* is an explicit, designed, testable seam — not a leap of faith.
- **Multi-account:** Plaid's account-select step inside Link lets the user pick *which* accounts at an institution to share; one Item can carry multiple accounts, and the user can run Link again to add a second institution. (Account-select step observed in the Link overview flow.)

### 1.3 Stripe — Connect onboarding (choose configuration, hosted handoff, requirement state)
- **Choose onboarding configuration:** https://docs.stripe.com/connect/onboarding (retrieved 2026-06-18). Stripe forces an explicit *configuration choice* up front (Stripe-hosted vs embedded components vs API) rather than one-size-fits-all — the platform declares which onboarding modality it supports before the user starts.
- **Stripe-hosted onboarding:** https://docs.stripe.com/connect/hosted-onboarding (retrieved 2026-06-18). Two URLs are mandatory on handoff: `return_url` (where the user lands when done) and `refresh_url` (where they land if the link **expired or was already visited** — i.e. the resume/re-issue path is a first-class designed state, not an error). Note observed: HTTP allowed only in test; "live mode only accepts HTTPS." Completion is a *state*, not a button: the platform listens for changes to account `requirements`; it sends an account "back through onboarding when it has any `currently_due` or `eventually_due` requirements," and "the onboarding interface knows what information it needs to collect" — the host does not have to enumerate the missing fields itself.

### 1.4 Railway — operator deploy + live build/deploy status
- **Quick start / canvas:** https://docs.railway.com/quick-start (retrieved 2026-06-18). Observed: the project "canvas" is "mission control" for infrastructure, environments, and deployments. "Once the initial deployment is complete, your app is ready to go." On failure: "you can explore your build or deploy logs for clues… scroll through the entire log; important details are often missed, and the actual error is rarely at the bottom." Pattern: deploy is a *live, observable* process with build vs deploy split and a logs panel — not a dead "submitting."
- **Deployments guide:** https://docs.railway.com/guides/deployments (retrieved 2026-06-18). Deployments are first-class objects with explicit lifecycle states and per-deploy logs; a deploy that builds successfully but crashes at runtime is distinguished from a build failure.

### 1.5 Vercel — operator deploy + deployment status / rollback
- **Deploying to Vercel:** https://vercel.com/docs/deployments/overview (retrieved 2026-06-18). Observed: "Every time your project builds successfully, Vercel creates a deployment with its own URL." Multiple entry modalities are presented as equals ("Push code, run a CLI command, call the API, or drag a folder into your browser — you choose how to ship"). Deployments are immutable, URL-addressable artifacts; production has an explicit **"Rolling back a production deployment"** path ("Revert to a previous production deployment safely"). Pattern: every deploy is a durable, inspectable object with build → ready → error states and a safe reversal.

### 1.6 Supabase — operator first-run config (env vars, generated keys, self-host)
- **Quickstart (env vars):** https://supabase.com/docs/guides/getting-started/quickstarts/nextjs (retrieved 2026-06-18). Observed: setup names *exactly* which env vars to populate — `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — copied from a labeled "Project URL" / "Publishable key" panel into `.env.local`. The config surface is concrete and copy-pasteable, not "configure your environment."
- **Deployment & branching:** https://supabase.com/docs/guides/deployment (retrieved 2026-06-18). Observed: explicit framing that "most apps have at least two environments" (production + staging/preview) and that Supabase provides "flexible options for deployment workflows of various complexity." Self-hosting is a documented first-class path with a docker-compose stack and operator-generated secrets.

### 1.7 Tailscale — agent enrollment (one command, device-appears feedback)
- **Quickstart / install:** https://tailscale.com/kb/1017/install (retrieved 2026-06-18). Observed first-run: sign in with SSO → "Let's add your first device" → pick OS → authenticate the client → **"Once you are authenticated, the device will appear in the browser window."** Adding a second device: "Copy the link and send it to the second device." Pattern: enrollment is one authenticated command, and the console gives *immediate positive feedback* (the device materializes) — the opposite of a blinking cursor. This is the canonical model PDPP's local-collector enrollment should mirror.

### 1.8 Google — exact OAuth scopes + consent-screen operator config + "apps with access"
- **OAuth 2.0 scopes for Google APIs:** https://developers.google.com/identity/protocols/oauth2/scopes (retrieved 2026-06-18). Exact, copy-pasteable scope URLs observed, e.g. Gmail: `https://www.googleapis.com/auth/gmail.readonly` = "View your email messages and settings"; `https://www.googleapis.com/auth/gmail.metadata` = "metadata such as labels and headers, but not the email body"; `https://mail.google.com/` = "Read, compose, send, and **permanently delete all** your email." Two-tier sensitivity is explicit: "Sensitive scopes require review by Google and have a *sensitive* indicator on the… OAuth consent screen configuration page. Many scopes overlap, so it's best to use a scope that isn't sensitive." Public apps "must complete a verification process"; during testing an **"unverified app"** screen appears until a verification request is submitted.
- **OAuth consent screen / app branding:** https://support.google.com/cloud/answer/10311615 (retrieved 2026-06-18). Operator-facing config of "what users see in the sign-in and consent screens" — App name, Logo, Support email, links. Publishing status (Testing → In production) and a "test users" allowlist gate who can authorize before verification.
- **Apps with access / linked apps:** https://support.google.com/accounts/answer/13533235 (retrieved 2026-06-18). The owner-facing transparency surface: a "linked apps" page (`myaccount.google.com/connections`) where each app shows what access it has, with a "See details" → "Delete link" → "Confirm" removal ceremony, and a warning that deleting the link revokes access. (This is the *consumer* mirror of the access-transparency surface already covered in the explorer/access-transparency doc — cited here only as the per-app prerequisite-disclosure analog.)

> **Note on availability:** Railway/Vercel/Supabase pages above were fetched on 2026-06-18 after a transient DNS timeout on the first attempt; the cited sections are from the successful re-fetch. See `failures` for the verbatim first-attempt errors.

---

## 2. Observed patterns (cross-source synthesis)

1. **Declare the modality before the owner starts.** Stripe forces a configuration choice (hosted vs embedded vs API). Plaid declares whether a bank is OAuth/app-to-app vs credential. GitHub distinguishes classic vs fine-grained. The owner is never dropped into a form that *might* be the wrong kind of form.

2. **Prerequisites and exact scopes are disclosed up front, in provider vocabulary.** GitHub names the *exact checkbox* (`repo`, `read:user`) and warns about over-grant. Google gives the *exact scope URL* and labels it sensitive/restricted. Supabase names the *exact env var*. None say "configure access" — they name the literal thing to select/paste.

3. **The credential/identity is validated before success is claimed.** Plaid only returns a `public_token` after the bank authenticates the user; Stripe completion is gated on `requirements` clearing; the host never shows "connected" on an unproven secret. (PDPP's own `probeCredential`, per the self-service doc §5, is this pattern.)

4. **Handoff *out* and *back* is a designed, named seam.** Plaid OAuth redirect_uri / Universal Link; Stripe `return_url` + `refresh_url` (with an explicit *expired/already-visited* resume path). The owner is never stranded mid-handoff; there is always a labeled return and a labeled retry.

5. **Post-submit is a live, observable process, not a terminal "submitted."** Railway streams build then deploy logs and distinguishes build-fail from runtime-crash. Vercel makes every deploy a durable object with building → ready → error. Tailscale makes the device *appear* the instant it authenticates. None end at a static "submitted."

6. **Multi-account / multi-device is first-class.** Plaid account-select + re-run Link for a second institution; Tailscale "add a second device" with a copy-link. Adding another of the same source is a designed action, not a re-walk of the catalog.

7. **Unavailable is *honest and named*, never silent.** Google shows "unverified app" with a path to verification; Stripe's `refresh_url` names the expired-link state; Plaid degrades webview app-to-app to Hosted Link rather than failing. Each "can't do this yet" is a *named state with a forward path*.

8. **Remove/repair is symmetric with add.** Plaid update-mode (covered in extended docs) = setup scoped to the existing Item; Stripe re-onboards on new requirements; Google's "Delete link" is a deliberate confirm ceremony. Add and un-add are mirror affordances.

---

## 3. PDPP implications (tie to specific surfaces + the owner's complaints)

**3.1 Honest availability on the Add-Data / Sources surface (owner: "vibe-coded"; dead-end "Packaged path pending"; "can't tell if I'm looking at a source or a connection").**
The disposition map in `source-setup-presentation.ts` already classifies connectors. The lens-4 addition: every catalog/source card must render an *availability tier* badge whose label maps 1:1 to whether the primary CTA can actually complete *right now on this instance*. Borrow Google's "unverified app" honesty: an action that can't complete must be visibly downgraded (not hidden, not falsely enabled). Concretely, the CTA's enabled/disabled state must be derived from a server-side capability check (the `canUseBrowserSessionEnroll()` gate the browser-device doc proposes), exactly as Stripe gates onboarding on declared configuration. A button labeled "Add account" that opens a page that immediately fails is the single worst "vibe-coded" smell — it must be impossible by construction.

**3.2 Prerequisite + exact-scope disclosure BEFORE the form (owner: trust / "feels vibe-coded").**
For GitHub/Gmail-class static-secret connectors, the `credential_capture` block (self-service doc §8.1) should carry a **prerequisites panel** rendered *above* the secret field, stating in provider vocabulary: (a) what the owner must already have (a GitHub account; a YNAB budget); (b) the *exact* token type and *exact* scope to select, mirroring GitHub's literal scope names and Google's literal scope URLs; (c) a `help_url` deep-link to the provider's token-creation page. PDPP should recommend the *narrowest* scope (GitHub fine-grained, read-only; `gmail.readonly` not `mail.google.com/`) and say so — because PDPP only reads. This directly answers "no indication of what this needs."

**3.3 Validate-before-success, and never echo a false "Connected" (owner: "1 needs review" with no basis).**
Extend self-service doc §5: the post-submit state machine must be `validating → connected-as-<identity>` OR `validating → rejected-with-cause`, never `submitted → (silent)`. On success echo the provider identity (Plaid returns institution + accounts; GitHub `GET /user` login; YNAB user id). A connection must not enter a "needs review" or "healthy" count until the probe (or first sync) proves it. The "1 needs review" complaint is partly that the count is asserted without a legible basis — the basis must be the validation/first-sync result, surfaced inline.

**3.4 Post-submit first-sync progress (owner: local recovery gives a command then "just a blinking cursor; no progress indicator").**
This is the highest-value lens-4 gap. Tailscale's "the device will appear" and Railway's streaming build/deploy logs are the exact antidotes. For the **local-collector** path, after the owner runs `pdpp collector enroll`/`run`, the device-exporters page must flip from "waiting" to "Device connected — first sync running (N records so far)" *on heartbeat*, with a live counter — never leave the owner staring at a terminal cursor with the console unchanged. For **static-secret** connectors, post-submit must show a first-sync progress strip (queued → syncing → N new records collected), not a static "submitted." This also fixes the "Collected" confusion (owner: "many say no change vs how many NEW records") — the first-sync strip should report *new records this run*, the same number-with-basis the explorer doc demands.

**3.5 Multi-account.**
PDPP can already hold multiple `connection_id`s per connector. The Add-Data surface must expose an explicit "Add another account" affordance on a source that already has one connection (Plaid re-run / Tailscale add-second-device), pre-scoped to that connector so the owner does not re-find it in the catalog. For static-secret this is a fresh form for a new `connection_id`; for browser-bound it is a fresh browser-enrollment shell.

**3.6 Self-host operator first-run (PROPOSAL — most speculative section; validate against the actual shell before building).**
Below connectors sits the operator layer: standing up the PDPP instance (Docker / Railway / Vercel). This is the most aspirational part of this note: unlike the connector-level recommendations (§3.1–3.5), it assumes PDPP either has or *should add* an operator first-run UI surface, which may not exist today — so treat it as a direction to validate, not a documented surface. The Railway/Vercel/Supabase prior art (§1.4–1.6) is solid; the PDPP-side leap is the part to pressure-test. *(Note: PDPP's repo is widely understood to carry a Railway template track, but that is not cited from repo/code here, so it is not load-bearing for this proposal.)* The lens-4 *implication if such a surface exists*: operator first-run should mirror Railway/Supabase honesty — name the *exact* required env/secrets (e.g. `PDPP_CREDENTIAL_ENCRYPTION_KEY`, owner token), and the post-deploy state should be a live "instance is coming up → reachable at <url>" with build/deploy logs, not a dead "deployed." The console's existing `ServerUnreachable` shell (flagged in project memory as leaking monorepo paths to owner pages) is the concrete *anti-pattern instance* this proposal would remediate — operator-error states must speak operator vocabulary with a forward path, exactly as Railway says "scroll the build logs; the error is rarely at the bottom." The cheapest validated win here is hardening that existing shell, independent of any new operator UI.

---

## 4. Concrete affordance / copy / IA recommendations

**4.1 Availability tiers (badge + CTA derivation).** Three owner-legible tiers on every source/catalog card, each with a fixed badge label and a CTA that is enabled ONLY when the capability check passes:
- `Ready` (green) → primary CTA `Add account` (static-secret form / local-collector enroll). Enabled.
- `Needs setup on your machine` (amber) → CTA `Open setup guide` → runbook (browser-bound pre-neko). Never a disabled "Add account."
- `Not available here` (neutral/grey) → no primary CTA; one line of *why* + a `Notify me / track this` link. (Mirrors Google "unverified app" + path.)
Never render an enabled `Add account` that routes to an immediate failure.

**4.2 Prerequisites panel (above the secret field).** A fixed block in the static-secret form:
- Heading: `Before you start`
- `You'll need:` <provider account> (e.g., "A GitHub account").
- `Create the token here:` <help_url deep-link, opens new tab>.
- `Select exactly this scope:` render the provider's *literal* scope name in monospace — e.g. `repo` (or, recommended: a fine-grained token with **read-only** access to the repos you want) / `https://www.googleapis.com/auth/gmail.readonly`.
- `PDPP only reads your data` — one-line scope-minimization note.

**4.3 Validate-before-success state machine + copy.** On submit:
- `Checking your <provider> credential…` (spinner, ≤10s bounded probe).
- Success: `Connected as <identity>. Starting first sync…` (then transitions to 4.4). Do NOT show a "needs review" or success count yet.
- Failure: `<Provider> rejected this credential — it may be expired or revoked. [Create a new token ↗]` Store nothing; preserve the form.

**4.4 First-sync progress strip (replaces dead "submitted" and the blinking cursor).** After validation, an inline strip on the connection/device card:
- `Queued` → `Syncing… <N> new records collected` (live counter) → `First sync complete — <N> new records` (or `No new records — already up to date`).
- For local-collector: device row flips on heartbeat to `Connected — syncing` with the same counter; never leave the enrollment command as the last visible state. Copy near the command: `After you run this, your device will appear here within ~30s.`
- Distinguish, in words the owner asked for: `<N> new` vs `no change` — never a bare "Collected".

**4.5 Multi-account affordance.** On a source with ≥1 connection: a secondary button `Add another <Provider> account` next to the existing connection list, deep-linked to the same setup flow with a fresh `connection_id`. Label the existing ones by identity (`Connected as @tim`, `Connected as @work-org`) so the owner can tell accounts apart — answering "is this a source or a connection?" by always labeling connections with their account identity.

**4.6 Handoff return/retry (for any redirect-based connector, incl. operator OAuth).** Always define both a *return* landing (`You're connected — first sync running`) and a *resume* landing for an expired/already-used link (`That setup link expired. [Start again]`) — the Stripe `return_url`/`refresh_url` pair. Never strand a half-finished handoff.

**4.7 Operator first-run page (self-host) — PROPOSAL, validate against the actual `ServerUnreachable` shell first.** This recommendation is more aspirational than §4.1–4.6: it presumes an operator surface PDPP may not expose today. The lowest-risk reading is to *harden the existing `ServerUnreachable`/setup shell* rather than build a net-new operator UI. A dedicated operator surface (or the hardened `ServerUnreachable`/setup shell) that:
- Names the *exact* required secrets/env in monospace with one-line purpose each (no monorepo paths leaked to owner pages).
- After deploy, shows `Bringing up your PDPP instance…` with a build/deploy log panel and copy mirroring Railway: `If it fails, read the whole log — the real error is rarely at the bottom.`
- Ends at `Your instance is live at <url>` with a link, not a static "Deployed."

**4.8 Copy bans.** Replace `Not supported yet`, `Packaged path pending` (zero-CTA), and bare `Submitted` everywhere. Each must become a tiered badge (4.1) + a forward action (4.2/4.3/4.4).

---

## 5. Anti-patterns to avoid

- **Enabled action that can't complete.** An `Add account` / `Connect` button that opens a page which immediately fails (the core "vibe-coded" smell). Gate the CTA on a real capability check, like Stripe gating on declared configuration.
- **Silent dead ends.** `Not supported yet` / `Packaged path pending` with no badge and no link. Google instead shows "unverified app" *and* a path.
- **Vague prerequisites.** "Configure access" / "set up your credentials." GitHub/Google/Supabase all name the *literal* scope/env/token. Vague = the owner guesses = over-grants or fails.
- **Over-grant by default.** Steering owners to broad `repo` or `https://mail.google.com/` when read-only (`gmail.readonly`, fine-grained read) suffices. PDPP only reads — recommend the narrowest scope and say why.
- **Claiming success before proof.** A success toast / "needs review" count on an unvalidated secret. Validate first (Plaid/Stripe), then echo identity.
- **Terminal "submitted" / blinking cursor.** No post-submit progress, no first-sync counter, no "device appeared" feedback. The single most-cited owner complaint; Tailscale/Railway are the direct antidote.
- **"Collected" with no new-vs-unchanged distinction.** Report `N new records` (or `no change`), never a bare ambiguous count.
- **Stranded handoff.** A redirect/handoff with no defined return AND no defined expired-link resume (Stripe pairs both).
- **Operator errors in developer/monorepo vocabulary on owner pages.** `ServerUnreachable` leaking `node reference-implementation/server/index.js` to owner surfaces. Operator states must speak operator vocabulary with a forward path.

---

## 6. Acceptance checks (testable, owner-walkable)

1. **No enabled dead-end CTA.** Walk every source/catalog card: every card whose primary CTA is enabled (`Add account`/`Connect`) actually opens a flow that can complete on this instance. Any connector that can't complete shows an amber `Needs setup on your machine` (with runbook link) or grey `Not available here` (with a why-line) — never an enabled action that fails. Mechanical grep, scoped to the same surface the existing owner-journey acceptance harness already scans (`apps/console/src/app/dashboard/**`, per project memory's RI Owner-Journey Acceptance Harness): zero occurrences of `Not supported yet` or zero-CTA `Packaged path pending` in the rendered RSC source/copy under that tree. (Pattern matches the harness's source-string scan over `dashboard/**`.)
2. **Exact scope disclosed before the field.** Open the GitHub (and Gmail/YNAB) setup form: a `Before you start` panel appears above the secret input, naming the exact provider token type, the exact scope in monospace (e.g. `repo` or `gmail.readonly`), a working `help_url` deep-link, and a "PDPP only reads" note.
3. **Validate-before-success.** Submit a deliberately bad token: UI shows `Checking your credential…` then a typed rejection with a create-new-token link; NO success toast, NO increment of any "connected"/"needs review" count, and nothing is stored. Submit a good token: UI shows `Connected as <identity>` only after the probe returns.
4. **First-sync progress, not a dead end.** After a successful static-secret submit, an inline strip shows `Queued → Syncing… <N> new records → First sync complete (<N> new / no change)`. After running the local-collector enroll command, the device row flips to `Connected — syncing` with a live counter within the stated window — the enrollment command is never the last visible state (no "blinking cursor" terminal state in the console).
5. **Multi-account.** On a source with one connection, an `Add another <Provider> account` affordance exists and creates a distinct `connection_id`; both connections are labeled by account identity (`Connected as @x` / `@y`), and the owner can tell them apart without opening detail.
6. **Handoff resume.** For any redirect-based flow, visiting an expired/already-used setup link lands on a named `That link expired. [Start again]` state — not a blank error.
7. **Operator first-run honesty.** *(Proposal to validate against the actual `ServerUnreachable` shell, not a documented PDPP surface today — see §4.7.)* If/when PDPP exposes an operator first-run/bring-up surface (or hardens the existing `ServerUnreachable` shell), it should name exact required secrets/env (no monorepo paths in owner-visible copy), show a live bring-up/log state, and end at `Your instance is live at <url>`. Mechanical grep, scoped to `apps/console/src/app/dashboard/**` (the same harness tree): zero `reference-implementation/server` or `packages/` strings reach owner-visible copy. The `ServerUnreachable`-leaks-monorepo-paths finding in project memory is the concrete anti-pattern instance this check guards against.
8. **Scope minimization is the recommended default.** The setup copy recommends the narrowest scope (fine-grained read-only / `gmail.readonly`), never defaulting the owner to `repo` or `https://mail.google.com/`.

---

## 7. Sources (consolidated, all retrieved 2026-06-18)

| Source | URL |
|--------|-----|
| GitHub — OAuth/PAT scopes list (exact scope names) | https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps |
| GitHub — Managing PATs (classic + fine-grained creation, scope checkboxes) | https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens |
| Plaid — Link overview (token-mediated hosted flow, account-select) | https://plaid.com/docs/link/ |
| Plaid — Link OAuth guide (app-to-app handoff, redirect/Universal Link) | https://plaid.com/docs/link/oauth/ |
| Stripe — Choose onboarding configuration | https://docs.stripe.com/connect/onboarding |
| Stripe — Stripe-hosted onboarding (return_url/refresh_url, requirements state) | https://docs.stripe.com/connect/hosted-onboarding |
| Railway — Quick start / canvas (build vs deploy logs, mission control) | https://docs.railway.com/quick-start |
| Railway — Deployments guide (deployment lifecycle objects) | https://docs.railway.com/guides/deployments |
| Vercel — Deploying to Vercel (deployment objects, rollback) | https://vercel.com/docs/deployments/overview |
| Supabase — Next.js quickstart (exact env vars / keys) | https://supabase.com/docs/guides/getting-started/quickstarts/nextjs |
| Supabase — Deployment & branching (envs, self-host) | https://supabase.com/docs/guides/deployment |
| Tailscale — Quickstart / install (one-command enroll, device-appears feedback) | https://tailscale.com/kb/1017/install |
| Google — OAuth 2.0 scopes for Google APIs (exact scope URLs, sensitive/verification) | https://developers.google.com/identity/protocols/oauth2/scopes |
| Google — Manage OAuth app branding / consent screen | https://support.google.com/cloud/answer/10311615 |
| Google — Manage links to apps / linked apps (remove access ceremony) | https://support.google.com/accounts/answer/13533235 |

**Extends (cited, not re-derived):** `slvp-ideal-connector-self-service-setup-2026-06-14.md` (manifest-driven form §3, validate-on-entry §5, no-dead-ends §6, repair = setup-on-existing §8.3); `slvp-ideal-browser-device-connector-setup-2026-06-14.md` (browser-enrollment shell, Tailscale enrollment §2.3, `canUseBrowserSessionEnroll()` gate, repair CTA). Access-transparency / "what did ChatGPT read" lives in `explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` — the Google "linked apps" surface is cited here only as the per-app prerequisite/remove analog.
