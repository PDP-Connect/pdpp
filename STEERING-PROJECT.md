# PDPP Project Steering Handoff

Last updated: 2026-06-11.

Purpose: this is a dense handoff for the next agent. It preserves the useful state from a long RI-owner session and strips the chat noise. Treat this as a starting map, not canonical truth. Always verify live repo/deployment state before acting.

## Non-Negotiable Operating Rules

- Read `AGENTS.md`, `docs/agent-workstream-playbook.md`, and `docs/voice-and-framing.md` before non-trivial work.
- This repo is OpenSpec-driven. Non-trivial behavior, protocol, schema, endpoint, architecture, dashboard, or durable UX changes need an OpenSpec change kept in lockstep with code.
- Before coordinating, merging, launching workers, reporting status, or declaring anything complete, run:
  ```bash
  pnpm workstreams:status -- --no-fail
  ```
- Do not use xhigh workers unless the owner explicitly asks for xhigh. Default delegated workers should be Claude/5.5 Low style.
- Delegation should be valuable, not busywork. Use workers for bounded implementation, audits, or research that writes facts to disk under `tmp/workstreams/` or `docs/research/`.
- Codex token burn matters. Keep owner work low/medium burn, use context-mode tools for repo inspection, and do not paste large logs into chat.
- Never merge, close, reopen, or rewrite PRs without explicit owner approval. Earlier in this session, unapproved PR merges caused trust damage; do not repeat it.
- Never deploy a dirty reference build. The stack intentionally refuses dirty tracked builds; use a clean worktree or commit reviewed changes.
- `/mcp` must reject owner/control-plane bearers. Owner tokens are for owner REST/control-plane flows, not grant-scoped MCP.
- If the owner asks for a live-ready notification, use `ntfy` when ready. Do not claim ready before live validation.

## Current Snapshot To Re-Verify

Run these first in a resumed session:

```bash
cd /home/user/code/pdpp
git status --short
git log --oneline -12
openspec list --json
pnpm workstreams:status -- --no-fail
curl -sS -D - http://127.0.0.1:7662/ -o /tmp/pdpp-root.json | sed -n '1,30p'
```

Most recent observed repo state on 2026-06-11:

- `HEAD`: `dd3d626d Surface Google Data Portability OAuth config`
- Recent notable commits:
  - `0141d4a5 Reframe wall-clock/fetch caps as opt-in envelopes; pin run_cap_deferred invariant`
  - `acfc6378 Add Google Maps Data Portability API runtime`
  - `922323c8 chore: dead-code purge + archive 6 completed OpenSpec changes`
- Main worktree had 10 untracked changed paths, all apparently research/design artifacts:
  - `docs/research/brand-package-coverage-audit-2026-06-11.md`
  - `docs/research/chatgpt-cooldown-and-gap-drain-diagnosis-2026-06-11.md`
  - `docs/research/congestion-control-theory-for-http-rate-governor-2026-06-10.md`
  - `docs/research/parallel-audits-rollup-2026-06-11.md`
  - `docs/research/sdk-and-ui-seams-prior-art-2026-06-11.md`
  - `docs/research/slvp-adaptive-collection-ideal-2026-06-11.md`
  - `docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md`
  - `docs/research/user-facing-copy-audit-2026-06-11.md`
  - `docs/research/wallclock-cap-ideal-verdict-2026-06-11.md`
  - `openspec/changes/harden-multipath-stream-discovery/`
- Do not delete or overwrite these without reviewing them; they are likely worker outputs or newly staged design work.

Workstream status reported many dirty worktrees. Important ones to inspect before acting:

- `../pdpp-worktrees/ri-cimd-console-api-v1` dirty=2
- `../pdpp-worktrees/ri-chatgpt-tail-deferral-bound-v2` dirty=3, unmerged-main=2
- `../pdpp-worktrees/ri-owner-agent-closeout-v1` dirty=1
- `/home/user/.tmp/pdpp-ri-self-service-final-validate-v1` dirty=34, unmerged-main=1
- `/home/user/.tmp/pdpp-ri-self-service-journey-final-review-v1` dirty=34, unmerged-main=1
- Several `.claude/worktrees/agent-*` directories dirty. Treat as worker-owned until inspected.

Wrapper lane warnings seen:

- `ri-cimd-auth-review-v1` failed/recovered with missing report.
- `ri-cimd-console-api-v1` had a thin transcript; Claude may not actually have run. Check `tmp/workstreams/claude-wrapper/ri-cimd-console-api-v1/20260609T215524Z/transcript.log`.

## Active OpenSpec State Seen 2026-06-11

Current active/completed changes from `openspec list --json`:

- `harden-multipath-stream-discovery` 0/7 in-progress
- `add-google-maps-data-portability-connector` 16/21 in-progress
- `ship-adaptive-collection-rate-controller` 31/32 in-progress
- `generalize-adaptive-collection-governor` 20/20 complete
- `complete-self-service-connection-onboarding` 43/46 in-progress
- `prove-single-use-grant-consumption` 9/11 in-progress
- `render-three-class-consent-authorship` 17/17 complete
- `gate-hosted-owner-exposure` 12/16 in-progress
- `add-google-maps-timeline-import` 15/15 complete
- `add-aggregate-other-rollup` 16/16 complete
- `reduce-mcp-tool-surface-footprint` 19/22 in-progress
- `define-mcp-agent-entrypoint-surface` 77/78 in-progress
- `fix-scheduled-run-store-credential-injection` 10/10 complete
- `make-mcp-result-ids-self-contained` 12/12 complete
- `publish-reference-browser-image` 7/8 in-progress
- `adopt-single-release-channel` 16/21 in-progress
- `publish-mcp-server-package` 14/18 in-progress
- `surface-run-handle-resolvability` 8/8 complete
- `add-docker-core-deploy-target` 8/11 in-progress
- `add-provider-budget-run-control` 21/32 in-progress
- `add-console-connection-revoke-delete-controls` 17/17 complete
- `migrate-postgres-semantic-index-to-pgvector` 15/17 in-progress
- `add-statement-content-fingerprint` 3/28 in-progress
- `add-browser-collector-enrollment-primitive` 14/16 in-progress
- `republish-remote-surface-as-opendatalabs` 38/46 in-progress

Older session references to `add-mcp-cimd-client-identity` may be stale. It was active earlier, but it no longer appeared in the 2026-06-11 OpenSpec list. If resuming CIMD, inspect `define-mcp-agent-entrypoint-surface`, `ri-cimd-console-api-v1`, current commits, and archived changes before assuming the old change folder is authoritative.

## Highest-Level User Goals

the owner’s durable priority order from the session:

1. Rock-solid read surface: ChatGPT/MCP/CLI/REST should work predictably, with typed filters, stable schemas, sane result sizes, and no host-visible drift.
2. ChatGPT connector should “just work”: fully adaptive, fastest safe collection, hands-off schedules, no primary hard caps masquerading as ideal behavior.
3. Version churn should be semantically rational: no `versions/record > 1` stream unless each retained version is justified; historical data should be compacted/canonicalized correctly.
4. Connections must be fully configurable in the UI. A fresh Railway/self-host instance that cannot add/configure connections is considered useless.
5. Pushbutton self-hosting must be real: Railway first, then Fly.io/Coolify, with good defaults and minimal env burden.
6. After those, the owner wants to add more Amazon/Gmail connections and then build a location-data connector.

## MCP Tool Surface / ChatGPT Read Surface

What happened:

- First MCP footprint tranche was deployed as reference revision `560a4a2f`.
- It added server `instructions`, shortened repeated descriptions, preserved typed filter object schemas, and passed local MCP package tests.
- the owner retested on `chatgpt.com` after delete/re-add and confirmed:
  - `filter` schema is object/record, not string, for `query_records`, `search`, and `aggregate`.
  - 14 tools exposed, including read tools and event subscription tools.
  - Runtime checks passed: `schema`, `list_streams`, `query_records` with typed filter object, lexical `search`, and `aggregate count` with typed filter object. No failures observed.

Reviewer criticism the owner accepted:

- First tranche was only a safe down payment, not SLVP ideal, because it mostly trimmed prose and kept structural costs.
- Measured first-tranche payload was about 38.5 KB / 9,628 est tokens with event tools consuming about 12.4 KB.
- Event tools and schema bulk were the high-impact levers, not description trimming.

Current observed local package measurement on 2026-06-11 suggests later work improved the default surface:

- `TOTAL bytes=22188`, `est_tokens=5547`, `instructions_bytes=1041`
- `EVENT bytes=0`
- Largest default tools:
  - `query_records bytes=6424 schema=4675 desc=828`
  - `aggregate bytes=4730 schema=2851 desc=958`
  - `search bytes=4667 schema=2472 desc=775`
  - `schema bytes=3259 schema=1301 desc=1043`
  - `fetch bytes=3108 schema=1610 desc=939`

Interpretation:

- The default surface appears to have tiered event tools out of `tools/list`, which is aligned with the structural SLVP direction.
- Still slightly above the community-reported 5k token target, but that cap is unverified, not official. The ideal gate should be framed as: minimize host-visible default tools while preserving full capability through discoverable/tiered action surfaces, and measure regression budgets.
- Before declaring done, retest host-visible ChatGPT behavior again and update `reduce-mcp-tool-surface-footprint` tasks/design with measured state.

Official docs conclusions from earlier:

- MCP supports server `instructions` during initialize.
- OpenAI Apps SDK guidance uses server instructions and emphasizes first 512 characters should be self-contained.
- `structuredContent` is model-visible/usable; `_meta` is the hidden/widget channel. Do not claim `structuredContent` is hidden.

## CIMD / MCP Agent Entrypoint

Key design alignment from the session:

- Linear-like UX is the model: an agent should connect via OAuth-like flow, not by manually pasting owner bearer tokens.
- Owner bearer tokens can be useful for local owner-agent REST/control-plane access, but `/mcp` must reject owner bearers.
- Claude/Codex UX ideal:
  - Claude web/chat-hosted MCP: user enters the MCP server URL, completes OAuth, gets grant-scoped tool access.
  - Claude Code/Codex CLI: should have a clear setup flow that does not require leaking owner credentials into `/mcp`; if owner-token local bypass exists, it must be explicitly owner-control-plane and not confused with grant-scoped MCP.
- CIMD/client metadata documents should provide stable client identity without requiring dynamic registration for every agent host.
- Loopback native clients: if a client registers `http://localhost`, `127.0.0.1`, or `[::1]` redirect URIs without declaring `application_type: "native"`, the AS should infer native/public-client treatment. This was accepted as OAuth 2.1/RFC 8252-aligned.
- Resource metadata bug for Claude: Claude docs require protected-resource metadata `resource` to match the MCP server URL entered in Claude. A change from `/mcp` resource to origin-only was suspected to break Claude. Fastest path discussed was to restore/align resource metadata to what Claude expects and retest.

Open issue:

- There were Claude connection failures with references like `ofid_...`. A Claude console 404 on `/api/claude_code/.../user_settings` looked likely unrelated, but this was not proven.
- Do not “throw slop at the wall.” Before changing MCP/OAuth semantics, check official MCP/OAuth docs and, when useful, dispatch a low research worker to document facts on disk.

## ChatGPT Connector / Adaptive Collection

Durable user requirement:

- ChatGPT should be as hands-off as possible and collect as fast as safely possible.
- Hard per-run conversation caps and wall-clock caps are not the pinnacle ideal if they are primary control mechanisms.
- The desired abstraction is general-purpose for providers with uncertain throttling, not ChatGPT-specific.
- Best-known ideal: adaptive provider governor with circuit/congestion behavior, durable progress, resumable gaps, provider-pressure telemetry, and safe scheduling. Envelopes like wall-clock/fetch caps can exist as opt-in deployment safety bounds, not as the primary algorithm.

Important artifacts/changes:

- `docs/research/slvp-adaptive-collection-ideal-2026-06-11.md`
- `docs/research/wallclock-cap-ideal-verdict-2026-06-11.md`
- `docs/research/chatgpt-cooldown-and-gap-drain-diagnosis-2026-06-11.md`
- `docs/research/congestion-control-theory-for-http-rate-governor-2026-06-10.md`
- `generalize-adaptive-collection-governor` 20/20 complete
- `ship-adaptive-collection-rate-controller` 31/32 in-progress
- `add-provider-budget-run-control` 21/32 in-progress
- Commit `0141d4a5` reframed wall-clock/fetch caps as opt-in envelopes and pinned the `run_cap_deferred` invariant.

Earlier ChatGPT/data-connect findings:

- Vana/data-connect ChatGPT connector appeared lossy for large histories. DataConnect run later failed.
- ChatGPT source may throttle users with large histories; users can understand slow collection if it is automatic, resumable, and safe.
- Browser-side batch shape and request pressure were investigated; no convincing proof that old DataConnect could complete huge histories in 30 minutes without loss/rate limits.

Do before telling the owner to rerun ChatGPT:

- Verify current deployed code includes the adaptive governor tranche, not just docs/specs.
- Verify schedules use the new governor and do not terminate due to primary hard caps.
- Run a low-pressure live proof with owner available only if needed.
- Tell the owner exactly what run behavior to expect and what message indicates healthy deferral vs. a defect.

## Version Churn / Records Health

User’s standard:

- Goal is not “make warnings less scary.” Goal is rational, logical retained history.
- Every `versions/record > 1` stream must be audited. If versions are semantically real, document why. If not, fix connector canonicalization and compact historical data accordingly.
- Ideal construction: old/worse connector output plus canonical compaction should converge to the same current/history data as new/better connector output from the same starting point.
- Compaction must be connector-agnostic where possible, but stream semantics matter.

Known open area:

- `add-statement-content-fingerprint` is only 3/28 in-progress. This likely owns part of statement churn cleanup.
- Prior watch rows included USAA accounts/statements, Chase statements, Claude Code sessions. The session demanded actual audit of changed fields, not disposition-by-label.
- Claude Code sessions may be legitimate recurring snapshots; statements/accounts need content fingerprint/canonicalization proof, not handwaving.

Do next:

- Inspect `docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md` and `add-statement-content-fingerprint`.
- Use scripts/DB queries to show actual changed fields for retained versions.
- Run compaction only after proving the canonicalization invariant and preserving auditability.

## Relationships / Record Rendering / Read Surface UX

User complaints:

- Relationship navigation should be bidirectional where relationships exist.
- Manifest relationships must be accounted for in design, not patched ad hoc.
- Records should not be dumped as raw JSON forever; null content and money rendering bugs matter.
- Example money bug: amount `3000` in Chase/current activity means `$30.00`, not `$3000`.
- Example null-content URL involved Codex messages: `/dashboard/records/cin_ece4bfe5096b8bf67a1468c2/messages/...`

Likely current status:

- Some record rendering/relationship work happened in earlier worktrees, but current authoritative state must be verified from commits and OpenSpec.
- Do not assume relationships are complete. Test in UI and with direct REST/MCP queries.

## Connection Configuration / Self-Service Onboarding

User requirement:

- A fresh Railway/self-host instance must be able to fully configure connections in the UI.
- Linking remote collectors is only one connection path and cannot be the whole add-connection UX.
- The add-connection page previously had unclear wall-of-text UX and did not make fresh instances useful.

Current artifacts:

- `complete-self-service-connection-onboarding` 43/46 in-progress.
- `docs/research/sdk-and-ui-seams-prior-art-2026-06-11.md`
- `docs/research/user-facing-copy-audit-2026-06-11.md`
- Dirty worktrees:
  - `ri-self-service-final-validate-v1`
  - `ri-self-service-journey-final-review-v1`
  - `ri-self-service-cli-parity-v1`
  - `ri-self-service-docs-console-v1`
  - `ri-provider-auth-*`

Do next:

- Review self-service final validation worktrees before starting new work.
- Validate the full first-owner journey in a fresh instance: deploy, open dashboard, add connection, configure credentials/auth, run, see green data.
- Ensure docs and UI copy say what operators actually do today, not aspirational hosted-service copy.

## Railway / Fly.io / Coolify / Docker Self-Hosting

What happened earlier:

- Railway pushbutton work was a high-priority goal. GHCR packages had to be public; the owner made them public.
- Railway browser login and deploy flow were exercised earlier, but current production-ready status must be verified.
- The user ultimately wants “share links with friends, push button.”
- After Railway, the owner asked for Fly.io and Coolify.

Current active changes:

- `add-docker-core-deploy-target` 8/11 in-progress
- `publish-reference-browser-image` 7/8 in-progress
- `publish-mcp-server-package` 14/18 in-progress
- `adopt-single-release-channel` 16/21 in-progress
- `republish-remote-surface-as-opendatalabs` 38/46 in-progress

Do next:

- Verify public images, template links, default envs, and first-run behavior against a clean target.
- Do not require users to think about low-level env vars for the common path.
- Ensure self-service connection onboarding is included; otherwise pushbutton deploy still produces a useless instance.

## Google Maps / Location Data

User eventually wants a location data connector.

Current state points:

- `add-google-maps-timeline-import` 15/15 complete.
- `add-google-maps-data-portability-connector` 16/21 in-progress.
- Recent commit `acfc6378 Add Google Maps Data Portability API runtime`.
- Recent commit `dd3d626d Surface Google Data Portability OAuth config`.
- Untracked research includes `docs/research/brand-package-coverage-audit-2026-06-11.md` and `docs/research/sources-slvp-redesign-and-data-health-2026-06-11.md`.

Do not start arbitrary location connector work until the read surface, ChatGPT, churn, and self-service onboarding gates above are stable.

## OAuth / MCP Read Surface Compatibility

Test surfaces that should be covered:

- REST API read surface.
- MCP hosted `/mcp`.
- CLI read surface.
- ChatGPT-hosted MCP behavior after delete/re-add.
- Claude-hosted MCP behavior after reconnect.

Existing integration script:

- `scripts/read-surface-smoke.mjs` covers REST, MCP, and CLI using `PDPP_READ_SURFACE_TOKEN`.
- It requires a grant-scoped token. Owner token is intentionally not valid for `/mcp`.

Important prior ChatGPT/Claude host findings:

- ChatGPT stale app registration previously exposed old tools. Full delete/re-add was required; refresh/reconnect alone did not update tool schema.
- Typed filter object fixed ChatGPT’s bracket-filter incompatibility.
- Claude at one point saw `grant_invalid` for Slack while sibling grants worked; possible reconnect/grant repair issue.
- Host-side routing errors like “Resource not found /asdk_app...” may be ChatGPT/host state, not PDPP backend. Reproduce with clean app registration before changing server behavior.

## Research / Design Notes To Preserve

Do not lose these future-feature ideas:

- Passthrough mode: PDPP server can act as a gateway/index over data served by a source or external API without collecting/storing all data. Design challenge: what to do when the upstream cannot support full PDPP read/query/filter semantics.
- Bulk imports: GDPR/bulk exports can bootstrap a connection so scraping/API collection only handles increments. Design challenge: schema mismatches between export formats and scraped/API formats; should support general arbitrary imports, not just GDPR.

## Known Mistakes / Trust Boundaries

- Unapproved PR merges happened earlier in the session. the owner was explicit that this was a mistake and demanded recovery/review. If you touch old PR recovery branches, verify current state first and do not assume the mistake was fully corrected.
- PR #9 specifically required retroactive rigorous review to SLVP bar.
- Do not claim “I did not change main” as an excuse if the user asked you to undo/recover from a wrong merge. Be explicit about what changed, what remains, and how recovery is performed.
- Never use broad destructive commands like `git reset --hard` or `git checkout --` over dirty work without explicit approval.

## Recommended Resume Sequence

1. Run the snapshot commands in this file.
2. Update `tmp/workstreams/ri-owner-current-state.md` with the actual current state.
3. Reconcile dirty worktrees enough to know which are active, stale, merge-ready, or abandoned.
4. Finish `reduce-mcp-tool-surface-footprint`:
   - Confirm current default `tools/list` measurement.
   - Confirm event tools are tiered/discoverable in a protocol-compliant way.
   - Run package tests.
   - Retest ChatGPT if host-visible surface changed.
   - Mark final tasks or update tasks/design honestly.
5. Resume MCP agent/CIMD work from current artifacts, not old `add-mcp-cimd-client-identity` assumptions.
6. Close ChatGPT adaptive governor:
   - Verify code, schedule behavior, live run semantics, and owner-visible progress.
   - Do not tell the owner to rerun until the deployed code is the intended SLVP solution.
7. Validate self-service onboarding fresh-instance journey.
8. Return to version churn and statement fingerprint/canonical compaction.

## Commands Worth Keeping Handy

```bash
# Workstream owner checkpoint
pnpm workstreams:status -- --no-fail

# OpenSpec state
openspec list --json
openspec validate <change-name> --strict

# MCP package tests
pnpm --dir packages/mcp-server test

# Reference stack deploy, only from clean reviewed tree
pnpm docker:reference:up
pnpm docker:reference:quick

# Live reference revision
curl -sS -D - http://127.0.0.1:7662/ -o /tmp/pdpp-root.json | sed -n '1,40p'

# Anonymous MCP boundary, should reject ownerless access
curl -sS -D - http://127.0.0.1:7663/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Read surface smoke, requires grant-scoped token
PDPP_READ_SURFACE_TOKEN=... node scripts/read-surface-smoke.mjs \
  --origin https://pdpp.vivid.fish \
  --connection-id cin_... \
  --stream messages
```

## Final Warning For Next Agent

Do not optimize for looking busy. the owner’s bar is SLVP ideal with evidence. If a lane is not shippable, say what is missing. If a worker result is weak, reject it. If a cap or heuristic is merely acceptable but not ideal, do not call it ideal. If you need prior art, dispatch low research workers and require written findings on disk.
