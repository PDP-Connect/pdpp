# Static-Secret Connection Runbook (Gmail, GitHub)

Status: reference-experimental operator surface. Not PDPP Core or Collection
Profile protocol.

This is the owner-run proof/debug runbook for creating a **first** static-secret
connection (Gmail or GitHub) on your own reference instance. The normal happy
path is the console form at `/dashboard/connect/static-secret/:connectorId`,
which performs the same draft → capture → first-sync sequence from an owner
session. This runbook remains the operator reference for the underlying route
sequence and for producing live proof that a real provider secret (a Gmail app
password or a GitHub personal access token) drives a live API ingest that flips
a `draft` connection to `active`.

It documents the owner-session sequence the add-connection picker automates, and
it doubles as the live-proof packet for provider-backed verification evidence.

## What already works without a human

The deterministic, no-secret half of the static-secret lifecycle is implemented
and unit-tested in this repo. The `draft` connector-instance status, the
owner-session draft-create route, draft-target credential capture, and
first-ingest activation all landed under
`add-static-secret-owner-session-connect-path` (tasks 1–7). The connection-scoped
encrypted credential store, the owner-session capture route, and the
connection-scoped subprocess injection landed earlier under the archived
`add-static-secret-owner-connect-primitive`.

What the harness cannot prove is that a **real, live provider secret** authorizes
a **real API session** that ingests records. That step needs a real Gmail app
password or GitHub token against live IMAP/API — exactly the step the design
keeps owner-mediated. Faking it (a mock that asserts the happy path without a
real provider session) would violate the design's "no faked success" bar.

## Prerequisites

- A reference instance you control, running with credential encryption
  configured: the `PDPP_CREDENTIAL_ENCRYPTION_KEY` environment variable must be
  set, or the capture route returns `503 credential_encryption_key_missing` and
  no secret is ever stored.
- An owner **session** (cookie auth). The static-secret draft-create and capture
  routes are `requireOwnerSession` — they are not owner-agent bearer routes. A
  browser owner session or an owner-session cookie jar reaches them; an owner
  bearer token does not.
- A provider secret you generate yourself and never paste into a shared surface:
  - Gmail: a Google **app password** (requires 2-Step Verification on the
    account). Not your account password.
  - GitHub: a **personal access token** (classic or fine-grained) with the
    read scopes the GitHub connector needs.

The reference never asks for, prints, or logs the secret. You paste it once, into
the capture request body, from your own session.

## The owner sequence (draft → capture → first ingest → active)

Each step's response carries a typed `next_step` pointing at the following step,
so the sequence is self-describing. `:connectorId` is `gmail` or `github`.

### Step 1 — Create the draft connection

```
POST /_ref/connectors/:connectorId/draft-connection
```

Owner-session only. Creates one invisible `draft` connector instance with a fresh
random source-binding key and returns its `connection_id`. No secret is involved.
Two calls for the same connector create two distinct connections (two mailboxes
→ two `connection_id`s). A non-static-secret connector is refused with
`409 static_secret_credential_unsupported`.

The draft is **invisible** to every connection read surface (`/_ref/connections`,
`/_ref/connector-instances`, the dashboard) by construction — it does not appear
anywhere until it activates. This is the no-phantom-active-row guarantee: a first
connection never mints a visible zero-record row.

Record the returned `connection_id` (a `cin_*` id) for the next step.

### Step 2 — Capture the provider secret onto the draft

```
POST /_ref/connections/:connectionId/static-secret-credential
Content-Type: application/json

{ "credential_kind": "app_password",            // gmail
  "secret": "<your Gmail app password>" }

{ "credential_kind": "personal_access_token",   // github
  "secret": "<your GitHub token>" }
```

Owner-session only. Seals the secret into the encrypted per-connection credential
store. The plaintext appears **only** in this request body and the store's
sealing call. The response and the audit event
(`owner.connection.static_secret_credential.capture`) carry non-secret metadata
only (presence, kind, fingerprint, timestamps). A wrong `credential_kind` for the
connector is rejected (`400 credential_kind_mismatch`) before any sealing.

### Step 3 — Run the connection (first ingest)

```
POST /_ref/connections/:connectionId/run
```

Runs the connector with the captured secret injected, connection-scoped, into the
subprocess environment (last over `process.env`, so a stored secret takes
precedence over any process-global). The connector authenticates against the live
provider, fetches records, and POSTs them back through the RS ingest endpoint.

### Step 4 — First successful ingest activates the draft

When the first ingest accepts at least one record (`records_accepted > 0`), the
RS ingest host boundary flips the `draft` instance to `active` via
`activateDraft`. The connection now appears on `/_ref/connections` and the
dashboard. A failed run, a missing credential, or a zero-record run leaves the
instance `draft` and invisible — there is no half-created visible connection.

## The live-proof artifact (what closes D.1)

The gate is closed when the following is recorded (on a proof branch, no secrets
committed):

1. The `connector_id` (`gmail` / `github`), the `connection_id` the draft route
   minted, and the per-stream `records_accepted` counts from the first ingest.
2. The spine event ids for the run: the
   `owner.connection.static_secret_draft.create` (draft), the
   `owner.connection.static_secret_credential.capture` (capture), and the ingest
   that flipped the draft — **with no secrets, cookies, tokens, names, or
   addresses** in the note.
3. A repeat with a **second** mailbox/account for the same connector, showing two
   distinct `connection_id`s each ingesting independently (the
   two-mailboxes-two-connections requirement).

### No-secret-leak checks (run these before recording evidence)

- **Capture response and audit carry no secret.** Confirm the
  `static-secret-credential` response `credential` block is metadata only
  (`present`, `credential_kind`, `fingerprint`, `*_at`) and the
  `owner.connection.static_secret_credential.capture` spine event `data` contains
  no `secret` field. The fingerprint is a non-reversible digest, not the secret.
- **No read surface returns the secret.** `GET /_ref/connections` and the
  per-connection detail expose status and metadata, never the stored secret.
- **The draft create audit carries no secret.** The
  `owner.connection.static_secret_draft.create` event carries only
  `connection_id`, `connector_id`, `credential_kind`, and outcome.
- **Encryption was actually required.** With `PDPP_CREDENTIAL_ENCRYPTION_KEY`
  unset, capture must fail closed with `503 credential_encryption_key_missing`
  and store nothing — confirm the instance has no credential after such an
  attempt.
- **Logs are clean.** Grep the run logs for the secret value; it must not appear.

## What result justifies claiming live provider proof

The console add-connection picker surfaces Gmail/GitHub under "Static-secret
sources" and links to the owner-session form. Owner-agent setup returns a
non-secret `capture_static_secret` next step with that dashboard path. Neither
surface returns provider credentials or marks a connection active before ingest.

Claim live provider proof for a connector **only** when, in the same reviewable
unit:

1. The D.1 artifact above is recorded for **both** Gmail and GitHub (a live
   `draft → capture → first ingest → active` round trip with `records_accepted >
   0`), and
2. The no-secret-leak checks all pass and are noted, and
3. Two accounts for one connector produce two independent active connections.

Until that artifact exists, the honest status is "real owner-session path,
active only after ingest proof" — which is exactly what this runbook documents.

## Related

- `openspec/changes/add-static-secret-owner-session-connect-path/{proposal,design,tasks}.md`
  — the draft-connect-path change that introduced the static-secret lifecycle.
- `reference-implementation/server/routes/ref-static-secret-draft-connection.ts`
  — the owner-session draft-create route (Step 1).
- `reference-implementation/server/routes/ref-static-secret-credentials.ts`
  — the owner-session capture route and the static-secret connector source of
  truth (`STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR`).
- `docs/operator/browser-collector-proof-runbook.md` — the sibling owner-run
  proof runbook for the browser-collector (Amazon) path.
- `docs/voice-and-framing.md` — connector maturity vocabulary; a connector is not
  "working" until its proof state says so.
