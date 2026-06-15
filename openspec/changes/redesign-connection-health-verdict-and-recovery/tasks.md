## 1. Spec and design

- [x] 1.1 Confirm the proposal, design, and spec deltas read against the converged design `docs/research/slvp-connector-health-FINAL-design-2026-06-15.md` (honesty invariants kept verbatim, agency/silence layer folded in).
- [x] 1.2 Validate the change with `openspec validate redesign-connection-health-verdict-and-recovery --strict`.
- [x] 1.3 Validate the whole spec set with `openspec validate --all --strict`.

## 2. Stop the active lies today (additive on `connection-health.ts`, no synthesizer yet)

- [x] 2.1 In the per-stream chip composer, clamp `collected = min(collected, considered)` so an impossible "3/2 collected" can never render; add a focused test that a `collected > considered` input renders a clamped chip.
- [x] 2.2 Make the `case "healthy"` header render a disposition-aware statement (reuse the existing stale-freshness guidance) instead of a hardcoded "current and complete", so a stale-but-healthy connection does not claim completeness; test the stale-healthy case.
- [x] 2.3 Make `deriveSourceStatus` append a mandatory freshness annotation whenever the freshness axis is not `fresh`, and correct its doc comment; test that every non-`fresh` projection carries a `freshness` annotation.

## 3. The synthesizer (`synthesizeRenderedVerdict`) — the one verdict, honesty AND silence

- [x] 3.1 Add `reference-implementation/runtime/rendered-verdict.ts` exporting a pure `synthesizeRenderedVerdict(snapshot, streams, refresh, runtime_ok) -> RenderedVerdict`. No I/O, no clock read. Inputs are the existing `ConnectionHealthSnapshot`, the per-stream rollups, the refresh evidence, and `runtime_ok`.
- [x] 3.2 Implement `pill.tone` as a worst-wins rollup over base(state), freshness, worst-stream coverage, disposition, attention, and outbox tones; assign `pill.label` by the fixed `tone ↔ label` bijection. Never read `tone` straight from `state`.
- [x] 3.3 Implement the co-required `annotations[]`: when freshness is not `fresh`, emit a `freshness` annotation; on `calm`/`advisory` verdicts restrict annotation kinds to `freshness | schedule | activity` with no raw counts in text; cap a `calm` verdict at one annotation.
- [x] 3.4 Implement `channel` (`calm | advisory | attention`) computed AFTER `tone` in the same pass, default `calm`, raised to `advisory` by owner-actionable non-urgent conditions, owner-optional accelerants, or visible maintainer/status conditions, and raised to `attention` only by an owner-audience, owner-satisfiable required action where the owner is the sole resolution. Keep `tone` and `channel` orthogonal.
- [x] 3.5 Implement the inspection-layer `detail` object (state, reason_code, dominant_condition_id, raw forward_disposition, conditions, detail_gap_backlog, next_attempt_at, collection_rate) as a strict superset of any evidence the attention layer drops; route suppressed self-handled signals here, never to nothing.
- [x] 3.6 Implement `forward_statement` as a single sentence DERIVED from `forward_disposition` + the primary required action; assert it can never claim resumed collection while the disposition is terminal.
- [x] 3.7 Implement `progress` as collection-model-aware (`mode: scheduled | manual | deferred | local_device`), privileging gaps-drained + retained-records for `deferred`, records-committed for `scheduled`, retained-records + recency for `manual`; never surface a structurally-zero `records_emitted` as the "did it work?" signal.

## 4. The honesty + silence invariants (gate + composite test)

- [x] 4.1 Enforce the seven honesty invariants inside the synthesizer (throw in dev / safe grey verdict in prod): (1) freshness-mandatory-off-fresh, (2) `collected <= considered`, (3) `forward_statement` reconciles with disposition+actions, (4) `terminal === (forward_disposition === "terminal")`, (5) tone is worst-wins (never `labelFor(state)`), (6) label↔tone bijection, (7) no contradictory chip pair.
- [x] 4.2 Enforce the four silence invariants inside the synthesizer: S1 `channel === "attention"` ⇒ an owner-audience, `satisfied_when.kind !== "none"`, owner-self-satisfiable action exists; S2 no mechanistic counts on calm/advisory annotations; S3 `detail` is a strict superset of suppressed attention-layer evidence; S4 `runtime_ok === false` caps every channel at `calm`.
- [x] 4.3 Add a composite-invariant test that renders the WHOLE verdict (not N independently-tested formatters) and asserts all eleven invariants (1–7, S1–S4) on representative snapshots.
- [x] 4.4 Add a property test over `(state × freshness × coverage × disposition × attention)` asserting `tone` is worst-wins and never `labelFor(state)` directly, and that `(tone, channel)` are orthogonal (same tone can carry different channels).

## 5. Typed `RequiredAction[]` with derived terminality and one unified `satisfied_when`

- [x] 5.1 Define `RequiredAction` (kind taxonomy `reauth | refresh_now | reattach_schedule | add_info | retry_gap | backfill | wait | code_fix | contact_support`, `audience`, `urgency`, `affects[]`, `cta`, `terminal`) and the `SatisfactionContract` discriminated union; promote `next_action` to an ordered `required_actions[]` (zero-or-many).
- [x] 5.2 Derive `terminal` from `forward_disposition` only (`deriveForwardDisposition`, `connection-health.ts:2111`, stays the sole terminality oracle); add a test that no action's `terminal` disagrees with the disposition for its scope.
- [x] 5.3 Wire the ONE unified `satisfied_when` per kind (no per-kind bespoke logic); `wait | code_fix | contact_support` carry `{ kind: "none" }` and are not owner-satisfiable; test each contract variant.
- [x] 5.4 Make the `wait` kind (`audience: "none"`, `satisfied_when: { kind: "none" }`, `channel: calm` by construction) the single representation of deferred drain, source-pressure cooldown, and in-flight syncing; test that a `wait` action never raises `channel` above `calm`.
- [x] 5.5 Order `required_actions[]` by urgency, render the first as primary and the rest behind "+N more", and index `streams[].action_ref` into the list; test a two-action connection (e.g. `refresh_now` + `reauth`) renders both correctly.

## 6. Refresh-contract creation/lifecycle invariant (Risk 1 — verify the runtime input, not just the manifest)

- [ ] 6.1 Resolve the refresh contract generically from manifest `recommended_mode` + `background_safe` (NOT a per-connector branch, NOT credential presence); `automatic` ⇒ schedule attached at activation, `manual` ⇒ schedule-absence is not a defect but the connection is typed manual.
- [x] 6.2 Route a stale manual-refresh `account` connection to `owner_refresh_due` / `stale_manual_refresh`, never green; test that a stale manual account connection cannot render a green headline.
- [x] 6.3 (Risk 1, highest-leverage) Verify that `ConnectionRefreshEvidence` actually reaches the projection at RUNTIME for amazon / chase / reddit / usaa — trace the input end-to-end, not just from the manifest — so `isManualRefreshOnly` is true for them and Amazon does not fall through to `complete` and stay green.
- [x] 6.4 Assert the non-credential invariant against live shape: ChatGPT is `source_kind=account` + scheduled + zero credentials, so an `account ⇒ credential` invariant SHALL NOT be imposed; add a test/fixture proving a zero-credential active account connection is valid.

## 7. Self-heal / auto-resume loop

- [ ] 7.1 Add a `satisfied_when` watcher in the connection controller that evaluates each owner-actionable action's contract against the durable evidence the projection already reads.
- [ ] 7.2 On a satisfied flip: re-attach the schedule (when `satisfied_when` is `schedule_attached_and_enabled`), fire exactly ONE confirming run, drain recoverable gaps, re-synthesize, and flip green — with no "now run it" step — landing on the EXISTING `connection_id` (schedule + tokens preserved). Bound the loop with the existing backoff/cooldown so it cannot storm confirming runs.
- [ ] 7.3 Test: satisfying a `refresh_now`/`reauth` action auto-resumes onto the existing connection and flips the pill green without a separate "now run it" step.
- [ ] 7.4 Test: an identical re-failure re-presents the SAME action with the failure reason and does NOT paint a false green.
- [ ] 7.5 Test: partial recovery clears recovered streams' actions while keeping the unrecovered terminal/owner-blocked stream's own action.

## 8. Render-consumer migration (surfaces stop reading `state` directly)

- [x] 8.1 Forward the synthesized `RenderedVerdict` verbatim through `ref-control.ts` -> `ref-client.ts` exactly as `connection_health` is forwarded today.
- [ ] 8.2 Migrate the dashboard list, connection header, connection detail, and owner-agent passport to render only `RenderedVerdict` fields; remove every raw `health.state`-derived pill/badge/headline/owner-action.
- [ ] 8.3 Split the dashboard (attention layer) from the detail panel (inspection layer): mechanistic counts (gap counts, retry counts, backlog scale, `next_attempt_at`, `collection_rate`) render only in `detail`; the dashboard renders "Healthy · fresh today", never the gap count.
- [ ] 8.4 Lift the three existing ad-hoc silence decisions (`isHealthRelevant`, `pushPayload(owner_action:"none") -> null`, `stale_assisted_refresh` info-severity) into the one `channel` computation; the push transport emits only when `channel === "attention"` with an owner-satisfiable action; `calm`/`advisory` never push.
- [ ] 8.5 Add a grep/lint gate over `apps/console/**` forbidding raw `health.state` reads AND raw silence decisions (any surface re-deriving "is this actionable / should I badge / should I push" from raw axes). One owner of the alarm decision: the synthesizer's `channel`.

## 9. Runtime-vs-connection cascade guard

- [ ] 9.1 Add the `runtime_ok` input to the synthesizer and a single global runtime indicator above the connection list; when `runtime_ok` is false, cap every per-connection `channel` at `calm` while keeping each `pill.tone` honest.
- [ ] 9.2 Test: a dead runtime emits ONE global indicator and zero per-connection `attention` channels (no N-way cascade), and per-connection pills still reflect their own honest state.

## 10. Grant-scope isolation

- [ ] 10.1 Confirm the inspection-layer `detail` and the detail-gap backlog rollup remain owner-only and are NOT exposed to grant-scoped REST/MCP reads; add a regression proving a grant-scoped read returns records but no `RenderedVerdict.detail`.

## 11. Live journeys + validation

- [ ] 11.1 Fixture/test the three live journeys: ChatGPT `green / calm / "fresh today"` with NO `2532` anywhere on the dashboard and `2532` present in `detail.detail_gap_backlog`; Amazon `amber / advisory / "31 days stale" + Refresh now`; Chase `amber / advisory / "transactions stuck since Apr 22" + Retry now` whose per-stream row truthfully says the next run retries.
- [ ] 11.2 Cover the terminal / `code_fix` channel-as-status path with a synthetic fixture (no live terminal gap exists): a `code_fix`/`audience: maintainer` action renders as a status ("we're updating the connector — nothing for you to do"), never a dead owner button, and never raises `channel` to `attention`.
- [ ] 11.3 Run the focused connection-health and rendered-verdict tests plus the composite-invariant and property tests; run `tsc` and the console lint/ultracite gate clean.
- [ ] 11.4 Re-run `openspec validate redesign-connection-health-verdict-and-recovery --strict` and `openspec validate --all --strict` after implementation.

## 12. Calibration to the SLVP ideal

- [ ] 12.1 Add a non-owner-surface calibration trace for `synthesizeRenderedVerdict` test/operator review: tone cause, channel cause, suppressed evidence, detail destination, primary required action, and `satisfied_when` contract. Confirm it is not exposed to grant-scoped REST/MCP clients.
- [x] 12.2 Pin golden calibration fixtures before UI migration: ChatGPT, Amazon, Chase, synthetic terminal `code_fix`, and synthetic runtime fault. Each fixture asserts both the verdict and the calibration trace.
- [ ] 12.3 Run a shadow comparison over the live connection set before replacing owner surfaces. Classify every old-vs-new headline change as `fixed_lie`, `deliberate_silence_correction`, or `unexpected_drift`; block rollout on any `unexpected_drift`.
- [ ] 12.4 Add DOM-level assertions for owner surfaces: no mechanistic backlog counts on the dashboard, exactly one primary action, no dead owner button for maintainer work, suppressed evidence present in `detail`, and push transport obeying `channel`.
- [ ] 12.5 Record the calibrated thresholds and copy choices that are intentionally judgment-based — advisory-vs-attention threshold, stale/manual-refresh language, stream-priority weighting, runtime liveness sensitivity, and push eligibility — with the fixture or live evidence that justified each choice.

## 13. Owner-only residual

- [ ] 13.1 Owner-only live verification + Codex RI owner review: confirm against live `pdpp.vivid.fish` that the dashboard renders the three journeys correctly (no `2532` on the dashboard, Amazon/Chase advisories, ChatGPT calm), that the self-heal loop lands on the existing connection, and that Risk 1's refresh-evidence wiring holds end-to-end; record any residual as a named risk rather than leaving the change pseudo-active.
