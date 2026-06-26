# Open Lane Triage — 2026-06-22

Triage method: read-only. Evidence drawn from the local deploy worktree git log (deployed
tree HEAD = 41a671ef), the repository checkout's main branch log (HEAD = aac1b8d0), memory topic
files, and code grep. Live site confirmed up (307 redirect = expected auth bounce). No code edited.

---

## ALREADY-LIVE

### 1. Stuck-run wedge + YNAB quote-corruption
Watchdog + reconciliation + run-generation fencing deployed as commit `28eb3f33`. YNAB token
de-quoted and re-sealed. Both proven end-to-end (YNAB collected June 10→15).
Evidence: `28eb3f33` present in deployed tree.

### 2. Connector self-service setup / edit / repair + reactivate
Manifest-driven static-secret form, `replaceStaticSecretCredentialAction`, and reactivate-revoked
route all deployed as `9a39a22a`. YNAB/Slack/Oura/Notion wired; browser-bound and local-device
setup also shipped (9ffc891f).
Evidence: `9a39a22a` present in deployed tree.

### 3. Phantom connections cleanup
Read-path materialization bug fixed in `b754d936`; 10 phantom/test rows manually cleaned from live
DB (27→17 sources); the Reddit source reactivated.
Evidence: `b754d936` present in deployed tree.

### 4. Mobile master-detail push-nav
CSS dual-link push navigation on mobile deployed as `53f12bd3`. All five affected surfaces fixed
(Grants, Runs, Traces, Sources, Explore; new event-subscriptions/[subscriptionId] detail page built).
Evidence: `53f12bd3` present in deployed tree.

### 5. ChatGPT cooldown-starves-recovery (BUG 2)
`probeNonPressureRecoverableCount` now runs at scheduler eligibility; when source-pressure cooldown
defers but non-pressure recoverable gaps exist, `eligible = true; recoveryOnly = true` fires anyway.
The 942 non-pressure gaps are no longer held hostage by 51 source-pressure gaps.
Evidence: `scheduler.ts:2273` confirms `nonPressureRecoverable` probe in main and deployed tree.
Note: BUG 1 (UI mislabel: `deriveFailureSummary` missing `isSourcePressureCooldown` guard) needs
separate verification — mark UNVERIFIED below.

### 6. Recovery journey console fixes
Dashboard alarm now derived from a single attention truth; CTA routes to recovery panel or /runs
(never /traces). Deployed as `2fd15fa7`.
Evidence: `2fd15fa7` present in both main and deployed tree.

### 7. Local-collector bounded memory — imessage / twitter / slack conversions
The three owed connector conversions are in main:
- `482ae82c fix(polyfill-connectors): stream imessage rows`
- `cae8e92b fix(polyfill-connectors): stream twitter archive reads`
- The guard generalisation (manifest-driven class discovery) was also merged (`253fbeb5`, `c2d95999`).
Slack `.all()` path also hardened per the `a1e5791b` drain-recovery commit.
Evidence: all commits present in the repository checkout's git log.

### 8. Explore SLVP redesign (Slices 1–5 + semantic time + manifest authoring)
All five redesign slices, semantic-time sort, and the full 18-connector `x_pdpp_role` authoring pass
are deployed (latest: `41a671ef` = deployed HEAD).
Evidence: deployed tree HEAD confirms.

---

## REAL-OPEN

### 9. Lexical search recency — authored-time ranking
**Status: design only, not implemented in ranking.**
`authoredTimestampFromRecordJson` is computed per search result row (search.js:1403, 1496, 1513)
but the Postgres ranking query still orders `ORDER BY score DESC, lsi.record_key ASC` — no
authored-time recency blend. The true cause (emitted_at clusters at backfill moments, not authored
time) was proven live but the fix (blend sent_at / authored_at into rank) was never committed.
Next concrete step: wire authored-time recency weighting into `postgres-search.js` ORDER BY
(e.g. `score * log(1 + 1/epoch_age_authored)` blended rank), behind a flag to validate quality.

### 10. Connector-health / assisted-schedule honesty gate
**Status: uncommitted worktree lane, NOT in main or deployed.**
Commit `c066165d` on branch `workstream/ri-assisted-schedule-health-gate-v2` implements honest
`stale_assisted_refresh` advisory for ChatGPT (instead of false `degraded`). Verdict from memory:
MERGE. Not present in main or deployed tree.
Next concrete step: merge `workstream/ri-assisted-schedule-health-gate-v2` into main (gates: tsc 0,
conn-health 94/94, console 100+51/51, biome clean — all confirmed green in the lane).

### 11. Sources IA / per-source add-account (task 9.6)
**Status: uncommitted worktree lane, NOT in main or deployed.**
Commit `c11172ff` on branch `workstream/ri-sources-ia-add-account-v1` separates existing-data /
add-new / repair in the Sources first screen. 112 tests green. Pending: task 9.5 (setup-attempt
lifecycle) is a follow-on, not a blocker.
Next concrete step: merge `workstream/ri-sources-ia-add-account-v1` into main; owner live-verify.

### 12. OJ2 browser account-identity audit
**Status: active lane, partial fixes in flight, root causes not yet resolved.**
The grounded root-cause audit (2026-06-19) identified three structural defects: (1) no
account-identity confirmation on browser path (static-secret has "Connected as X", browser doesn't);
(2) duplicate-name detection only fires for unnamed sources; (3) "Reconnect"-labeled CTAs actually
route to add-new. Recent commits (`828f216a bind browser setup identity intent`, `860b6d49 record
browser identity blocker`) show the intent is being addressed but the full fix spine (echo account
identity before activation, reuse-same-connection-if-same-account logic, card-level disambiguation)
is not yet committed.
Next concrete step: implement the account-identity probe + confirmation gate on the browser activation
path (model: static-secret `probeCredential → identity: {account_identity}` pattern).

### 13. ChatGPT batch endpoint implementation
**Status: plan only (docs/research/chatgpt-connector-batch-endpoint-plan-2026-06-19.md), no code.**
`grep -c "conversations/batch"` returns 0 in connector source. The batch endpoint switch
(POST /conversations/batch, 10 ids/request, unthrottled) is fully documented and scoped (surgical
endpoint swap only, no rate machinery) but not implemented.
Next concrete step: implement the batch endpoint in
`packages/polyfill-connectors/connectors/chatgpt/index.ts` per the plan — replace per-conversation
GET with batch POST, add GET fallback for misses.

### 14. LFDT submission prep
**Status: active, gates not cleared.**
Repo has `LICENSE-docs` and `LICENSE-specs` but no root Apache-2.0 LICENSE file (the LFDT hard gate).
DCO sign-off and spec section scope statements are also owed. The "2 of 3 blocking issues are phantom"
diagnosis simplifies the real work but it's not done.
Next concrete step: add root Apache-2.0 LICENSE to repo; add per-section scope statements to spec.

### 15. Codex/claude_code local collector unbounded growth (retention/prune design)
**Status: design deferred, no prune mechanism found.**
Bounded *reads* are shipped (lane 7 above). But the retention/pruning problem — these collectors
grow ~3 GB/week and are uploaded to peregrine-dev.vivid.fish with no pruning — has no design or
implementation in the codebase. Memory entry says "logged, resolve later."
Next concrete step: design a retention window for codex/claude_code collector output (e.g. keep
last N sessions or last K days) and wire it into the local-collector auto-prune machinery.

### 16. Explore SLVP consolidated sweep
**Status: active in-flight lane.**
Branch `workstream/explore-slvp-sweep` exists. Codex has confirmed a plancheck and sequencing
(P0b manifest under-declaration → P0 amount-magnitude heuristic deletion → P1 content + search-hit
scannability → P2 polish). The manifest authoring pass (41a671ef) is already deployed; the sweep
addresses remaining guessing in the read path. Not yet committed.
Next concrete step: Codex implements the P0b/P0/P1 sweep fixes, then PR to main via the integration
branch coordination plan (origin/explore-slvp-backup-20260622 → integration branch → PR).

### 17. MCP content-ladder (new active Codex lane, 2026-06-22)
**Status: active Codex lane, P0 substrate committed on worktree branch, not yet in main.**
Codex has `f6a17cf9 feat(rs): grant-enforced bounded field-window substrate` on branch
`waspflow/mcp-ladder-impl-20260622`; next worktree `pdpp-mcp-ladder-tooling-20260622` is in
progress. This is a new lane not in the original list but is real-open today.
Next concrete step: Codex completes route/MCP tooling slice, then PR to main.

---

## UNVERIFIED

### 18. ChatGPT cooldown-starves-recovery — BUG 1 (UI mislabel)
The scheduler fix (BUG 2) is confirmed shipped. BUG 1 — `deriveFailureSummary` in the console
missing an `isSourcePressureCooldown` guard, causing a false "blocked / reconnect" CTA — was
identified in the same memory entry. No grep was run against the console source to confirm whether
this surgical fix was applied. Could be ALREADY-LIVE (it's a one-liner) or REAL-OPEN.
Next concrete step: `grep -n "isSourcePressureCooldown" apps/console/.../deriveFailureSummary`.

### 19. Recovery-journey shippability — beyond the console fix
The dashboard CTA fix (lane 6) shipped but the full-surface shippability audit
(`docs/research/shippability-audit-2026-06-16.md`) rated overall shippability at ~10-15% with open
P0/P1 items (connect-page crash, /docs 404, 18 add-source dead-ends, vocabulary collisions).
Whether those P0/P1 items have since been resolved is not determinable from git log alone without
mapping each to a commit.

### 20. Provider rate governance convergence (AdaptiveLane → shared primitive)
**Status: design captured, OPENSPEC archived (2026-06-11-converge-provider-rate-governance). No
implementation.** The preflight audit (project_ri_provider_pacing_chatgpt_wire_preflight_v1)
concluded: DEFER wiring; ChatGPT rate safety already exists via AdaptiveLane + existing 429
handling; convergence = owner architectural decision, not an agent task. This is either permanently
deferred (OBSOLETE as a near-term lane) or awaiting an owner decision to act.

---

## OBSOLETE

None identified with certainty. Several lanes in the memory index are for features already
delivered and have no open tail (connector self-service, mobile nav, phantom cleanup, stuck-run
wedge, explore slices 1-5 semantic time). They are covered under ALREADY-LIVE above.

---

## SHORTLIST — Top REAL-OPEN by user-visible impact

**1. OJ2 browser account-identity (lane 12)**
Users can silently create duplicate Amazon/ChatGPT sources with no feedback on which account they
logged into. Directly blocks trust in browser-session setup, which is the path for the highest-value
connectors (Amazon, ChatGPT, Chase, USAA). Every new browser setup is unreliable until this ships.

**2. Explore SLVP consolidated sweep (lane 16)**
The deployed Explore still contains amount-magnitude guessing and under-declared manifest roles
(P0b audit finding). This is the main user-facing read surface and the sweep is already planned
and sequenced by Codex. High-visibility, in-flight.

**3. Lexical search recency — authored-time ranking (lane 9)**
"Recent messages missing from search" is a persistent, systemic user-visible bug affecting Slack,
ChatGPT, WhatsApp, and every connector whose ingest time differs from message time. The root cause
is proven, the data is correct, only the ranking query needs changing. Fix is a small SQL change
with high confidence.

**4. Assisted-schedule honesty gate (lane 10)**
ChatGPT shows as `degraded` when it's merely awaiting a scheduled refresh. Operator sees a false
alarm; the fix is in a green, ready-to-merge branch. Low effort, meaningful honesty improvement.

**5. ChatGPT batch endpoint (lane 13)**
Eliminates the per-conversation GET storm (~10x fewer requests, unthrottled batch endpoint). Plan
is fully written; the implementation is a surgical swap. Directly improves ChatGPT collection
reliability and reduces 429 pressure.

---

*Triage date: 2026-06-22. Deployed tree HEAD: 41a671ef. Main HEAD: aac1b8d0.*
*Deployed tree is 2 CI commits behind main (darshana review package, both CI-only). All product
lanes current as of the deployed HEAD.*
