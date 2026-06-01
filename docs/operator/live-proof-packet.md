# Live-Proof Packet: remaining human/live gates

Status: reference/operator runbook. Not PDPP Core or Collection Profile protocol.

This is the single owner-consumable checklist for every OpenSpec box that still
needs a **human, a live provider session, a physical phone, a production-backup
restore, or a real deployment** to close. It exists so the owner can execute the
runs over hours/days without rediscovering context, and so no box gets checked
on faith.

It distills and corrects the earlier read-only map at
`tmp/workstreams/ri-live-gated-proof-map-v1-report.md`. Where a deeper runbook
already exists it links rather than duplicates. The non-negotiable rule across
every gate: **do not check the OpenSpec box unless you actually ran the proof and
captured the named evidence.** A box is `[ ]` until the artifact exists.

Verified against the tree at the head commit of branch
`workstream/ri-live-proof-runbook-hardening-v1` (base `main`).

---

## Correction since the prior map: the host-browser bridge is dead

The prior map's highest-value bundle ("Bundle A: ChatGPT host-browser bridge")
is **stale**. The `design-host-browser-bridge-for-docker` change is still active
with open boxes 1.2 and 5, but its implementation was deleted by the archived
`2026-05-29-introduce-local-collector-runner` (task 2.2). The proof command both
documents print:

```
pnpm --dir packages/polyfill-connectors exec tsx bin/host-browser-bridge.ts --profile chatgpt
```

That command points at a **deleted file** and will fail. There is no Docker-to-host CDP bridge
to prove. Browser-backed connectors (ChatGPT, Amazon) now run on a **local
persistent-context Chrome** on whatever host runs the local collector runner or
local `pnpm dev`, gated by `runtime_capabilities`.

**Owner action for the host-bridge change: archive it as superseded, do not run
a proof.** Its 1.2/5 boxes cannot be honestly closed. A status note has been
added to `openspec/changes/design-host-browser-bridge-for-docker/proposal.md`.
The ChatGPT live-pilot value survives entirely in Gate 4 below
(`add-connector-adaptive-lanes` task 5), which uses the local browser path.

---

## Gate index

| # | Gate | OpenSpec box(es) | Human cost | Risk |
|---|------|------------------|-----------|------|
| 1 | Amazon browser-collector proof + intent flip | `add-browser-collector-enrollment-primitive` task 3 (proof), task 3 (flip); `add-owner-agent-control-surface` tasks 5.3/8.5 | 1 session (Amazon login) | low (read-only browse) |
| 2 | ChatGPT hosted-MCP live flow | `canonicalize-connector-keys` task 5.2 | 1 session (ChatGPT MCP client) | low |
| 3 | ~~Host browser bridge Docker proof~~ | `design-host-browser-bridge-for-docker` tasks 1.2/5 | **none - archive instead** | n/a |
| 4 | Adaptive-lane ChatGPT live pilot + telemetry | `add-connector-adaptive-lanes` task 5 (pilot), task 5 (compare), task 6 (maxConcurrency), task 6 (next candidate) | 1 session (ChatGPT login) | low |
| 5 | Chase current-activity native-ID investigation | `add-chase-current-activity-stream` task 1.2 | opportunistic rider | low |
| 6 | n.eko real-phone stream matrix | `add-run-interaction-streaming-companion` tasks 12.8, 13.5, 14.7, 15.8, 17.5 | 1 session (Android + iOS) | low |
| 7 | Production-backup canonical-key migration close-out | `canonicalize-connector-keys` task 3.4 | 1 operator session | **high (data-loss-capable)** |

Suggested execution order: **2 -> 1 -> 4 -> 6 -> 5 (rider) -> 7 (last, deliberate)**.
Gate 3 is desk-only (archive). Gates 1 and 4 can share one session if a host has
both an Amazon and a ChatGPT login. Gate 7 is last because it is the only
destructive-capable act.

---

## Secret-handling (applies to every gate)

Never print, commit, or paste: owner session cookies / bearers, enrollment
codes, device tokens, provider credentials/cookies, scoped stream tokens, MCP
integration secrets, owner passwords, production connection strings, or raw
captured DOM/records before scrubbing.

- Supply `PDPP_OWNER_SESSION_COOKIE` / owner bearer / `PDPP_*_PASSWORD` to
  commands **without** echoing the value (use `export` or a here-doc that reads
  `process.env`, never `echo`).
- Any `PDPP_CAPTURE_FIXTURES=1` capture must pass through the
  `scrub-connector-fixtures` skill before it leaves the host. Raw runs live under
  `packages/polyfill-connectors/fixtures/<connector>/raw/`; only
  `<connector>/scrubbed/<runId>/` is committable.
- Report **invariants** (row counts preserved, accepted_record_count > 0,
  `connection_active: false`, no URL-shaped ids), not the underlying personal
  data.

---

## Gate 1: Amazon browser-collector proof + intent flip

**Closes:** `add-browser-collector-enrollment-primitive` task 3 (Amazon end-to-end
proof test + scrubbed fixture) and, as one reviewable post-proof code unit, task 3
(flip `browser_bound` to `enroll_browser_collector`) plus
`add-owner-agent-control-surface` tasks 5.3 / 8.5 Amazon acceptance.

**This gate already has a full step-by-step runbook; do not duplicate it.**
Execute `docs/operator/browser-collector-proof-runbook.md` verbatim. That runbook
is verified runnable: `bin/local-device-exporter.ts` exists with `enroll`/`run`
subcommands, the `amazon` profile is registered in
`packages/polyfill-connectors/src/local-device-runtime.ts`, and the deterministic
half (`reference-implementation/test/browser-collector-ingest-proof.test.js` +
the committed records fixture) is green in CI.

Acceptance (from that runbook, restated as the box-check bar):
- A scrubbed fixture committed under
  `packages/polyfill-connectors/fixtures/amazon/scrubbed/<runId>/` from a real,
  owner-logged-in Amazon run.
- A no-secrets evidence note: `runId`, connector_instance_id, accepted record
  counts per stream, spine ingest event ids.
- `accepted_record_count > 0`, recent `last_ingest_at`, `outbox_state: drained`
  on the `browser_collector` source instance.

**Box discipline:** the proof box and the flip box are **separate**. If you land
the scrubbed fixture + evidence but not the intent flip, record "live-proven,
flip pending" and leave both boxes open. Only check both when the flip
(`reference-implementation/server/routes/owner-connection-intent.ts` returning
`enroll_browser_collector` with `connection_active: false`) and its tests land in
the same reviewable unit as the evidence; the spec requires the proof and the
flip to be reviewable together.

**Fail signatures:** instance marked active before enrollment completes; intent
returning a next step that completes provider auth without owner mediation;
`ambiguous_connection` not raised when two Amazon instances exist.

**Abort/cleanup:** if the Amazon session can't be established, stop before any
capture; there is nothing to scrub. Revoke the enrolled device
(`/dashboard/device-exporters`) if you abandon the run; the device token is
write-capable on its ingest lane.

---

## Gate 2: ChatGPT hosted-MCP live flow

**Closes:** `canonicalize-connector-keys` task 5.2. The Claude side is already
live-proven (2026-05-31); this is the ChatGPT-side parity run. The task text is
explicit: **do not mark task 5.2 complete until ChatGPT is also live-proven** or the
task is explicitly narrowed.

**Preconditions:**
- A reachable hosted MCP integration endpoint (the running reference deployment's
  `/mcp`) and a ChatGPT client able to connect to it (ChatGPT's
  developer-mode / connector integration).
- At least **two** connections configured so the multi-connection
  `ambiguous_connection` to `connection_id` retry path is exercised. Confirm with an
  owner read first:

```bash
# Set BASE_URL and PDPP_OWNER_SESSION_COOKIE (do not echo the cookie).
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
if (!baseUrl || !cookie) throw new Error('Set BASE_URL and PDPP_OWNER_SESSION_COOKIE.');
const r = await fetch(`${baseUrl}/v1/streams`, { headers: { Cookie: cookie, Accept: 'application/json' } });
const body = await r.json();
console.log('stream_count:', Array.isArray(body.data) ? body.data.length : 'n/a');
NODE
```

**Exact flow (in the ChatGPT client):** connect ChatGPT to the hosted MCP
integration -> list tools -> inspect a stream/schema -> query records -> trigger
`ambiguous_connection` and retry by `connection_id` -> create / list / get /
send-test / delete an event subscription.

**Acceptance (the box-check bar):** the full lifecycle completes and **no
URL-shaped connector ids** (`https://<host>/connectors/<key>`) appear in any owner-facing
tool guidance; only canonical `connector_key` / `connection_id`. Capture the
proof as a short no-secrets note (tools listed, the disambiguation retry, the
subscription lifecycle) in the change's design note or this gate's evidence line.

**Fail signatures:** URL-shaped ids surfaced in tool guidance; ambiguity retry
fails to disambiguate by `connection_id`; subscription create/delete errors.

**Secrets:** never print the MCP bearer/integration secret or record contents.

**Abort/cleanup:** delete any event subscription you created during the smoke so
the deployment is left clean.

---

## Gate 3: Host browser bridge (ARCHIVE, do not prove)

See the correction at the top of this document. `design-host-browser-bridge-for-docker`
tasks 1.2 and 5 reference deleted code. **Do not attempt the proof.** The owner-grade
action is to archive the change as superseded by
`2026-05-29-introduce-local-collector-runner` per the Archiving section in `AGENTS.md`
(convert the two open boxes into a Residual Risks / superseded note). The proof
value migrated to Gate 4.

---

## Gate 4: Adaptive-lane ChatGPT live pilot + telemetry comparison

**Closes:** `add-connector-adaptive-lanes` task 5 (run one ChatGPT live pilot with
fixture capture), task 5 (compare live telemetry to the serialized baseline). Two
further boxes are **desk decisions gated on this run's telemetry**, not separate
sessions: task 6 (whether ChatGPT may raise `maxConcurrency` above `1`) and task 6 (next
connector candidate).

The adaptive lane is wired into the ChatGPT conversation-detail loop
(`createAdaptiveLane` in
`packages/polyfill-connectors/connectors/chatgpt/index.ts`), so it exercises on
any ChatGPT run. **This does not need the dead host bridge**; run ChatGPT
through the local collector/connector path with a real local browser.

**Preconditions:**
- A host with a real Chrome and a logged-in (or interactively log-in-able)
  ChatGPT profile.
- `PDPP_CAPTURE_FIXTURES=1` for the run so lane telemetry + fixtures land.
- The connector configured at its first-pilot pressure: `initialConcurrency = 1`,
  `maxConcurrency = 1` (already the committed default per task 4.2).

**Run:** trigger a ChatGPT run from the dashboard / collector runner on the host
with the real browser, with `PDPP_CAPTURE_FIXTURES=1` set, and complete any
login/OTP/Cloudflare in the visible window. Then read the run timeline:

```bash
pnpm exec pdpp run timeline <run-id> --format json   # supply owner auth, do not print the cookie
```

**Acceptance (the box-check bar): the lane telemetry must show:**
- no retry exhaustion;
- no burst above the configured lane cap (1 concurrent detail fetch);
- clear cooldown / progress messages;
- successful cursor commit on terminal success (and **no** cursor advance on a
  failed required-detail collection).
- A scrubbed fixture committed under
  `packages/polyfill-connectors/fixtures/chatgpt/scrubbed/<runId>/`.

**Then (desk, same evidence):** record the task 6 `maxConcurrency` decision. If the
single-lane pilot showed clean sustained success with headroom, the owner may
decide to allow > 1 in a follow-up; otherwise hold at 1 and say why. Note the
next candidate connector only once its throttle bucket and required/optional
stream semantics are explicit.

**Fail signatures:** retry storm above cap, cursor advanced on a failed required
detail, lane telemetry leaking secret-bearing URLs/headers/cookies (the redaction
is already unit-tested in task 5.x; confirm it held live).

**Secrets:** scrub the captured ChatGPT fixture before commit; never print
session cookies.

**Abort/cleanup:** a failed pilot is still useful evidence; record the telemetry
and leave the boxes open. Do not raise `maxConcurrency` on a failed or absent
pilot.

---

## Gate 5: Chase current-activity native-ID investigation (opportunistic rider)

**Closes:** `add-chase-current-activity-stream` task 1.2. This is an
**investigation, not a smoke**; it has no pass/fail proof artifact and does not
block the (complete) fixture-backed implementation. **Do not schedule a dedicated
bank-login session for it.** Fold it into any future live Chase run the owner
already does for another reason.

**While logged into Chase current activity**, inspect the DOM attributes and
network payloads of the current-activity surface for **stable native transaction
IDs**, and check whether the connector's documented fallback key survives a
pending-to-posted transition.

**Outcome to record (in `add-chase-current-activity-stream/design.md`):**
- If stable native IDs exist: open a follow-up to update the connector key
  strategy to prefer them; note the attribute/payload path. Leave task 1.2 open until
  that follow-up lands.
- If not: record "no stable native IDs; documented fallback key retained" and
  check task 1.2.

**Secrets:** never print account numbers, balances, or transaction detail. Record
only the schema-level finding (IDs present/absent, fallback survives/not).

---

## Gate 6: n.eko real-phone stream matrix

**Closes (all five, from one real-phone session against the public stream
surface):** `add-run-interaction-streaming-companion` tasks 12.8, 13.5, 14.7, 15.8,
17.5. Desktop and Playwright mobile-emulated smokes already pass for all five;
**only the physical real phone remains.**

**Preconditions:**
- The n.eko Docker overlay rebuilt/recreated and healthy.
- A public stream surface reachable (`peregrine-dev.vivid.fish` or equivalent).
- A real phone, ideally **both Android Chrome and iOS Safari** (the matrix names
  both).
- Stream debug telemetry enabled so each smoke produces inspectable evidence.

**Rebuild the overlay (always uses the neko-dynamic profile):**

```bash
bash scripts/reference-stack.sh up --build-app     # or --build-all
```

**Automated owner-surface smoke first (skips cleanly without a public URL):**

```bash
PDPP_STREAM_SMOKE_URL=https://peregrine-dev.vivid.fish \
PDPP_STREAM_SMOKE_OWNER_PASSWORD=<redacted>  \
  pnpm docker:stream-smoke           # node scripts/manual-action-stream-smoke.mjs
```

**Then drive the SAME public surface from a physical phone:**
`https://<public-host>/dashboard/stream-playground?backend=neko`

Exercise per the matrix: chrome-free display (no n.eko room UI, no extension /
address chrome); pointer/touch alignment; local-to-remote paste via the Clipboard
Sheet; mobile keyboard open / dismiss / reopen with optimistic reacquire;
rotation settle without stretch; reconnect / app-switch; visual sharpness.

**Acceptance (per smoke, with debug-telemetry capture):**
- chrome-free display; pointer/touch alignment within tolerance; rotation settles
  without stretch;
- mobile keyboard opens/dismisses/reopens and reacquire confirms editable focus
  (rollback if the remote page never confirms);
- clipboard host-to-remote paste and remote-to-host buffer both work;
- pixel-fit 1:1 flags and acceptable gutter ratio in the visual-quality
  telemetry.

**Box discipline: DO NOT mark complete on partial-platform coverage.** The
matrix names Android Chrome *and* iOS Safari. If only one phone is available, log
exactly which platform was covered and leave the five boxes open with a narrowed
note. Save the debug-telemetry capture (`pnpm stream-debug:summary` over the
captured trace) as the evidence artifact.

**Fail signatures:** stretched stream on orientation change; keyboard reacquire
rollback; stream not settling (media-settle requested-vs-actual mismatch); scoped
stream token exposed without scope.

**Secrets:** never print `PDPP_STREAM_SMOKE_OWNER_PASSWORD`, the owner session
cookie, the scoped stream token, or any clipboard contents captured during the
paste test.

**Abort/cleanup:** `bash scripts/reference-stack.sh down` (or the project's stop
command) to tear the overlay back down when finished.

---

## Gate 7: Production-backup canonical-key migration close-out (LAST, deliberate)

**Closes:** `canonicalize-connector-keys` task 3.4, the owner sign-off remainder.
The synthetic-data harness already passes **38/38 + idempotency** against the real
reference schema (`run-backup-restore-validation.sh`). What remains is the
**real-data, real-HTTP-path** close-out: run `cli.mjs write --apply` against a
restore of the operator's own production backup and spot-check the running app.

**This is the only destructive-capable act in the packet. Run it against a
DISPOSABLE restore, never the live production DB.**

**Preconditions:**
- A **copy/restore** of the production Postgres backup into a disposable
  database. Never point at live production.
- The reference app pointed at the restored DB so the HTTP read path can be
  spot-checked.

**Commands (against the disposable restore only):**

```bash
node reference-implementation/scripts/canonical-connector-keys/cli.mjs inspect
node reference-implementation/scripts/canonical-connector-keys/cli.mjs write --apply
#   fail-closed on unmapped active values; do NOT pass --allow-unmapped to bypass.
```

Then point the app at the restored+migrated DB and spot-check the HTTP path
(this is the task 7.3 surface smoke against migrated production-shaped data):
`/dashboard`, `/dashboard/explore`, `/dashboard/event-subscriptions`,
grant-package membership, record reads, owner dashboard hydration.

**Acceptance (the box-check bar):**
- Row counts preserved on all touched tables (assert preservation, not a fixed
  count; production differs from the harness's 14).
- Zero URL-shaped / legacy / wrapped-local-device connector ids remain in active
  tiers; backup-tier untouched unless `--include-backup-tables`.
- Owner dashboard hydrates, grant packages resolve, records read in the running
  app against migrated production-shaped data.
- Idempotent: a second `write --apply` rewrites nothing.

**Fail signatures:** `connection_not_found` on owner/grant-scoped reads
post-migration (the canonical read-path symmetry bug class); row-count drift;
non-idempotent second run.

**Secrets:** never print production connection strings, real record contents, or
owner PII surfaced during hydration. Report row-count invariants and pass/fail
per surface only.

**Abort/cleanup:** drop the disposable restored database when finished. If
`inspect` reports any unmapped active value, **stop**; do not `--allow-unmapped`
to force the write; resolve the mapping first.

---

## What this packet does not cover

Non-live open boxes are deliberately out of scope (they need code/docs, not a
human run): `add-reddit-pilot-real-shape-fixture`,
`design-fast-broad-agent-consent`,
`expose-connection-identity-on-public-read` (blocked on app-level render test
infra after the site/console split), `split-public-site-and-operator-console` inventory work. Track them, but
they consume no human/live slot.
