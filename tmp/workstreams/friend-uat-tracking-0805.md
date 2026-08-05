# Friend and self-host delivery tracker

Date: 2026-08-05
Owner: PDPP RI owner

## Objective

Make the first-run/self-host path coherent and testable for a non-developer user without hiding real capability boundaries. The runtime candidate and the `apps/site` `/reference` page are separate deliverables; the runtime candidate does not implement the site UI.

## Runtime candidate

- Candidate: `0b17dec67289df1af26e594600507f1250f16213`
- Branch: `waspflow/friend-uat-integration-0805`
- Base: current `pdp/main` `cc07e3a896c2c0df7841da4ec6b2c660ffe1e792`
- Candidate is 345 commits ahead of that base and has no divergence.
- ChatGPT manual repair reuses an existing Google session only for owner-attended, credentialless repair; scheduled repair remains fail-closed; ChatGPT's own `/api/auth/session` is the success authority.
- Source setup pages no longer present dead browser/manual-upload actions as if every runtime supported them; browser-free deployments explain the missing capability.
- Missing embedding models are a non-blocking readiness state: lexical search remains usable while semantic assets are unavailable or downloading.
- Local collector documentation and route consistency use `/device-exporters`, not the obsolete dashboard-prefixed path.

## Verified evidence

- Focused ChatGPT tests: 23/23.
- Source-setup route test: 2/2.
- Deployment-readiness tests: 43/43.
- Local collector consistency test: 6/6.
- Polyfill-connectors typecheck and console `types:check`: pass.
- Changed-file formatting/lint and `git diff --check`: pass.
- Disposable `railway-core` Docker canary: build and authenticated route checks passed; browser-free capability messaging was present. The canary was removed after testing.

## Site-owned work

`main-30:22` owns PR #75 in `apps/site` and must port the approved lean `/reference` concept there. It should keep the page to one promise, one sentence, one dominant generated command, and installation tabs for Docker/Compose/Railway. A thin goal-based builder may expose only: local versus web-app access, semantic search as an included default, and optional browser-backed sources. Advanced variables, profiles, ports, and service names belong behind an advanced link. Localhost supports local MCP clients such as Codex and Claude Code; hosted MCP clients require an HTTPS-reachable deployment. The site must not advertise a stale or unverified image, Compose asset, or dead GitHub download.

The site lane must verify the actual fresh-clone run command, render all four pages at desktop and mobile sizes, and hand off a reviewable branch/PR. It must not implement this page in the runtime candidate or touch connector code.

## Release and UAT gates

1. Push the clean runtime candidate as a new branch to `PDP-Connect/pdpp`; do not merge it into `main` without the normal review gate.
2. Build a fresh local image from the pushed candidate SHA and retain its tag for owner testing.
3. Deploy only through the watched live-stack cadence after the branch is reviewed; then exercise ChatGPT manual repair, source setup capability messaging, embedding readiness, and collector enrollment.
4. Treat the current published `:main`/release artifacts as untrusted until rebuilt and checked against the exact source. The known stale-image and missing-release-asset findings are release failures, not documentation-only issues.
5. Keep the separate live connector-health lanes (USAA, ChatGPT session continuity, local-collector evidence, Slack optional absence) in their own gates; do not claim the fleet is green merely because this friend-readiness candidate passes.

## Explicit non-goals for this batch

- No full browser hibernation implementation.
- No route aliases for stale images.
- No silent browser identity changes or credential bypass.
- No publication of a mutable or unverified artifact as the recommended command.
- No remote merge or live mutation without the corresponding gate and evidence.
