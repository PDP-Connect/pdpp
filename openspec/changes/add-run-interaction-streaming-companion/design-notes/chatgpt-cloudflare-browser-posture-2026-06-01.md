# ChatGPT Cloudflare Browser Posture Gap

Status: researching
Owner: reference implementation maintainer
Created: 2026-06-01
Updated: 2026-06-01
Related: openspec/changes/add-run-interaction-streaming-companion

## Question

Why does the public PDPP reference deployment still hit repeated ChatGPT Cloudflare checkbox challenges when earlier browser projects often did not?

## Context

The current public deployment is configured to route managed connectors through n.eko-owned Chromium:

- `PDPP_NEKO_BROWSER_OWNER_MODE=neko-owned`
- `PDPP_NEKO_STEALTH_MODE=strict`
- `PDPP_NEKO_PROFILE_STORAGE_POLICY=persistent`
- `PDPP_NEKO_PROFILE_STORAGE_ROOT=/home/user/code/pdpp/tmp/neko-profiles`
- `PDPP_HOST_BROWSER_BRIDGE_URL=` is unset

The operator can click the Cloudflare checkbox in the stream, but ChatGPT may repeat the challenge. That means the browser surface is usable enough for input, but the source may still classify the browser/session/network posture as unacceptable.

Current evidence weakens the earlier broad hypothesis that "CDP plus datacenter IP cannot pass ChatGPT Cloudflare." The owner successfully passed the same class of challenge from the remote-browser-sandbox GCP VM using direct datacenter networking, CDP screencast rendering, and CDP input. The meaningful delta is therefore more likely the exact browser launch/profile/path PDPP used for the run, not CDP or datacenter egress by itself.

The active public ChatGPT run also showed no browser-surface lease events while the deployment configured `PDPP_NEKO_MANAGED_CONNECTORS` with canonical connector URLs. The run source id was the short `chatgpt` id. If those identifiers are compared literally, the run can bypass the intended managed n.eko path and fall back to connector-local browser handling. That does not explain the Cloudflare loop by itself, but it makes the test invalid: the run is not necessarily using the browser posture the operator thinks is configured.

## Stakes

The n.eko stream can be a good SLVP owner-control surface and still be the wrong posture for stealth-sensitive ChatGPT login. Treating checkbox interactivity as sufficient would leave the owner stuck in a challenge loop and make the reference look broken even when the stream transport is working.

## Current Leaning

First remove path-selection ambiguity: canonical connector URLs and short runtime `connector_id` values must select the same managed n.eko policy. After that, rerun ChatGPT and compare the actual emitted run events and browser launch/profile facts against the successful remote-browser-sandbox posture. Do not add programmatic CAPTCHA bypass; the intended fix is correct browser ownership/session continuity, not solving challenges automatically.

## Promotion Trigger

Promote this into OpenSpec if ChatGPT is listed as a proven public-reference connector, if the browser-owner mode semantics change, or if the operator console needs a runtime choice between n.eko-owned and owner-browser-backed execution for stealth-sensitive connectors.

## Decision Log

- 2026-06-01: Captured after the public reference deployment showed repeated ChatGPT Cloudflare checkbox challenges despite a working stream. Current evidence points to browser/session posture, not stream input delivery.
- 2026-06-01: Owner passed a ChatGPT Cloudflare challenge from remote-browser-sandbox on GCP with direct datacenter networking, CDP screencast rendering, and CDP input. This rules out "CDP/datacenter cannot pass" as a sufficient explanation.
- 2026-06-01: Active-run evidence suggested a managed-connector identity mismatch: config used `https://registry.pdpp.org/connectors/chatgpt`, while the run source used `chatgpt`. The runtime now treats canonical `/connectors/{connector_id}` URLs and short ids as the same managed policy identity, including static single-connector profile defaults.
