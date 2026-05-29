# Open question: systematizing credential-bootstrap automation across connectors

**Status:** open
**Raised:** 2026-04-19
**Trigger:** the owner's observation — "if we could solve logging into Google, we could automate application-key creation the way we automated GitHub PAT creation." `bin/bootstrap-github-pat.js` already drives GitHub's PAT flow end-to-end (headed Playwright, stored creds, INTERACTION for 2FA, DOM extraction, append to `.env.local`). The same shape should generalize.

## The pattern

Many platforms expose a three-step web flow for obtaining durable API credentials:

1. **Web login** — automatable with stored user/password + INTERACTION for 2FA/device challenges.
2. **Credential-generation page** — a form or one-click generator for a PAT, app password, integration token, or OAuth app.
3. **DOM-readable result** — the generated secret is rendered on the page exactly once, extractable via selector.

`bootstrap-github-pat.js` is the exemplar. Everything in the inventory below fits the same shape or a near-variant.

## Connectors where this applies

| Connector | Credential | Pattern fit | Current state |
|---|---|---|---|
| github | PAT | 1+2+3, pure | automated |
| oura | personal access token | 1+2+3, pure | researched |
| notion | integration token | 1+2+3, pure | researched |
| gmail (Google) | app password | 1+2+3 + conditional-access gates | unknown — highest value, hardest login |
| strava | OAuth client_id/secret + refresh token | 1+2+3 + redirect-handling tail | researched |
| reddit | script app + resource-owner password | 1+2+3 | researched |
| spotify | OAuth app | 1+2+3 when unblocked | blocked (frozen app creation) |
| slack | xoxc + `d` cookie | **session-artifact extraction**, not bootstrap-generation | automated (different pattern) |
| usaa / chatgpt / amazon | none — session-auth only | **not applicable**; browser profile *is* the credential | session-only |

The "not applicable" row is important: it bounds the problem. Bootstrap automation is for class-1 (durable token) credentials; class-2 (session) is a separate pattern already handled by Playwright persistent profiles.

## What a systematic approach would look like

### A. Per-connector bootstrap scripts
Status quo extended: `bootstrap-<connector>-<cred>.js` per platform, each bespoke. Pro: no shared abstraction to maintain; each script can handle quirks. Con: N scripts of near-duplicate code; new platforms need a full custom script.

### B. Declarative bootstrap-flow manifest
Manifests declare a `credential_bootstrap` field, machine-readable:

```json
"credential_bootstrap": {
  "type": "web_form",
  "login_url": "...",
  "generate_url": "...?name={{name}}&scopes=repo,read:user",
  "form_fields": [{ "selector": "#token_expiration", "value": "none" }],
  "submit_selector": "button[type=submit]",
  "extract_selector": "#new-oauth-token",
  "interaction_hooks": ["2fa", "device_verification"]
}
```

A generic `bootstrap-runner` interprets the manifest, drives Playwright, and hands INTERACTION prompts back to the runtime for 2FA/verification branches. Pro: drastically less code per platform; flow is inspectable before execution, which aligns with the spec's consent story. Con: a flow DSL rich enough to cover sudo-mode, conditional MFA, device verification, and CAPTCHA is non-trivial.

### C. Hybrid — declarative for simple, custom for complex
Simple platforms (GitHub, Oura, Notion) declare; complex ones (Google's conditional-access, CAPTCHA-gated flows) keep custom scripts but share a common Playwright + INTERACTION scaffold. Pro: realistic path; matches observed variance. Con: two code paths to maintain.

## What this connects to

- `credential-storage-open-question.md` — bootstrap is how credentials are *obtained*; storage is how they're kept. A vault with `obtained_via: 'bootstrap_tool'` closes the loop.
- `connector-configuration-open-question.md` — `credentials_schema` and `credential_bootstrap` would be sibling manifest fields; the first declares *what* secrets are needed, the second declares *how to get them*.
- `external-tool-dependencies-open-question.md` — Playwright (and headed Chromium) is the external tool any web-bootstrap manifest depends on; declare it once.
- `unattended-operation.md` — automated bootstraps enable automated *rotation*, not just first-time setup.

## Constraints

CAPTCHA, account lockouts, MFA-without-TOTP, and Google's conditional-access checks will remain unautomated on some flows. A systematic approach must degrade gracefully to user-directed INTERACTION (headed browser handed to the owner) when automation can't proceed.

## Action items

- [ ] Inventory which remaining connectors could have bootstraps today (Oura and Notion are low-hanging).
- [ ] Decide between options A / B / C.
- [ ] If B or C: sketch the bootstrap-flow DSL against GitHub + Oura + Notion as the initial targets.
- [ ] Prioritize new bootstraps by platform value — Google is the biggest unlock; solving it likely validates Option C.
