# Platform bootstrap research — which connectors can we automate?

**Status:** research complete, partial implementation
**Raised:** 2026-04-19

## Summary

After building the GitHub PAT bootstrap (`bin/bootstrap-github-pat.js`), we investigated whether other pending-credential connectors support the same flow. Findings below determine which are worth automating vs. "user pastes token once."

## Per-platform verdict

| Platform | Verdict | Reason |
|---|---|---|
| **GitHub** | ✅ Done | Classic PAT at `/settings/tokens/new` with URL-param prefill. `bin/bootstrap-github-pat.js` drives it end-to-end. |
| **Notion** | 🟡 Automate | Internal integration at `notion.so/my-integrations` yields `ntn_…` secret. No sudo mode found. Single-page form. |
| **Oura** | 🟡 Automate | PAT at `cloud.ouraring.com/personal-access-tokens`. Single-page form. Requires active Oura Membership. |
| **Pocket** | 🚫 **Remove** | Mozilla shut Pocket down July 8 2025. Data deletion Oct 8 2025. Dev portal gone. Our connector is vestigial. |
| **Spotify** | 🚫 **Blocked** | Feb 2026 — Spotify froze new developer app creation. OAuth-only, and the OAuth flow needs redirect callbacks. Even manual setup is blocked right now. |
| **Strava** | 🚫 Not PAT | Dashboard creates OAuth app (client_id + secret). Full auth-code flow with redirect_uri required. Automation saves one click, not the flow. |
| **Reddit** | 🚫 Not PAT | Script-type app yields client_id + secret, but auth still uses Resource Owner Password grant. Page is gated by anti-bot (captcha risk). Automation fragile. |
| **Slack** | 🚫 Not PAT | Needs slackdump CLI + workspace OAuth; different animal. Handled separately. |

## Pattern: when is a PAT bootstrap worth automating?

Three criteria must all be met:

1. **Platform exposes a PAT-style credential** (long-lived token generated from a form, not an OAuth authorization code).
2. **Token creation page is URL-addressable** with optional query-param prefill for scopes/name.
3. **Token is visible in DOM immediately** after form submit (shown-once pattern).

When ANY criterion fails, "user pastes token once" is the correct UX and trying to automate adds flakiness without meaningful benefit.

## Cases we should automate

### Notion

- **URL:** `https://www.notion.so/my-integrations` → "New integration" button
- **Fields:** name, associated workspace, capabilities checkboxes (read/update/insert content, comments, user info)
- **Token read:** "Show" button reveals token starting with `ntn_`, has clipboard-copy element
- **Prerequisite:** user must be Workspace Owner; fails silently otherwise

### Oura

- **URL:** `https://cloud.ouraring.com/personal-access-tokens`
- **Fields:** name/note, create button
- **Token read:** shown once post-creation, starts with a provider prefix
- **Prerequisite:** active Oura Membership (free tier no longer has API access)

Both follow github's shape — reuse `src/auto-login/<platform>.js` + `bin/bootstrap-<platform>-pat.js`.

## Action items

- [ ] Delete or mark-deprecated: `packages/polyfill-connectors/manifests/pocket.json` + connector. Document why in tombstone.
- [ ] Mark spotify connector as "blocked upstream" pending Spotify re-opening app creation. Keep the manifest; it'll work when OAuth resumes.
- [ ] Build `bin/bootstrap-notion-token.js` (Notion login → /my-integrations → new integration → read ntn_ token → write to env)
- [ ] Build `bin/bootstrap-oura-pat.js` (Oura login → /personal-access-tokens → create → read → write to env)
- [ ] Document in readme that Strava/Reddit require manual OAuth app registration before connectors can run (one-time paste, not recurring)

## What this tells us about the spec

PDPP's manifests today declare `runtime_requirements.bindings` but not *how* credentials are sourced. A principled spec might add:

```json
"credentials_schema": {
  "type": "object",
  "properties": {
    "OURA_PERSONAL_ACCESS_TOKEN": {
      "type": "string",
      "format": "password",
      "bootstrap": {
        "type": "browser_pat",
        "url": "https://cloud.ouraring.com/personal-access-tokens",
        "requires_session": "oura.com",
        "instructions": "After logging in, click 'Create A New Personal Access Token'."
      }
    }
  }
}
```

That way, the orchestrator can offer the user a "bootstrap automatically" button only for providers whose manifest declares a known bootstrap type. For OAuth platforms, the manifest declares the OAuth flow URL + scopes and the orchestrator drives it via a browser redirect instead. See `connector-configuration-open-question.md` for the broader configuration-surface discussion.
