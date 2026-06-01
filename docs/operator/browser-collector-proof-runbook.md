# Browser-Collector Proof Runbook (Amazon)

Status: reference-experimental operator surface. Not PDPP Core or Collection Profile protocol.

This is the single-page, owner-run runbook for producing the one piece of
evidence the reference cannot fabricate without a human: proof that a
browser-bound connector (Amazon) enrolls as a `browser_collector` instance,
runs a **real, owner-logged-in** browser session locally, and ingests records
through the device-exporter path.

It closes the deferred half of the
`add-browser-collector-enrollment-primitive` proof gate (`tasks.md` §3.4) and
unblocks the intent-branch flip (`tasks.md` §3.5) and the
`add-owner-agent-control-surface` Amazon acceptance (`tasks.md` §5.3 / §8.5).

## Why a human is required

The deterministic, no-human half of the proof already lands in this repo and
runs in CI:

- `reference-implementation/test/browser-collector-ingest-proof.test.js` —
  drives the real enroll → heartbeat → `ingest-batches` → records-persisted
  path for a `browser_collector` Amazon instance, ingesting records the **real
  Amazon connector parsers** produce. The records live in the committed fixture
  `reference-implementation/test/fixtures/amazon-browser-collector-proof-records.json`,
  generated and drift-locked against the live parsers by
  `packages/polyfill-connectors/connectors/amazon/proof-ingest-records.test.ts`
  (which runs `parseOrdersListDom` over the committed scrubbed DOM fixture
  `packages/polyfill-connectors/fixtures/amazon/scrubbed/pilot-real-shape/dom/orders-list-2026.html`).
- `reference-implementation/test/device-exporter-routes.test.js` — proves
  binding-aware enrollment derives `browser_collector` for Amazon and rejects a
  contradicting source kind.
- `packages/polyfill-connectors/src/local-device-runtime.test.ts` — proves the
  monorepo runner resolves the `amazon` connector profile.

Those prove every server-side and record-shape unknown. What they cannot prove
is that a **live, logged-in Amazon browser session** is the thing that produces
those records. That step needs a real provider login (and possibly 2FA) on the
owner's own machine — exactly the step the design keeps owner-mediated and
local. Faking it (a mock that asserts the happy path without a real session)
would violate the "no faked success" bar. This runbook is therefore the only
honest way to close the gate, and it is intentionally short: the harness above
removes everything else.

## What closes the gate (the artifact)

The gate is closed when **all** of the following are committed to the
proof branch:

1. A scrubbed fixture under
   `packages/polyfill-connectors/fixtures/amazon/scrubbed/<runId>/` produced
   from a real Amazon browser-collector run via the `scrub-connector-fixtures`
   pipeline (deterministic redaction + reviewed structured redaction). The raw
   capture under `.../raw/<runId>/` is **never** committed.
2. A short evidence note (this runbook's "Step 6 — Record the evidence") naming
   the `runId`, the connector_instance_id, the accepted record counts per
   stream, and the spine `owner_agent.connection.initiate` / device-exporter
   ingest event ids — **with no secrets, cookies, tokens, names, or addresses**.
3. Only then: the intent-branch flip (`owner-connection-intent.ts`
   `browser_bound` → `enroll_browser_collector`) plus its tests, landed in the
   same reviewable unit as the evidence (spec: "the flip and the proof SHALL be
   reviewable as one unit").

If you produce 1–2 but not 3, the gate is "live-proven, flip pending"; record
that honestly. Do not flip the branch on a run you did not also scrub and
commit.

## Prerequisites

- A PDPP reference deployment reachable at a stable URL (local `pnpm dev`, or a
  Docker deployment). You need an owner session to mint enrollment codes.
- A PDPP **monorepo checkout** (not the published `@pdpp/local-collector`). The
  published package deliberately bundles only filesystem connectors; the
  browser-bound Amazon connector runs only from the monorepo runner
  (`packages/polyfill-connectors/bin/local-device-exporter.ts`).
- A logged-in Amazon session in the connector's persistent browser profile, or
  the willingness to complete the login interactively when the connector
  prompts. The agent never receives credentials and never drives 2FA.
- `node`, `pnpm`, and the monorepo dependencies installed
  (`pnpm install --frozen-lockfile`).

## Step 1 — Mint a browser-collector enrollment code

As owner, mint an enrollment code for `amazon`. Either path is fine:

**Dashboard:** open `/dashboard/device-exporters`, "Create enrollment code",
connector id `amazon`, a stable local binding name (e.g. `the owner-personal-amazon`).

**Owner agent (bearer):** `POST /v1/owner/connections/intents` is the typed
owner-agent entrypoint. Until the flip in Step 7, it returns `unsupported` for
Amazon by design, so mint the code directly against the enrollment-code route
instead:

```bash
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
if (!baseUrl) throw new Error('Set BASE_URL first.');
if (!cookie) throw new Error('Set PDPP_OWNER_SESSION_COOKIE first.');
const response = await fetch(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ connector_id: 'amazon', local_binding_name: 'the owner-personal-amazon' }),
});
const body = await response.json();
console.log('expires_at:', body.expires_at);
console.log('got_code:', Boolean(body.enrollment_code));
NODE
```

The pipe prints only whether a code was returned and its expiry — **not the
code itself**. Keep the raw code in a shell variable, never in a file or the
transcript:

```bash
ENROLLMENT_CODE="$(node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
if (!baseUrl) throw new Error('Set BASE_URL first.');
if (!cookie) throw new Error('Set PDPP_OWNER_SESSION_COOKIE first.');
const response = await fetch(`${baseUrl}/_ref/device-exporters/enrollment-codes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ connector_id: 'amazon', local_binding_name: 'the owner-personal-amazon' }),
});
const body = await response.json();
console.log(body.enrollment_code);
NODE
)"
```

Binding-aware enrollment will record this connection as `browser_collector`
(not `local_device`) — that is the source-kind half of the proof, and it is
already covered by the deterministic tests. A request that tries to force
`local_device` for Amazon is rejected before a code is minted.

## Step 2 — Enroll the host

From the monorepo checkout on the host that will run the browser:

```bash
pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts enroll \
  --base-url "$BASE_URL" \
  --code "$ENROLLMENT_CODE" \
  --device-label "the owner's laptop (Amazon)"
```

The JSON response carries `device_id`, `device_token`, `connector_instance_id`,
and `source_instance_id`. These last two are **distinct ids**: the `run` command
(Step 3) takes the `source_instance_id` via `--connection-id`, while the
verification queries below filter on `connector_instance_id`. Export both, plus
the device credentials. The `device_token` is sensitive (device-scoped ingest
only, but write-capable on this lane). Hold them in env, never commit them:

```bash
export PDPP_LOCAL_DEVICE_ID=dev_...
export PDPP_LOCAL_DEVICE_TOKEN=dvtk_...    # treat like an API key
export PDPP_CONNECTION_ID=dsrc_...         # the source_instance_id (run --connection-id)
export CONNECTOR_INSTANCE_ID=cin_...        # the connector_instance_id (verification filter)
```

Sanity-check the source kind without exposing anything sensitive. `source_kind`
is **not** carried on the device-exporter `source-instances` view; the honest
owner-reachable surface is the owner-agent listing `GET /v1/owner/connections`,
which reports `source_kind` per connection. Use an owner **bearer** here (the
same trusted-owner-agent token an automation would use), not the session cookie:

```bash
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const ownerToken = process.env.PDPP_OWNER_BEARER;
const connectionId = process.env.CONNECTOR_INSTANCE_ID;
if (!baseUrl) throw new Error('Set BASE_URL first.');
if (!ownerToken) throw new Error('Set PDPP_OWNER_BEARER first (a trusted owner-agent token).');
if (!connectionId) throw new Error('Set CONNECTOR_INSTANCE_ID first.');
const response = await fetch(`${baseUrl}/v1/owner/connections`, {
  headers: { Authorization: `Bearer ${ownerToken}`, Accept: 'application/json' },
});
const row = (await response.json()).data.find((r) => r.connection_id === connectionId);
console.log('connector_id:', row?.connector_id);
console.log('source_kind:', row?.source_kind);   // expect: browser_collector
NODE
```

A `source_kind: browser_collector` here is the source-kind half of the proof,
reported honestly through the owner-agent API. (The deterministic test
`reference-implementation/test/owner-connections-list.test.js` pins that this
listing surfaces `browser_collector` for a binding-aware Amazon enrollment, so
this step verifies the live instance, not the plumbing.) The same value is also
visible at `/dashboard/device-exporters`.

## Step 3 — Run the Amazon connector with a real session

Capture fixtures for scrubbing by setting `PDPP_CAPTURE_FIXTURES=1`. Run
**headed** for the first run so you can complete login if prompted:

```bash
PDPP_CAPTURE_FIXTURES=1 \
PDPP_AMAZON_HEADLESS=0 \
PDPP_AMAZON_YEARS="$(date +%Y)" \
  pnpm --dir packages/polyfill-connectors exec tsx bin/local-device-exporter.ts run \
    --base-url "$BASE_URL" \
    --connector amazon \
    --device-id "$PDPP_LOCAL_DEVICE_ID" \
    --device-token "$PDPP_LOCAL_DEVICE_TOKEN" \
    --connection-id "$PDPP_CONNECTION_ID"
```

- The connector verifies the session (`deepSessionCheck`). If the session has
  expired it emits an interaction with a sign-in URL and you complete the login
  **locally, yourself**. The agent never sees credentials or 2FA codes.
- Scope to the current year (`PDPP_AMAZON_YEARS`) so the proof run is small.
  One year with at least one order is enough to prove ingest.
- The runner wraps each emitted RECORD in a device envelope and ingests it via
  `POST /_ref/device-exporters/:deviceId/ingest-batches`. The JSON result
  reports `recordsQueued` and `sentBatches`.

## Step 4 — Verify ingest landed

```bash
node --input-type=module <<'NODE'
const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const cookie = process.env.PDPP_OWNER_SESSION_COOKIE;
const connectionId = process.env.CONNECTOR_INSTANCE_ID;
if (!baseUrl) throw new Error('Set BASE_URL first.');
if (!cookie) throw new Error('Set PDPP_OWNER_SESSION_COOKIE first.');
if (!connectionId) throw new Error('Set CONNECTOR_INSTANCE_ID first.');
const url = `${baseUrl}/_ref/device-exporters/source-instances?connector_instance_id=${encodeURIComponent(connectionId)}`;
const response = await fetch(url, { headers: { Cookie: cookie, Accept: 'application/json' } });
const source = (await response.json()).data[0];
console.log('accepted:', source.accepted_record_count);
console.log('last_ingest_at:', source.last_ingest_at);
console.log('outbox_state:', source.outbox_state);
NODE
```

A non-zero `accepted_record_count`, a recent `last_ingest_at`, and
`outbox_state: drained` mean the live browser session ingested through the
`browser_collector` path. That is the live proof.

## Step 5 — Scrub the captured run into a committable fixture

The raw capture under
`packages/polyfill-connectors/fixtures/amazon/raw/<runId>/` contains real order
DOM (names, addresses, order ids). **Do not commit it.** Run the
`scrub-connector-fixtures` skill/pipeline to produce
`packages/polyfill-connectors/fixtures/amazon/scrubbed/<runId>/`:

- Deterministic regex redaction removes obvious tokens, ids, and PII patterns.
- The structured-redaction pass (LLM-assisted, reviewed) handles free-form
  names/addresses the deterministic pass cannot classify.
- Manually review the scrubbed output before committing. Confirm no real name,
  address, payment string, cookie, or token survives. The existing
  `scrubbed/pilot-real-shape/dom/orders-list-2026.html` is the redaction target
  shape (`[REDACTED_NAME]`, `[REDACTED_ADDRESS]`, synthetic ASINs/order id).

Then point the deterministic proof at the new scrubbed DOM: update
`packages/polyfill-connectors/connectors/amazon/proof-ingest-records.test.ts` to
derive from the new `<runId>` DOM and regenerate the committed records fixture
(`PDPP_REGEN_PROOF_FIXTURE=1 node --test connectors/amazon/proof-ingest-records.test.ts`),
so the records the RI proof ingests stay locked to the connector's real output
on the freshly captured shape.

## Step 6 — Record the evidence (no secrets)

Append a dated entry to `tmp/workstreams/` or the change's design note with:

- `runId`, connector_instance_id, local binding name;
- accepted record counts per stream (`orders`, `order_items`);
- the spine `owner_agent.connection.initiate` and device-exporter ingest event
  ids (from `pnpm exec pdpp run timeline <run-id> --format json`);
- a one-line statement that the session was a real owner login and the scrubbed
  fixture was reviewed.

Never paste cookies, tokens, the enrollment code, names, addresses, or raw DOM.

## Step 7 — Flip the intent branch (same reviewable unit)

Only after Steps 5–6 are committed:

- In `reference-implementation/server/routes/owner-connection-intent.ts`, change
  the `browser_bound` branch to mint an enrollment code via the existing
  `ctx.deviceExporterStore.createEnrollmentCode` (the same operation the
  `local_collector` branch uses) and return
  `next_step.kind: "enroll_browser_collector"` with `connection_active: false`.
- Update `reference-implementation/test/owner-connection-intent.test.js`: Amazon
  now returns `enroll_browser_collector` (not `unsupported`).
- Check `tasks.md` §3.4 and §3.5 in
  `add-browser-collector-enrollment-primitive`, and §5.3 / §8.5 in
  `add-owner-agent-control-surface`.
- Re-run the validation matrix in the lane report.

Keep the flip diff and the committed evidence in one PR/branch so a reviewer
sees the proof and the behavior change together.

## Safety invariants (do not break)

- The agent never receives provider credentials and never drives provider login
  or 2FA. Those stay owner-mediated and local.
- The device-exporter trust model is unchanged: browser-collected ingest uses
  the same enrolled, revocable device credential and the same source-kind
  validation as filesystem collection.
- The published `@pdpp/local-collector` bundle stays filesystem-only; the
  browser-bound Amazon profile lives only in the monorepo runner.
- No raw capture, screenshot containing personal data, cookie, token, or
  provider export is ever committed.
