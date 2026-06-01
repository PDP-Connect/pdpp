# ChatGPT Cloudflare Browser Posture Gap

Status: researching
Owner: reference implementation maintainer
Created: 2026-06-01
Updated: 2026-06-01
Related: openspec/changes/add-run-interaction-streaming-companion

## Question

Why does the public PDPP reference deployment still hit repeated ChatGPT Cloudflare checkbox challenges when earlier browser projects often did not?

## Context

The current public deployment routes managed connectors through n.eko-owned Chromium:

- `PDPP_NEKO_BROWSER_OWNER_MODE=neko-owned`
- `PDPP_NEKO_STEALTH_MODE=strict`
- `PDPP_NEKO_PROFILE_STORAGE_POLICY=persistent`
- `PDPP_NEKO_PROFILE_STORAGE_ROOT=/home/user/code/pdpp/tmp/neko-profiles`
- `PDPP_HOST_BROWSER_BRIDGE_URL=` is unset

The operator can click the Cloudflare checkbox in the stream, but ChatGPT may repeat the challenge. That means the browser surface is usable enough for input, but the source still classifies the browser/session/network posture as unacceptable. Earlier DataConnect notes identify persistent browser profiles as the primary practical stealth strategy: owners log in once, and later runs reuse the session rather than walking the login/challenge path. They also identify CDP artifacts, browser fingerprint signals, behavior, and session history as the meaningful detection layers; headed mode alone is not a strong stealth fix.

## Stakes

The n.eko stream can be a good SLVP owner-control surface and still be the wrong posture for stealth-sensitive ChatGPT login. Treating checkbox interactivity as sufficient would leave the owner stuck in a challenge loop and make the reference look broken even when the stream transport is working.

## Current Leaning

Keep n.eko-owned Chromium as the reference/default streaming surface, but do not call it sufficient for stealth-sensitive ChatGPT login until a warmed profile succeeds repeatedly. For ChatGPT, the likely high-confidence path is a browser-owner or Patchright-compatible profile with real session persistence. Do not add programmatic CAPTCHA bypass; the intended fix is better browser ownership/session continuity, not solving challenges automatically.

## Promotion Trigger

Promote this into OpenSpec if ChatGPT is listed as a proven public-reference connector, if the browser-owner mode semantics change, or if the operator console needs a runtime choice between n.eko-owned and owner-browser-backed execution for stealth-sensitive connectors.

## Decision Log

- 2026-06-01: Captured after the public reference deployment showed repeated ChatGPT Cloudflare checkbox challenges despite a working stream. Current evidence points to browser/session posture, not stream input delivery.
