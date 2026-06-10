# Prior-Art Review: Fast Broad Agent Consent

Status: research input
Author: prior-art research lane
Created: 2026-04-27
Related: `openspec/changes/design-fast-broad-agent-consent/{proposal.md,design.md,tasks.md}`,
`openspec/changes/add-agent-scoped-pdpp-access/design-notes/2026-04-27-fast-broad-agent-consent.md`

## Purpose

Inform the `design-fast-broad-agent-consent` decision (Option A keep/B batch/C
permission sets/D agent roles) with primary-source evidence from production
consent systems. This note does not change behavior. It feeds the design
decisions in `tasks.md §3` and the leaning recorded in `design.md`.

## Sources Consulted

Primary sources (read directly):

- OAuth RAR — RFC 9396, https://datatracker.ietf.org/doc/html/rfc9396
- OAuth PAR — RFC 9126, https://datatracker.ietf.org/doc/html/rfc9126
- Google OAuth — Web server flow + incremental authorization,
  https://developers.google.com/identity/protocols/oauth2/web-server
- GitHub fine-grained PATs,
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- GitHub App installation,
  https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-github-marketplace-for-your-personal-account
- Slack OAuth v2 + optional scopes,
  https://docs.slack.dev/authentication/installing-with-oauth/,
  https://docs.slack.dev/changelog/2026/03/16/optional-scopes/
- Plaid Multi-Item Link, https://plaid.com/docs/link/multi-item-link/
- Apple HIG (privacy and permissions),
  https://developer.apple.com/design/human-interface-guidelines/privacy
- Android permission model,
  https://developer.android.com/guide/topics/permissions/overview
- AWS IAM Identity Center permission sets,
  https://docs.aws.amazon.com/singlesignon/latest/userguide/permissionsetsconcept.html

## Pattern-By-Pattern Findings

### 1. OAuth RAR (RFC 9396) — typed multi-entry authorization

Key normative quotes:

- "An `authorization_details` array MAY contain multiple entries of the same
  `type`."
- "The AS MUST process both sets of requirements in combination with each other
  for the given authorization request."
- "When gathering user consent, the AS MUST present the merged set of
  requirements represented by the authorization request."
- "Note: The user may also grant a subset of the requested authorization
  details."
- "The authorization details attached to the access token MAY differ from what
  the client requests" (enrichment by the AS is explicitly allowed).

What this means for PDPP:

- RAR already permits the client to push N typed entries into one ceremony.
- RAR explicitly allows partial approval and AS-side enrichment/modification.
- RAR explicitly punts UI design to the implementer — there is no normative
  consent UI shape, and no `authorization_details.maxItems` rule.
- RAR does not say one entry must equal one issued grant; that is a PDPP
  protocol decision.

Maps cleanly to PDPP:

- A batch consent ceremony issuing one independent grant per source maps very
  cleanly to RAR's "one `authorization_details[]` entry per source-bounded
  grant request" reading.
- The current reference's `authorization_details.maxItems = 1` is *narrower*
  than RAR allows. The reference rail is policy, not RFC compliance.

Does not map:

- RAR has no built-in concept of "package" or "session id" to group issued
  grants for audit. PDPP would have to define that.
- RAR's "AS MAY enrich/modify" affordance is risky for PDPP, where source
  boundaries and stream lists are owner-visible. Enrichment must be limited to
  things the owner has reviewed.

### 2. OAuth PAR (RFC 9126) — staged request integrity

Key normative quotes:

- "The request_uri value MUST be bound to the client that posted the
  authorization request."
- request_uri "MUST contain some part generated using a cryptographically
  strong pseudorandom algorithm such that it is computationally infeasible to
  predict or guess a valid value."
- Typical lifetime "5 to 600 seconds." Example shows 60 seconds.
- "Initial processing of the pushed authorization request does not involve
  resource owner interaction" — PAR is about request integrity, not consent.

What this means for PDPP:

- PAR's role is to make the staged request tamper-resistant; it does not say
  anything about how many `authorization_details[]` entries are allowed.
- Multi-source batch consent at the AS does not require any change to the PAR
  surface itself, only to what the staged payload may contain.

Maps cleanly:

- Short-lived staged request → owner-facing review session is a clean fit.
  Staged requests already expire fast and bind to the client.

Does not map:

- PAR alone gives no help on consent UI, package audit, or revocation.

### 3. Google OAuth — incremental authorization + granular consent

Key behaviors:

- Multiple scopes are presented together but the user can selectively grant a
  subset. Apps must verify which scopes were actually granted.
- Incremental authorization (`include_granted_scopes=true`) lets a client add
  scopes later without re-confirming previously granted ones.
- Sensitive/restricted scopes trigger app verification friction (extra
  warnings, manual review).
- Domain-wide delegation Workspace apps explicitly *bypass* granular consent —
  flagged here as the failure mode PDPP should avoid normalizing.

Maps cleanly to PDPP:

- Selective per-source approval inside a single ceremony (i.e. owner toggles
  off Slack while approving email + GitHub) is a Google-validated pattern.
- Incremental authorization is a strong precedent for PDPP "add a source to an
  existing agent later" without re-approving the existing sources.
- Sensitive scope friction is a strong precedent for PDPP-side high-risk
  treatment (continuous + all streams + sensitive source).

Does not map:

- Google's scopes are coarse strings that conflate source and permission;
  PDPP's source/stream/field/time/access_mode dimensions are richer and need
  more deliberate UI per dimension, not just a checkbox per scope.
- Domain-wide delegation is precisely the antipattern the design.md non-goal
  list calls out.

### 4. GitHub fine-grained PATs and GitHub App installation

Key behaviors:

- Fine-grained PATs group permissions into account / repository / organization
  categories with read/write/no-access toggles.
- Repository scope is selected per token: all repos owned by the resource
  owner, only selected repos, or public-only.
- Tokens have mandatory expiration (default 30 days; org admins can cap
  lifetime).
- Fine-grained PATs cannot span multiple organizations — by design.
- GitHub Apps: installer reviews requested permissions and selects "All
  repositories" or "Only select repositories" at install time. Installation is
  one ceremony that grants all the listed permissions for the chosen
  repositories.

Maps cleanly:

- Repository toggle ≈ PDPP per-source toggle inside a batch.
- Per-permission read/write granularity ≈ PDPP per-stream/per-field
  granularity.
- Mandatory expiration ≈ PDPP `time_range`/no-time-bound risk classification.
- "Cannot span multiple organizations" ≈ PDPP "one issued grant binds to one
  source boundary" — a structural rather than policy boundary.

Does not map:

- GitHub App installation is closer to all-or-nothing per app: the installer
  cannot deny one permission while keeping the rest. PDPP's design.md target
  is explicitly more granular than this.
- GitHub Apps grant the union of declared permissions across the chosen
  repositories. PDPP wants per-source independent grants, so a closer parallel
  is "installing the same app separately on multiple orgs," not one
  installation.

### 5. Slack OAuth v2 — granular scopes + optional scopes (March 2026)

Key behaviors:

- Bot scopes (act as the app) and user scopes (act as the installer) are
  requested separately and reviewed in the same consent screen.
- Slack v2 was explicitly designed to *break up* one umbrella bot scope into
  individually requestable scopes "to avoid requesting excessive permissions
  that could cause installations to be rejected."
- New (March 2026): optional scopes are presented separately during install
  and the user can choose which ones to grant. Workspace admins can pre-
  approve which optional scopes are available.
- "There is no way to remove scopes from an existing token without revoking it
  entirely" — additive scope risk is real.

Maps cleanly:

- Optional scopes ≈ "owner toggles individual sources off in a batch consent"
  — production validation of the exact pattern Option B proposes.
- Admin pre-approval of which optional scopes are even offered ≈ Option C
  (owner-authored permission sets) acting as an upper bound on what a client
  can request.
- Slack's stated motivation ("avoid requesting excessive permissions that
  could cause installations to be rejected") is the same dynamic PDPP fears —
  the friction creates owner-token shortcut pressure.

Does not map:

- Slack's additive-scope token model is the *opposite* of PDPP's
  source-bounded grant model. PDPP must not pick up the additive token
  pattern.

### 6. Plaid Multi-Item Link

Key behaviors:

- Multi-Item Link lets a user connect multiple institutions inside one Link
  session for PFM/lending workflows.
- Each institution still produces its own independent public token (Item) —
  one Item per institution.
- Same Link token settings apply to every Item; the client cannot mix product
  scopes per institution within one session.
- Some product flows (Embedded Institution Search, Database Auth, Same-Day
  Micro-Deposits) are explicitly incompatible.

Maps cleanly:

- "One ceremony, multiple independent per-source grants" is exactly the
  Option B shape, validated by Plaid in production for a high-stakes domain
  (consumer finance).
- Per-Item independent revocation aligns with PDPP per-grant revocation.

Does not map:

- Plaid's same-settings constraint is a regression for PDPP — a PDPP batch
  must allow different streams/fields/time/access_mode per source, because
  email and finance are not equivalent risk surfaces.
- Plaid does not surface cross-institution risk aggregation in consent; PDPP
  has explicitly committed to making cumulative risk legible.

### 7. Apple / Android — anti-bundling, just-in-time, granular subsets

Key behaviors:

- Apple HIG: request permissions "at the moment of use," not at launch. Do
  not bundle multiple permission requests in sequence to simulate a bundle.
- Granular subset patterns: "Selected Photos," "Approximate Location," "While
  Using App," "Allow Once."
- Android: install-time vs runtime permissions. Runtime (dangerous)
  permissions must be requested in context. Permission groups bundle related
  permissions but Android explicitly warns "groups can change without notice
  — don't assume grouping stability."
- Strong normative anti-bundling guidance: "request only the permissions that
  it needs to complete that action."

Maps cleanly:

- High-risk friction (continuous + all streams + sensitive source) is the
  same instinct.
- Granular subsets ("Selected Photos") map cleanly to PDPP's per-stream and
  per-field projection — the *user picks the subset*, not the client.

Does not map (and this is the strongest cautionary signal):

- Apple and Android both treat bundling as a smell. They are advisory rather
  than mandatory in some places, but the consistent message is that batch
  consent is itself a risk vector.
- This is the strongest argument for keeping Option A as a defensible fallback
  — first-party mobile platforms with deep UX research have decided that
  "ask for one thing in context" wins over "ask for everything up front."
- Critically, mobile permissions are *system-defined*, not client-defined.
  Apps cannot invent a "personal assistant permission group." The closest
  PDPP analog is owner-authored permission sets (Option C), not
  client-authored bundles (Option B).

### 8. AWS IAM Identity Center permission sets

Key behaviors:

- Permission sets are admin-authored. End users do not request them.
- One permission set can map to multiple AWS accounts and many users.
- Users select which assigned permission set to *use* per session, in the
  access portal.
- Versioning is implicit (changes propagate); CloudTrail handles audit.

Maps cleanly to PDPP Option C:

- Owner-authored, reusable, admin-vetted bundles. The client never asks for
  "all data" — the owner pre-defines the package.
- Multi-target reach (one permission set spans many accounts) ≈ one PDPP
  permission set spans many sources, all source-bounded at issuance.
- Session-time selection from multiple assigned permission sets is a useful
  precedent for "owner picks a permission set for this agent today" without
  promoting the client to author the bundle.

Does not map:

- AWS permission sets attach to IAM roles in real AWS accounts; PDPP needs to
  decide what its permission-set object actually points to (named source list?
  source + stream + projection list?).
- AWS has a clear admin/user split. Most PDPP owners are also their own
  admins, so the "admin-authored" property has to be operationalized as
  "owner authored ahead of time, separately from the moment of consent."

## Cross-Cutting Observations

1. **Multi-entry consent ceremonies are normal.** RAR, Google OAuth, Slack v2
   with optional scopes, Plaid Multi-Item Link, and GitHub Apps all support
   "review N capability requests in one session." None of them require one
   issued credential per ceremony. PDPP can adopt this without breaking any
   external precedent.

2. **Independent per-source credentials are normal.** Plaid issues one Item
   per institution. GitHub fine-grained PATs cannot span orgs. Google
   incremental auth grows a token by adding scopes the user has just
   reviewed. The "one issued grant binds to one source boundary" rule is not
   weird — it is the consensus shape.

3. **Per-entry partial approval is the strongest production pattern.** Google
   selective grant, Slack optional scopes, GitHub repository selection, and
   Apple "Selected Photos" all let the user toggle inside a request without
   denying the whole thing. RAR explicitly allows this. Option B's "approve
   all / deny all / toggle individual sources" is the safe shape.

4. **"Approve all" is a known dark pattern.** The Slack-style bundling that
   v2 explicitly broke up, and the Apple/Android explicit no-bundling
   guidance, both flag default-on bulk approval as a smell. PDPP should not
   default to "approve all" for mixed-source requests, especially when
   high-risk dimensions are present.

5. **Owner-authored bundles are safer than client-authored bundles.** AWS
   permission sets, Slack admin pre-approval of optional scopes, and the
   Apple model (system-defined permission groups) all converge on the same
   conclusion: when broad access is needed repeatedly, it is safer for the
   owner/admin to author the bundle than for the requesting client.

6. **Cumulative risk legibility is genuinely missing in prior art.** None of
   the surveyed systems do an especially good job of showing cumulative
   cross-source risk. Google shows scopes; Slack shows scopes; GitHub shows
   permissions; Plaid shows institutions. None aggregate "across these N
   sources you are about to grant access to: 4 are high-sensitivity, 3 are
   continuous, 2 have no time bound, projection is missing on 5." This is
   genuinely novel territory PDPP would be inventing, and it should not be
   underestimated.

## Risks And Dark Patterns Confirmed By Prior Art

- **Approve-all default**: Slack v2 and Apple/Android both treat this as a
  smell. PDPP must not enable an "approve all" affordance until at least
  one round of explicit per-source confirmation has happened, and never when
  high-risk dimensions are present.
- **Client-authored maximal packages**: Slack's reason for moving off umbrella
  bot scopes was that clients were requesting more than they needed.
  Client-authored "all data" packages should be rate-limited, risk-scored,
  and shaped (e.g., reject requests that combine continuous + all streams +
  no time bound + sensitive source unless owner has explicitly opted in).
- **Domain-wide delegation analog**: Google Workspace domain-wide delegation
  bypasses granular consent. PDPP should treat any "skip the per-source
  review" affordance as the same risk class.
- **Additive-token drift**: Slack acknowledges scopes can only be removed by
  revoking the entire token. PDPP's per-grant model already avoids this —
  do not regress to additive grants on a single token.
- **Bundle stability illusion**: Android explicitly warns that "permission
  groups can change without notice." Owner-authored permission sets must be
  versioned and the owner must be re-prompted when a set's contents widen,
  not when they narrow.

## What Maps Cleanly To PDPP

- RAR multi-entry semantics for the *staged request* shape (one
  `authorization_details[]` entry per source-bounded grant request).
- Issuing N independent grants from one ceremony (Plaid Multi-Item, Google
  granular consent).
- Per-source toggle inside one review session (Slack optional scopes, GitHub
  repository selection).
- High-friction treatment for sensitive scopes (Google sensitive scopes,
  Apple/Android high-risk prompts).
- Mandatory expiration / explicit time bounding (GitHub fine-grained PATs).
- Owner-authored reusable bundles (AWS permission sets, Slack admin
  pre-approval).
- Incremental "add a source later" without re-approving existing sources
  (Google `include_granted_scopes`).

## What Does Not Map To PDPP

- AS-side enrichment of `authorization_details` (RAR allows it; PDPP should
  forbid widening the grant beyond what the owner reviewed).
- Same-settings-for-all-Items (Plaid Multi-Item) — PDPP must allow per-source
  streams, fields, time, and access mode.
- Additive scopes on a single token (Slack) — PDPP keeps independent grants.
- Domain-wide delegation / "skip granular consent" (Google Workspace) — never.
- All-or-nothing installation (GitHub Apps) — PDPP must allow per-source
  denial inside a batch.

## Recommendation

**Proceed with Option B (batch consent ceremony) as the first implementation
candidate, and design Option C (owner-authored permission sets) in parallel
as the safer reusable abstraction.** Do not pursue Option D (agent roles) in
this track.

Reasoning:

- **Option B is precedented in production** at high stakes (Plaid in
  consumer finance, Slack in workplace data, GitHub Apps in developer
  infra, Google in personal data). It maps cleanly to RAR's multi-entry
  shape without changing PDPP's source-bounded grant model.
- **Option B alone is not sufficient long-term.** The Apple/Android and AWS
  evidence is strong: when broad access becomes routine, owner-authored
  bundles are the right primitive. A client-authored batch is the right
  *first* primitive because it solves the immediate "agent setup is too
  slow" problem; an owner-authored permission set is the right *durable*
  primitive because it shifts authorship away from the requesting client.
- **Option C builds on Option B** — a permission set, applied at consent
  time, is just an owner-authored batch. So Option B's pending-consent
  storage, package id, grouped review UI, and per-grant issuance are all
  reusable for Option C.
- **Option D (agent roles) is too far ahead.** None of the surveyed systems
  ship anything like agent-role policy as a first-class consent primitive.
  AWS permission sets are the closest analog and they explicitly stop short
  of mapping identity to access policy by themselves. Defer until B/C ship
  and real usage signals demand it.

The current `design.md` "current leaning" toward Option B as first, Option C
as long-term is consistent with this evidence. This note sharpens the
sequencing: B unblocks the immediate user problem; C is the next OpenSpec
change after B lands, not a parallel implementation.

## Owner Decisions Still Required

These are the questions the owner still needs to answer before the next
OpenSpec implementation change can be written. They are intentionally narrow.

1. **Authorship policy.** Are *both* client-authored batches (Option B) and
   owner-authored permission sets (Option C) on the roadmap, or only B with
   C deferred? The design note recommends both, with B first.

2. **Maximum batch size.** Is there a hard cap on `authorization_details[]`
   entries per staged request (e.g., 8 sources)? Slack does not cap; GitHub
   App permissions are bounded by what the app declares; Plaid Multi-Item
   has no documented cap. PDPP probably wants a soft cap with a warning,
   not a hard cap, but this needs an explicit decision.

3. **Approve-all affordance threshold.** Under what conditions, if any, is
   an "approve all" button shown? Proposal: never shown when the staged
   request includes any of (continuous + all streams), (no time bound +
   sensitive source), or N≥3 sensitive sources in one batch. Owner sign-off
   needed on the threshold.

4. **High-risk classification.** Which connectors/sources are "sensitive"
   for risk-classification purposes? Email, finance, location, health,
   private chat. This list belongs in a config or manifest field, not
   hardcoded.

5. **Package id / session id semantics.** Is the package id surfaced in:
   (a) the grant timeline only, (b) the dashboard grants list as a group,
   (c) revocable as a unit ("revoke package")? Recommendation: (a) + (b)
   yes, (c) optional convenience, never default — per-grant revocation
   stays primary.

6. **Incremental upgrade.** When a client adds a new source to an existing
   agent, does that produce a new ceremony, a new package linked to the
   prior package via a `parent_package_id`, or does it stand alone? Google
   `include_granted_scopes` is the precedent for "previously granted
   scopes are not re-prompted," and PDPP should adopt that property: new
   ceremony, new package, but the dashboard must show the cumulative
   picture across packages for that agent identity.

7. **Permission-set storage location.** When Option C lands, are permission
   sets stored per-owner in PDPP local storage, in the manifest, or both?
   Probably owner-local with optional export, but this affects the client
   registration flow.

8. **Reference-experimental labeling.** Confirm that any first
   implementation of B is labeled reference-experimental in UI and docs,
   per the existing spec requirement, until promoted by a follow-up
   OpenSpec change.

## Confidence

Findings on RAR (1), PAR (2), Google (3), GitHub fine-grained PATs (4),
Slack v2 + optional scopes (5), Plaid Multi-Item (6), Apple/Android (7),
and AWS Identity Center (8) are all backed by primary-source quotes from
official documentation. The recommendation is conservative — it endorses
the existing design.md leaning rather than replacing it — and is consistent
with every surveyed pattern's data-minimization stance.
