# Owner Add-Account Flow Design

Status: proposed design
Owner: reference implementation owner
Created: 2026-06-10
Related:
- `design-notes/owner-journey-slvp-realignment-plan-2026-06-10.md` (the plan this design completes — it defines the honesty floor; this defines the flow)
- `research/connection-onboarding-prior-art-2026-06-10.md` (Plaid Link, Stripe Connect, Zapier, GitHub Importer — sources and dates inside)
- `tmp/workstreams/onboarding-capability-inventory-2026-06-10.md` (ground truth of what exists; file:line citations live there)
- `openspec/specs/reference-connection-health/` (the state model every flow state projects from)

## Design Test

SLVP means Stripe, Linear, Vercel, Plaid. For connection onboarding the test is
literal: **would this flow look at home inside Plaid Link?** Plaid's job — "let
a person connect an account they own to a service they trust, including the
awkward credential moment" — is exactly this feature.

## The Skeleton: One Flow, Three Modalities

Prior art converges on a single shape (Plaid's event sequence, Zapier's test
step, GitHub Importer's progress page). PDPP should have ONE add-account flow
skeleton whose middle step varies by modality, not three unrelated flows:

```text
A. CHOOSE      Sources page → "Add account" on a source card
B. CONNECT     modality-specific (see below)
C. IDENTITY    "Connected as the owner@gmail.com" — echo who/what was connected,
               auto-derive the connection label, create the ACTIVE connection
D. FIRST SYNC  named-stage progress page with records-so-far
E. DONE        "1,243 records collected · View records" (or honest failure
               with ONE repair action)
```

Two structural decisions distinguish this from today's flow:

**1. Activation moves earlier.** Plaid fires CONNECTED before any data is
pulled. Today PDPP keeps the connection invisible until first ingest completes
(`createDraft → captureCredential → runNow → redirect with a transient
notice`). In this design, the connection becomes a visible, ACTIVE entity at
the IDENTITY moment (C); the first sync is then a normal run on an active
connection, projected through the existing health model. This single change
eliminates the draft black hole, makes multi-account self-evident (each card
is born labeled `the owner@gmail.com`), and means the Sources page never lies about
what the owner just did.

**2. The flow ends on a status surface, not a redirect notice.** GitHub
Importer's pattern: submit → immediately land on a progress page with named
stages → terminal state offers the next action. The run timeline already
carries `PROGRESS` messages (text, stream, count/total) and the console
already polls at 3s — the data and transport exist; only the surface is
missing.

## Stage B by Modality

### B1. Static-secret (Gmail, GitHub, YNAB, …)

Manifest-driven credential form (exists), plus the one new primitive this
design introduces — the **synchronous validation moment** (Zapier's test
step):

```text
[paste credential] → Validate (≤10s) →
  ✓ "Connected as the owner@gmail.com"        → IDENTITY (C)
  ✗ "GitHub rejected this token — it may be expired. [Create a new token ↗]"
     (form state preserved, help link in new tab)
```

**Where validation lives — decision.** The Collection Profile has no
`VALIDATE`/`PREFLIGHT` message, and it should not gain one for this (the
boundary map says reference needs must not leak into protocol semantics
until they earn it). Instead:

- Add an OPTIONAL connector runtime-binding hook, `probeCredential(secret) →
  { identity, detail } | error`, reference-only.
- The setup planner (already the single source consumed by console, REST, and
  CLI) advertises per connector: `validation: synchronous | first_sync`.
- Connectors without the hook degrade gracefully: the flow skips the ✓ echo,
  the connection activates at credential capture with label pending, and
  first-sync failure carries the repair action. Honest, just less polished.
- Promotion trigger: if three or more connectors implement the hook and a
  second implementation wants it, consider promoting a probe scope into the
  Collection Profile — not before.

For the launch set: Gmail = IMAP LOGIN + fetch account email; GitHub = `GET
/user` with the PAT; YNAB = `GET /user` with the token. All three are
single-request probes that also return the identity for stage C.

### B2. Browser-bound (Amazon, Chase, ChatGPT) — the productize path

Owner decision 2026-06-10: productize, never demote. The SLVP form is
**"Finish in this browser"** — an in-dashboard interactive session, not a
copied terminal command. The streaming machinery for this exists but is
hard-coupled to an existing `run_id` (viewer route `/runs/<runId>/stream`,
registry keyed on run+interaction). The construction that satisfies it:

```text
Add account → server creates connection shell + starts an ENROLLMENT RUN
  (a bounded run whose scope is: establish session, verify identity)
→ dashboard embeds the existing streaming viewer for that run
→ owner logs into the provider inside it (MFA and CAPTCHA land in the same
  surface — the assisted-interaction machinery already handles these)
→ connector captures the session into the connection's profile and emits the
  account identity → IDENTITY (C) → first collection proceeds as a normal run
```

This reuses the run-target registry, surface allocator, companion factory,
viewer route, and persistent profile storage. The NEW work is: (a) a
connection shell that can exist before credentials (browser-bound connectors
have no draft mechanism today), (b) the enrollment-run scope, (c) identity
emission at session capture. This construction also subsumes
`add-browser-collector-enrollment-primitive` per the realignment plan.

Repair uses the same path (Plaid update mode): a `needs attention` connection's
primary action is "Reconnect", which starts an enrollment run against the
EXISTING connection — landing the owner directly at the provider login, never
back at stage A.

### B3. Local-device (Claude Code, Codex collectors)

Already published and working: dashboard mints a one-time code, owner runs
`pdpp collector enroll --code <code>` on the device. Two polish items make it
match the skeleton: the post-mint screen should poll until the device
enrolls and then advance to IDENTITY automatically ("Device 'Simon laptop'
connected") instead of leaving a static code on screen; and the command block
must carry the exact published package/version per the plan's command-surface
contract. No new machinery.

## State Model (projection, not a new enum)

Setup states are projections of existing connection-health states plus one
new pre-active phase. No parallel vocabulary:

```text
flow stage          stored as                          card shows
─────────────────────────────────────────────────────────────────────────
B validating        (ephemeral, in-request)            spinner in form
B2 enrollment run   connection shell + active run      "Finish in this browser"
C identity echoed   ACTIVE connection, no runs yet     "Active · first sync starting"
D first sync        ACTIVE + running run               "Active · syncing — 1,240 records"
E success           ACTIVE + fresh                     "Active · 1,243 records · synced now"
E failure           needs_attention (existing state)   "Needs attention · [Reconnect]"
abandoned B2 shell  retired by TTL (data-ops rule)     (nothing — never a ghost card)
```

The one genuinely new stored state is the B2 connection shell. It carries a
TTL at creation (per the data-ops retirement contract) so abandoned
enrollments self-clean.

## Copy Model

The voice at the credential moment is borrowed from Plaid: name the provider,
name the artifact, say what PDPP will and won't do with it.

- Form header: "Connect your GitHub account" — never "Configure connector".
- Credential field: manifest-authored label + "PDPP stores this encrypted on
  YOUR server. It is never shared with apps or agents." (true today —
  credential store is encrypted; grants never expose credentials)
- Validation failure vocabulary is owner-causal: "GitHub rejected this token"
  / "This looks like a password, not an app password" — never error codes.
- Identity echo: "Connected as {identity}" + editable label defaulted to it.
- First-sync stages: connector PROGRESS text verbatim when present, else
  "Collecting {stream display name}…".

## Acceptance Additions (rows for the plan's matrix)

| Journey | Acceptance bar |
|---|---|
| Credential validation moment | For registry connectors with a probe: wrong credential is rejected in ≤10s with provider-named copy and preserved form; right credential echoes account identity. |
| Identity-derived labels | Second Gmail account is born labeled with its own address; owner never types a label to disambiguate. |
| Time-to-first-value | During first sync the owner sees records-so-far counts or named stages within 15s of submit; terminal success offers "View records" which shows real records. |
| Browser-bound enrollment | Owner adds an Amazon account entirely inside the dashboard (no terminal); MFA handled in-surface; abandoning mid-login leaves no ghost card. |
| Reconnect/update mode | A needs-attention connection's primary action lands the owner directly at the repair step, not at the start of the flow. |

## Build Ledger (honesty about scope)

Reused as-is: setup planner + catalog, manifest-driven forms, static-secret
action chain, streaming viewer + interaction machinery, run timeline PROGRESS,
3s polling, local-collector enrollment, health-state projection, encrypted
credential store.

New: `probeCredential` hook + planner `validation` field (small), setup-status
page (small), identity-derived labels (small), early activation refactor
(medium — moves the activation moment, touches health projection), browser
connection shell + enrollment-run scope (large — this IS Phase 5), reconnect
update-mode routing (small once enrollment runs exist).

## Plan Integration

- Phase 2 absorbs: setup-status page, early activation, identity echo,
  validation moment for the static-secret registry.
- Phase 3 builds the Sources IA on the state projection above (no new enum).
- Phase 5 implements B2 exactly as specified here; its acceptance is the
  browser-bound matrix row.
- The five acceptance rows above append to the plan's owner acceptance matrix.
