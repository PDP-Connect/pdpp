# Live-Proof Batch Runbook: closing every remaining owner/live gate in the fewest sittings

Status: reference/operator runbook. Not PDPP Core or Collection Profile protocol.

This is the **session-batched** companion to
[`live-proof-packet.md`](live-proof-packet.md). The packet is the per-gate
reference (prerequisite, mechanical commands, fail signatures, secret handling).
**This document is the orchestration layer**: it groups every remaining
owner/live gate into the smallest safe set of human sittings, so one operator at
one machine can close several gates without re-reading context or rediscovering
which proofs share an environment.

Read order:
- This document tells you **which sittings to schedule and in what order**.
- Each gate links into its mechanical packet for the exact commands.
- Do not duplicate the packet's commands here; follow the linked packet during
  the sitting.

Verified against `main` at the head of branch
`workstream/ri-live-proof-batch-runbook-v1`. OpenSpec task numbers are quoted
verbatim from each change's `tasks.md` as of 2026-06-01.

---

## The one rule that governs every sitting

**Do not check an OpenSpec box, and do not flip an honest `unsupported` to
`supported`, unless you actually ran the proof and captured the named evidence
artifact.** A box is `[ ]` until the artifact exists. Partial coverage stays
partial: record exactly what was proven and leave the box open with a narrowed
note. This is a voice-and-framing honesty requirement, not a process nicety — a
false "supported"/"complete" state misleads every downstream audience.

---

## Session map (the batching decision)

Eight live gates collapse into **four human sittings** plus **two opportunistic
riders** that fold into sessions the operator already runs for another reason.
The collapse is driven entirely by *shared environment*: gates that need the
same logged-in browser profile, the same deployed origin, or the same disposable
database belong in one sitting.

| Sitting | Environment it requires | Gates it closes | Est. human time | Destructive? |
|---|---|---|---|---|
| **A — Local browser-collector bench** | One host with a real Chrome and logged-in **Amazon**, **ChatGPT**, and **Reddit** profiles; monorepo checkout; a local `pnpm dev` or reachable deployment for owner auth | Gate 1 (Amazon proof + intent flip), Gate 4 (adaptive ChatGPT pilot), Gate 8 (Reddit pilot capture) | 60–120 min | No (read-only browsing) |
| **B — Hosted-MCP client bench** | A deployed `/mcp` endpoint with ≥2 connections configured, plus a **ChatGPT** MCP client and a **Claude** MCP client | Gate 2 (ChatGPT hosted-MCP event-sub), Gate 7 (Daisy/Simon owner-agent smoke) | 30–60 min | No |
| **C — Deployed real-phone bench** | A reachable public stream surface (deployed origin), the n.eko overlay rebuilt+healthy, **both** an Android Chrome phone and an iOS Safari phone | Gate 5 (n.eko real-phone matrix, 5 tasks) | 30–45 min | No |
| **D — Disposable production restore** | A **copy/restore** of the operator's production Postgres backup in a throwaway DB; the app pointed at the restore | Gate 6 (canonical-key production restore) | 45–90 min | **Yes — destructive-capable** |
| **Rider — Chase** | Any live Chase session the operator runs anyway | Gate 3 (Chase native-ID investigation) | +5 min | No |
| **Rider — Claude MCP** | The Claude side of Sitting B (already live-proven 2026-05-31) | confirms Gate 2's Claude half stays green | +0 | No |

### Recommended order

```
A (local browser bench)  →  B (hosted MCP)  →  C (real phone)  →  D (production restore, LAST)
                          ↘ Chase rider folds into any future bank session, never its own sitting
```

Rationale:
- **A first**: it is the highest-value, lowest-risk sitting and produces three
  scrubbed fixtures that downstream regression tests lock against. It needs only
  a laptop.
- **B second**: depends only on a deployed `/mcp` + two clients; independent of A.
- **C third**: needs two physical phones and a deployed origin — more setup, so
  schedule it when the hardware is on hand.
- **D LAST and deliberate**: it is the only destructive-capable act in the whole
  program. Run it against a disposable restore, never live production, and only
  after you are unhurried.
- **Chase rider**: never schedule a dedicated bank login. Fold it into a future
  live Chase run the operator already does.

Sittings A, B, C, and D are mutually independent — they can be run in any order,
by different people, on different days. The order above only optimizes
value-per-effort and keeps the destructive act last.

---

## Secret handling (applies to every sitting)

Never print, commit, or paste: owner session cookies / bearers, enrollment
codes, device tokens, provider credentials/cookies, scoped stream tokens, MCP
integration secrets, owner passwords, production connection strings, or raw
captured DOM/records before scrubbing.

- Supply `PDPP_OWNER_SESSION_COOKIE` / owner bearer / `PDPP_*_PASSWORD` to
  commands **without echoing the value** (`export`, or a here-doc that reads
  `process.env`; never `echo`).
- Any `PDPP_CAPTURE_FIXTURES=1` capture must pass through the
  `scrub-connector-fixtures` skill before it leaves the host. Raw runs live under
  `packages/polyfill-connectors/fixtures/<connector>/raw/`; only
  `<connector>/scrubbed/<runId>/` is committable.
- Report **invariants** (row counts preserved, `accepted_record_count > 0`,
  `connection_active: false`, no URL-shaped ids), never the underlying personal
  data.

---

## Sitting A — Local browser-collector bench

**One host, one Chrome, three logged-in profiles. Closes three gates.**

All three gates here run browser-session connectors through the **local
device-exporter / connector path with a real, visible Chrome** — the same
runtime, the same `PDPP_CAPTURE_FIXTURES=1` capture step, the same
`scrub-connector-fixtures` review. That shared environment is exactly why they
batch: enroll once per connector, complete each provider's login in the visible
window, capture, scrub, commit.

### Shared preconditions

- A **monorepo checkout** (not the published `@pdpp/local-collector`, which is
  filesystem-only — browser-bound Amazon/Reddit profiles live only in the
  monorepo runner `packages/polyfill-connectors/bin/local-device-exporter.ts`).
- `pnpm install --frozen-lockfile`; `node` + `pnpm` present.
- A reachable PDPP deployment (local `pnpm dev` or Docker) for owner auth and
  enrollment-code minting.
- Logged-in (or interactively log-in-able) Amazon, ChatGPT, and Reddit sessions
  in the connector's persistent browser profile. The agent never receives
  credentials and never drives 2FA — you complete each login yourself in the
  visible window.
- `PDPP_AMAZON_HEADLESS=0` (and the equivalent for other connectors) so the
  first run is headed and you can complete login.

### Gate 1 — Amazon browser-collector proof + intent flip

**Closes:** `add-browser-collector-enrollment-primitive` task line 42 (Amazon
end-to-end proof test + scrubbed fixture) and, as one reviewable post-proof unit,
line 62 (flip `browser_bound` → `enroll_browser_collector`), plus
`add-owner-agent-control-surface` task 5.3 (Amazon acceptance).

**Mechanical packet:** execute
[`browser-collector-proof-runbook.md`](browser-collector-proof-runbook.md)
verbatim (Steps 1–7). It is verified runnable; do not paraphrase its commands.

**Expected evidence artifact:**
- A scrubbed fixture committed under
  `packages/polyfill-connectors/fixtures/amazon/scrubbed/<runId>/` from a real
  owner-logged-in Amazon run.
- A no-secrets evidence note: `runId`, `connector_instance_id`, accepted record
  counts per stream (`orders`, `order_items`), spine ingest event ids.

**Pass/fail acceptance:**
- PASS: `accepted_record_count > 0`, recent `last_ingest_at`,
  `outbox_state: drained` on the `browser_collector` source instance; scrubbed
  fixture reviewed and committed.
- FAIL signatures: instance marked active before enrollment completes; intent
  returning a next step that completes provider auth without owner mediation;
  `ambiguous_connection` not raised when two Amazon instances exist.

**Do not mark complete unless:** the proof box and the flip box are **separate**.
If you land the scrubbed fixture + evidence but not the intent flip, record
"live-proven, flip pending" and leave both open. Only check both when the flip
(`reference-implementation/server/routes/owner-connection-intent.ts` returning
`enroll_browser_collector` with `connection_active: false`) and its tests land in
the same reviewable unit as the evidence — the spec requires proof and flip to be
reviewable together. **Do not flip `unsupported` → `supported` on a run you did
not scrub and commit.**

### Gate 4 — Adaptive-lane ChatGPT live pilot + telemetry

**Closes:** `add-connector-adaptive-lanes` task line 45 (run one Docker ChatGPT
live pilot with fixture capture), line 46 (compare live telemetry to the
serialized baseline). Two further boxes are **desk decisions gated on this run's
telemetry**, not separate sittings: line 51 (whether ChatGPT may raise
`maxConcurrency` above `1`) and line 52 (next connector candidate).

The adaptive lane is wired into the ChatGPT conversation-detail loop
(`createAdaptiveLane` in
`packages/polyfill-connectors/connectors/chatgpt/index.ts`); it exercises on any
ChatGPT run through the local browser path. It does **not** need the dead host
bridge (see "Do not do" at the end).

**Prerequisite:** ChatGPT profile logged in; `PDPP_CAPTURE_FIXTURES=1`;
connector at its first-pilot pressure (`initialConcurrency = 1`,
`maxConcurrency = 1`, already the committed default).

**Command/action:** trigger a ChatGPT run from the dashboard / collector runner
on the host with the real visible browser, complete any login/OTP/Cloudflare in
the window, then read the run timeline:

```bash
pnpm exec pdpp run timeline <run-id> --format json   # supply owner auth; do not print the cookie
```

**Expected evidence artifact:**
- A scrubbed fixture committed under
  `packages/polyfill-connectors/fixtures/chatgpt/scrubbed/<runId>/`.
- A no-secrets telemetry note from the run timeline.

**Pass/fail acceptance:** the lane telemetry must show:
- no retry exhaustion;
- no burst above the configured lane cap (1 concurrent detail fetch);
- clear cooldown / progress messages;
- successful cursor commit on terminal success, and **no** cursor advance on a
  failed required-detail collection.

FAIL signatures: retry storm above cap; cursor advanced on a failed required
detail; lane telemetry leaking secret-bearing URLs/headers/cookies (redaction is
unit-tested in task 5.x — confirm it held live).

**Do not mark complete unless:** the pilot actually ran and the telemetry was
captured. A failed pilot is still useful evidence — record it and leave the boxes
open. **Do not raise `maxConcurrency` (line 51) or pick the next candidate
(line 52) on a failed or absent pilot.** The runtime is built to be decided *from
evidence*; deciding first defeats the design. If the single-lane pilot shows
clean sustained success with headroom, the owner *may* decide to allow `> 1` in a
follow-up; otherwise hold at 1 and say why.

### Gate 8 — Reddit pilot real-shape capture

**Closes:** `add-reddit-pilot-real-shape-fixture` (0/20). The whole change
*starts* with an owner-only live capture; everything after the capture
(redaction plan → scrub → commit → tests → docs → validate) is **no-human** and
can be handed to the `scrub-connector-fixtures` skill. Batching the capture into
Sitting A means the only human-gated step (the live run) costs you one extra
logged-in profile in a bench you already have open.

Reddit is a **logged-in browser-session connector** (six streams: `submitted`,
`comments`, `saved`, `upvoted`, `downvoted`, `hidden`), so it runs through the
same local-device-exporter/browser path as Amazon. Use the Amazon runbook's
enroll → run shape, substituting `--connector reddit`.

**Prerequisite:** logged-in Reddit profile; `PDPP_CAPTURE_FIXTURES=1`; headed
first run.

**Command/action (capture only — the human-gated half):** run the v0.2.0 Reddit
connector against the owner account with capture enabled and confirm all six
streams emit records. Then verify the raw run landed:

```text
fixtures/reddit/raw/<runId>/records/*.jsonl
fixtures/reddit/raw/<runId>/http/*.json
```

**Expected evidence artifact (this sitting):** a raw capture under
`fixtures/reddit/raw/<runId>/` with all six streams represented. **Do not commit
the raw capture.**

**Then (no-human, can leave the bench):** author the per-file
`<path>.redactions.json` plans (`[REDACTED_*]` placeholders only; cover free-form
`title`/`body`/`selftext`/`url`/permalink slugs; leave `t3_*`/`t1_*` ids and
non-identifying subreddit names alone), run
`pnpm exec tsx bin/scrub-fixtures.ts reddit <runId> --llm-redactions-dir ./local-redactions/reddit`,
rename to `fixtures/reddit/scrubbed/pilot-real-shape/`, get a second reviewer to
eyeball for residual PII, then land the integration-test block, docs, and
`openspec validate` per tasks 28–41. The `scrub-connector-fixtures` skill exists
for exactly this pipeline.

**Pass/fail acceptance:**
- PASS: all six streams emit records in the raw run; scrubber exits 0 with every
  raw file accounted for (fail-closed mode catches missing plans); every scrubbed
  record still parses as JSON and preserves `id`, `created_utc`, `kind`, and
  stream-specific required fields; a second reviewer signed off on no residual
  PII.
- FAIL signatures: a stream emits zero records (capture incomplete — do not pass
  off a partial pilot as the real shape); scrubber exits non-zero on a missing
  plan; residual identifying text survives review.

**Do not mark complete unless:** a reviewer **other than the capture author**
signed off on the scrubbed output (task 22), and the live run actually emitted
all six streams. If residual PII is found, add a deterministic rule to
`connectors/reddit/scrub-rules.ts` or extend the plan — **never hand-edit
scrubbed output** (task 24).

### Sitting A close-out

Three scrubbed fixtures and (for Gate 1) one intent-flip diff should exist. Run
the connector-package validation before reporting:

```bash
pnpm --dir packages/polyfill-connectors run verify
pnpm --dir packages/polyfill-connectors test
```

Leave any gate whose live half did not complete cleanly as open with a narrowed
note. Revoke any enrolled device you abandon (`/dashboard/device-exporters`); the
device token is write-capable on its ingest lane.

---

## Sitting B — Hosted-MCP client bench

**One deployed `/mcp`, two MCP clients. Closes two gates.**

Both gates here drive a **trusted-client/agent flow against a live deployment**:
Gate 2 from a ChatGPT MCP client, Gate 7 from the owner-agent control plane. They
share the precondition of a reachable deployment with ≥2 connections configured,
so configure once and run both.

### Shared preconditions

- A reachable hosted MCP integration endpoint (the running deployment's `/mcp`)
  and a ChatGPT client able to connect to it (developer-mode / connector
  integration). See [`hosted-mcp-setup.md`](hosted-mcp-setup.md).
- At least **two** connections configured so the multi-connection
  `ambiguous_connection` → `connection_id` retry path is exercised. Confirm with
  an owner read first (set `BASE_URL` and `PDPP_OWNER_SESSION_COOKIE`; do not echo
  the cookie):

```bash
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
if (!baseUrl || !cookie) throw new Error('Set BASE_URL and PDPP_OWNER_SESSION_COOKIE.');
const r = await fetch(`${baseUrl}/v1/streams`, { headers: { Cookie: cookie, Accept: 'application/json' } });
const body = await r.json();
console.log('stream_count:', Array.isArray(body.data) ? body.data.length : 'n/a');
NODE
```

### Gate 2 — ChatGPT hosted-MCP event-subscription proof

**Closes:** `canonicalize-connector-keys` task 5.2 — the **ChatGPT side**. The
Claude side is already live-proven (2026-05-31). The task is explicit: **do not
mark 5.2 complete until ChatGPT is also live-proven** or the task is explicitly
narrowed.

**Mechanical packet:** follow
[`chatgpt-mcp-canonical-proof-packet.md`](chatgpt-mcp-canonical-proof-packet.md)
for the full step sequence, schema checks, partial-evidence classification, and
Codex pass/fail bar. Do not duplicate its steps here.

**The precise residual this gate must close:** ChatGPT registration refresh
(stale 6-tool surface → delete/re-add → current 14-tool surface) and a `messages`
`query_records` retry with a `connection_id` were *already observed*. What is
**still unproven for ChatGPT** is the **event-subscription create / list / get /
send-test / delete lifecycle**. That lifecycle is the whole point of this
sitting; a registration refresh alone does not close 5.2. A stale 6-tool surface
is host registration drift (fix by delete + re-add), **not** a backend defect.

**Command/action (in the ChatGPT client):** connect → list tools → inspect a
stream/schema → query records → trigger `ambiguous_connection` and retry by
`connection_id` → **create / list / get / send-test / delete an event
subscription**.

**Expected evidence artifact:** a short no-secrets note (tools listed, the
disambiguation retry, the full subscription lifecycle observed) appended to the
change's design note or the gate's evidence line.

**Pass/fail acceptance:**
- PASS: the full lifecycle (including event-subscription create→delete) completes
  and **no URL-shaped connector ids** (`https://<host>/connectors/<key>`) appear
  in any owner-facing tool guidance — only canonical `connector_key` /
  `connection_id`.
- FAIL signatures: URL-shaped ids surfaced in tool guidance; ambiguity retry
  fails to disambiguate by `connection_id`; subscription create/delete errors.

**Do not mark complete unless:** the **event-subscription lifecycle was actually
driven from ChatGPT** — not inferred from tool exposure, not substituted by the
Claude run. The prior reconcile attempt was owner-rejected for exactly this
overclaim. Delete any subscription you created so the deployment is left clean.

### Gate 7 — Daisy/Simon owner-agent live smoke

**Closes:** `add-owner-agent-control-surface` task 8.5 — run a live
Daisy/Simon-equivalent smoke proving a trusted owner agent can **list connection
instances, label one, initiate a new Amazon connection intent, and stop at the
owner-mediated provider step.**

This is the owner-agent **control plane** (owner-bearer `/v1/owner/*` REST, *not*
`/mcp`). It batches into Sitting B because it needs the same live deployment with
configured connections, plus an owner-agent bearer credential. The reference
skill and runbook are
`docs/agent-skills/pdpp-owner-agent/references/control-surface.md` and
`docs/agent-skills/pdpp-owner-agent/references/daisy-runbook.md`.

**Prerequisite:** an owner-agent bearer credential file (e.g.
`~/applications/daisy/.pi/agent/pdpp-owner-agent.json`); the deployment from the
shared preconditions; at least one connection to label.

**Command/action:**

1. Discover supported control actions + connection instances in one non-secret
   call:

   ```bash
   pdpp owner-agent control --credential-file <path-to-owner-agent-credential>
   ```

   This reads `GET /v1/owner/control` (capability families) and
   `GET /v1/owner/connections` (each `connection_id`, `connector_id`,
   `display_name`, `label_status`, `status`) and prints them without echoing the
   bearer.

2. **Label** one connection instance (operate on the stable `connection_id`,
   never on a connector template like `amazon`).

3. **Initiate a new Amazon connection intent** via
   `POST /v1/owner/connections/intents`. Until Gate 1's flip lands, Amazon
   returns a typed `unsupported` whose reason names the missing browser-collector
   primitive — that **is** the acceptance-permitted "owner-mediated next step" for
   8.5 (stopping honestly at the provider step). If Gate 1's flip *has* landed,
   the intent instead returns `enroll_browser_collector` with
   `connection_active: false` and stops before any provider auth.

**Expected evidence artifact:** a no-secrets transcript note: the control
capability families observed, the `connection_id` labeled and its
before/after `label_status`, and the Amazon intent's typed `next_step.kind`
(`unsupported` with named primitive, or `enroll_browser_collector` with
`connection_active: false`).

**Pass/fail acceptance:**
- PASS: the agent lists instances by `connection_id`, a label write succeeds and
  is reflected on re-read, and the Amazon intent returns a typed next step that
  stops at the owner-mediated step (no provider auth driven by the agent).
- FAIL signatures: the agent can authorize a bearer against `/mcp`; the intent
  completes provider auth without owner mediation; labeling mutates the wrong
  instance; control surface advertises an action it cannot enforce.

**Do not mark complete unless:** the smoke ran against a **live deployment** with
a real owner-agent bearer (not a unit test — the typed-`unsupported` path is
already unit-covered by `test/owner-connection-intent.test.js`; 8.5 is the *live*
proof). The bearer is never pasted into the transcript or this repo.

> **Bearer hygiene carry-over:** a prior checkpoint noted a live owner-agent
> bearer was once pasted into chat. If that credential is production-sensitive,
> rotate/revoke it before this sitting.

### Sitting B close-out

Two no-secrets evidence notes should exist. Gate 2 closes
`canonicalize-connector-keys` 5.2 *only* if the event-subscription lifecycle ran.
Gate 7 closes `add-owner-agent-control-surface` 8.5. Delete any test event
subscription created during Gate 2.

---

## Sitting C — Deployed real-phone bench

**One deployed origin, the n.eko overlay, two physical phones. Closes five tasks
in one matrix.**

**Closes (all from one real-phone session against the public stream surface):**
`add-run-interaction-streaming-companion` tasks 12.8, 13.5, 14.7, 15.8, 17.5.
Desktop and Playwright mobile-emulated smokes already pass for all five; **only
the physical real phone remains.** Mobile-emulated Playwright is explicitly **not**
a substitute (per `openspec/changes/add-run-interaction-streaming-companion/design-notes/neko-ux-acceptance-2026-05-06.md`).

### Preconditions

- The n.eko Docker overlay rebuilt/recreated and healthy.
- A public stream surface reachable (`peregrine-dev.vivid.fish` or equivalent
  deployed origin).
- A real phone, ideally **both Android Chrome and iOS Safari** (the matrix names
  both).
- Stream debug telemetry enabled so each smoke produces inspectable evidence.

### Command/action

Rebuild the overlay (always uses the neko-dynamic profile):

```bash
bash scripts/reference-stack.sh up --build-app     # or --build-all
```

Run the automated owner-surface smoke first (skips cleanly without a public URL):

```bash
PDPP_STREAM_SMOKE_URL=https://peregrine-dev.vivid.fish \
PDPP_STREAM_SMOKE_OWNER_PASSWORD=<redacted>  \
  pnpm docker:stream-smoke           # node scripts/manual-action-stream-smoke.mjs
```

Then drive the **same public surface from a physical phone**:
`https://<public-host>/dashboard/stream-playground?backend=neko`

Exercise per the matrix: chrome-free display (no n.eko room UI, no extension /
address chrome); pointer/touch alignment; local-to-remote paste via the Clipboard
Sheet; mobile keyboard open / dismiss / reopen with optimistic reacquire;
rotation settle without stretch; reconnect / app-switch; visual sharpness.

### Expected evidence artifact

A debug-telemetry capture per smoke. Save `pnpm stream-debug:summary` over the
captured trace as the artifact. Record which platform(s) were covered.

### Pass/fail acceptance (per smoke, with debug-telemetry capture)

- chrome-free display; pointer/touch alignment within tolerance (≤10 CSS px);
  rotation settles without stretch (≤250ms);
- mobile keyboard opens/dismisses/reopens and reacquire confirms editable focus
  (rollback if the remote page never confirms);
- clipboard host-to-remote paste and remote-to-host buffer both work;
- pixel-fit 1:1 flags and acceptable gutter ratio in the visual-quality
  telemetry.

FAIL signatures: stretched stream on orientation change; keyboard reacquire
rollback; stream not settling (media-settle requested-vs-actual mismatch); scoped
stream token exposed without scope.

### Do not mark complete unless

**DO NOT mark complete on partial-platform coverage.** The matrix names Android
Chrome **and** iOS Safari. If only one phone is available, log exactly which
platform was covered and leave the five boxes open with a narrowed note. Tear the
overlay down when finished: `bash scripts/reference-stack.sh down`.

**Secrets:** never print `PDPP_STREAM_SMOKE_OWNER_PASSWORD`, the owner session
cookie, the scoped stream token, or any clipboard contents from the paste test.

---

## Sitting D — Disposable production restore (LAST, deliberate)

**One disposable database. Closes one gate. The only destructive-capable act in
the program.**

**Closes:** `canonicalize-connector-keys` task 3.4 — the real-data close-out. The
synthetic-data harness already passes **38/38 SQL + 15/15 HTTP + 17/17
data-agnostic invariants + idempotency** against the real reference schema. What
remains is running the same restore → migrate → verify cycle against a restore of
the operator's **own production backup**.

**Mechanical packet:** follow
[`canonical-connector-keys-production-restore-packet.md`](canonical-connector-keys-production-restore-packet.md)
— exact env vars, restore-into-disposable-DB commands, before-snapshot capture,
inspect→write→verify→idempotency sequence, HTTP spot-check, no-secrets evidence
list, unmapped-value troubleshooting, cleanup, and the Codex-acceptance bar.

**Run it against a DISPOSABLE restore, never the live production DB.**

### Preconditions

- A **copy/restore** of the production Postgres backup into a disposable
  database. Never point at live production.
- The reference app pointed at the restored DB so the HTTP read path can be
  spot-checked.

### Command/action (against the disposable restore only)

```bash
# capture before-counts first (see the dedicated packet §4.2), then:
node reference-implementation/scripts/canonical-connector-keys/cli.mjs inspect
node reference-implementation/scripts/canonical-connector-keys/cli.mjs write --apply
#   fail-closed on unmapped active values; do NOT pass --allow-unmapped to bypass.
node reference-implementation/scripts/canonical-connector-keys/verify-production-invariants.mjs \
  --before /tmp/cck-prod-before.json
#   data-agnostic: asserts zero stragglers + row-count parity for ANY dataset.
```

Then point the app at the restored+migrated DB and spot-check the HTTP path
(`/dashboard`, `/dashboard/explore`, `/dashboard/event-subscriptions`,
grant-package membership, record reads, owner dashboard hydration).

> **Use the data-agnostic verifier, not the seed verifiers.** The seed-specific
> `verify-backup-restore.mjs` and `verify-http-surfaces.mjs` hard-code the
> synthetic seed's grant ids, record counts, owner subject, and streams — they
> **FAIL on real data**. Run only `verify-production-invariants.mjs` against the
> production restore.

### Expected evidence artifact

A no-secrets invariants note: per-table row-count parity vs the before-snapshot,
zero non-canonical stragglers in active tiers, idempotent second run, and
per-surface HTTP spot-check pass/fail.

### Pass/fail acceptance

- Row counts preserved on all touched tables (assert *preservation*, not a fixed
  count; production differs from the harness's 14).
- Zero URL-shaped / legacy / wrapped-local-device connector ids remain in active
  tiers; backup-tier untouched unless `--include-backup-tables`.
- Owner dashboard hydrates, grant packages resolve, records read in the running
  app against migrated production-shaped data.
- Idempotent: a second `write --apply` rewrites nothing.

FAIL signatures: `connection_not_found` on owner/grant-scoped reads
post-migration (the canonical read-path symmetry bug class); row-count drift;
non-idempotent second run.

### Do not mark complete unless

The cycle ran against a **real production-backup restore** — synthetic data does
not stand in for production row volume/identity shapes. If `inspect` reports any
unmapped active value, **stop**; do **not** `--allow-unmapped --apply` to force
the write — resolve the mapping first. Drop the disposable restored database when
finished. Never print production connection strings or owner PII.

---

## Rider — Chase current-activity native-ID investigation

**Folds into any live Chase session the operator already runs. Never its own
sitting.**

**Closes:** `add-chase-current-activity-stream` task 1.2. This is an
**investigation, not a smoke** — no pass/fail proof artifact, and it does not
block the (complete) fixture-backed implementation.

**Command/action:** while logged into Chase current activity, inspect the DOM
attributes and network payloads of the current-activity surface for **stable
native transaction IDs**, and check whether the connector's documented fallback
key survives a pending-to-posted transition.

**Expected outcome (recorded in `add-chase-current-activity-stream/design.md`):**
- If stable native IDs exist: open a follow-up to update the connector key
  strategy to prefer them; note the attribute/payload path. Leave task 1.2 open
  until that follow-up lands.
- If not: record "no stable native IDs; documented fallback key retained" and
  check task 1.2.

**Secrets:** never print account numbers, balances, or transaction detail. Record
only the schema-level finding (IDs present/absent, fallback survives/not).

---

## Coverage map — every scope item to its sitting and OpenSpec task

| Scope item (from the lane objective) | Sitting | OpenSpec change · task(s) | State today |
|---|---|---|---|
| Amazon / browser-collector live proof + intent flip | A | `add-browser-collector-enrollment-primitive` lines 42, 62; `add-owner-agent-control-surface` 5.3 | code+deterministic proof green; live session + flip pending |
| Adaptive ChatGPT Docker pilot | A | `add-connector-adaptive-lanes` lines 45, 46 (pilot/compare); 51, 52 (desk decisions on telemetry) | runtime + simulator tested; live pilot pending |
| Reddit pilot real-shape capture | A | `add-reddit-pilot-real-shape-fixture` (0/20) | capture is human-gated; scrub→test→docs no-human after |
| ChatGPT hosted-MCP event-sub proof | B | `canonicalize-connector-keys` 5.2 (ChatGPT half) | Claude proven 2026-05-31; ChatGPT event-sub lifecycle unproven |
| Daisy/Simon owner-agent live smoke | B | `add-owner-agent-control-surface` 8.5 | typed-unsupported path unit-covered; live smoke pending |
| n.eko public desktop + real-phone smoke | C | `add-run-interaction-streaming-companion` 12.8, 13.5, 14.7, 15.8, 17.5 | no-human halves green via `pnpm stream:no-human-verify`; real phone pending |
| Canonical production-backup restore proof | D | `canonicalize-connector-keys` 3.4 | synthetic harness 38+15+17 green; real-prod restore pending |
| Chase current-activity ID check | Rider | `add-chase-current-activity-stream` 1.2 | investigation only; folds into a future Chase run |

---

## Do not do (carried from the closeout triage; included so a sitting does not chase dead work)

1. **Do not prove `design-host-browser-bridge-for-docker` (lines 4, 41).** The
   bridge binary `bin/host-browser-bridge.ts` was deleted by the archived
   `2026-05-29-introduce-local-collector-runner`; its proof commands point at
   non-existent code. **Archive the change as superseded** — its proof value
   migrated to Gate 4 (adaptive ChatGPT via the local browser path). This is a
   desk/archive action, not a sitting.
2. **Do not flip Gate 1's intent branch or close 5.3** without a real Amazon
   browser-session enroll → ingest proven with scrubbed evidence.
3. **Do not mark `canonicalize-connector-keys` 3.4 or 5.2 complete** without
   (3.4) a real production-backup cycle and (5.2) the ChatGPT-side
   event-subscription lifecycle. The no-human harness strengthens but does not
   erase the live gate; the prior owner rejection of this exact overclaim stands.
4. **Do not raise ChatGPT `maxConcurrency` above 1, or pick the next connector
   candidate,** before Sitting A's pilot produces telemetry.
5. **Do not substitute Playwright mobile emulation for the physical phone** in
   Sitting C.
6. **Do not run Sitting D's seed verifiers** (`verify-backup-restore.mjs`,
   `verify-http-surfaces.mjs`) against production data — they assert synthetic
   seed values and will fail. Use `verify-production-invariants.mjs`.

---

## What this runbook does not cover

Non-live open boxes are out of scope (they need code/docs/owner-product
decisions, not a human run): `design-fast-broad-agent-consent` (all remaining
tasks are owner/product decisions; tasks 44/45 require a new OpenSpec change
before code; task 47 freezes PAR/consent-storage/UI/issuance),
`expose-connection-identity-on-public-read` per-connection grant-scope UI
(product/UX decision; runtime already enforces `grant.streams[].connection_id`),
`republish-remote-surface-as-opendatalabs` release-management decisions, and the
archive-only flips for `add-compact-rs-schema-view`,
`register-ynab-budgets-compaction-policy`, `split-public-site-and-operator-console`,
and `design-host-browser-bridge-for-docker`. Track them, but they consume no
human/live slot.

The silent `limit`-clamp token-efficiency gap is **closed** (see
`add-records-limit-clamp-warning`, 25/25, shipped to `main`) — it is no longer a
pending gate.
