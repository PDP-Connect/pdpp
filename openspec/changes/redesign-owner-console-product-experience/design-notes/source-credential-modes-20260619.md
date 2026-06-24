# Source Credential Modes

Status: captured
Owner: RI owner
Created: 2026-06-19
Related: `openspec/changes/redesign-owner-console-product-experience`

## Question

How should the reference implementation support direct credentials, streamed
browser login, and ephemeral login cleanup without repeating the Amazon
wrong-account failure?

## Context

the owner reported that adding another Amazon source created a source and started
collection without asking for credentials or showing the browser stream. The
source appeared to collect against the wrong account because the browser setup
could consume deployment-wide `AMAZON_USERNAME` / `AMAZON_PASSWORD`.

The immediate fix was to prevent connection-scoped Amazon setup from satisfying
a new source with deployment-wide Amazon credentials. the owner then corrected the
broader interpretation: OTP helpers and direct login helpers are not inherently
wrong. They are wrong only when they are deployment-wide provider account
credentials or when they are not bound to the source being created.

## Decision

Source setup SHALL support three source-scoped modes:

- **Stored source credential:** the owner may provide a credential bundle for one
  source, such as username/password, token, app password, recovery code, OTP
  seed, cookie, or source-specific OAuth material. The credential is stored only
  in the encrypted credential store and is never represented as a deployment-wide
  provider account env var. When the owner opts into this mode, the runtime may
  reuse that credential for this same source to try login again after the browser
  session expires, and should bother the owner only when the stored credential is
  absent, rejected, insufficient, or requires fresh human action.
- **Streamed browser proof:** browser-backed connectors use an owner-visible
  browser session scoped to the exact source profile. This remains the default
  proof path and the fallback when stored credentials are absent or insufficient.
- **Ephemeral browser proof:** the owner may choose a mode where the browser
  session and credential material are cleared after collection. This should be
  proven on one connector before it is presented as generally available.

Deployment-wide env vars may configure infrastructure and provider app settings
where appropriate, but they SHALL NOT represent a provider user account for
source setup or scheduled collection.

## Implementation Consequences

- Keep OTP/login helper code when it can operate on source-scoped credentials or
  owner interactions.
- Remove or fail closed any path that reads deployment-wide provider account
  env vars to authenticate a source.
- Static-secret connectors should require the encrypted per-source credential
  store, with no plaintext/env fallback for provider account secrets.
- Browser connectors should resolve an explicit source credential bundle before
  attempting assisted login; otherwise they should request streamed browser
  login for the source profile.
- Browser-backed credential setup should present both choices explicitly:
  save source-scoped credentials and start setup, or use the secure browser
  without saving provider credentials. After stored-credential setup, the secure
  browser is conditional: the status page opens it only when the run emits a
  current owner interaction for login, OTP, challenge, or identity confirmation.
- The setup UI should echo source/account identity before accepting records for
  a new source, or clearly show that identity is still unverified.

## Acceptance Checks

- Creating a second Amazon source cannot use `AMAZON_USERNAME` /
  `AMAZON_PASSWORD` from deployment env.
- A source-scoped stored credential can be used only for the source it belongs
  to, and tests prove it cannot satisfy another source.
- Browser setup for a new source emits an interaction or status requiring login
  unless that exact source profile is already authenticated.
- Browser-backed credential setup tells the owner that saved credentials can be
  retried for the same source when the browser session expires, and offers a
  browser-only path for owners who do not want credentials stored.
- No connector-specific UI hardcodes provider forms outside connector manifests
  or connector-owned setup descriptors.
- At least one browser connector proves ephemeral cleanup before the option is
  advertised broadly.

## Risks

- Removing helper code is tempting but wrong if it removes support for
  source-scoped credential mode.
- Keeping helper code is dangerous unless tests prove it cannot read
  deployment-wide provider account env vars.
- Identity echo is connector-specific in practice; the UI should render it from
  connector output or setup descriptors rather than hardcoding provider logic.
