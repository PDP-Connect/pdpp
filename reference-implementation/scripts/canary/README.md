<!--
Copyright The PDP-Connect Contributors
SPDX-License-Identifier: Apache-2.0
-->

# deploy-canary — pre-registered deploy verification

Turns a production deploy's verification from an hour of hand-typed greps,
`psql` queries and `docker inspect` calls into one command that fails closed
and leaves a receipt.

Required by **D15** ("pre-register each step's canary metrics BEFORE deploying
it; post-hoc success criteria are how 'green' claims died in this program")
and **D14** ("behavior preservation is a gate, not a hope — proven by
before/after comparison on the drain canary, not narrated").

## Usage

```sh
# Dry run (DEFAULT). Reads production, changes nothing.
node reference-implementation/scripts/canary/deploy-canary.ts \
  --manifest=reference-implementation/scripts/canary/manifests/step-1-run-lifecycle.json \
  --ref=fix/sweep-fairness-and-transformer-bounds

# Deploy for real.
node reference-implementation/scripts/canary/deploy-canary.ts \
  --manifest=.../step-1-run-lifecycle.json --ref=<ref> --apply
```

`--receipt-dir=<path>` sets where receipts land (default
`local/canary-receipts`). `PDPP_OWNER_PASSWORD` must be set for
`connector_run` checks; `PDPP_CANARY_ORIGIN` overrides the default origin
`https://pdpp.vivid.fish`.

Exit code is `0` on pass or dry run, `1` on any blocking failure, artifact
mismatch, or manifest rejection.

## What it does, and which real failure each phase prevents

| Phase | Action | The failure it exists to catch |
|---|---|---|
| 1 | Build from a ref, base image digest-pinned | A floating base image (a real suspected defect) |
| 2 | **Artifact-verify**: content greps INSIDE the image | A "deploy" that never happened — production restarted onto the SAME tag while the fix was believed live for hours |
| 3 | Capture pre-image: inspect, env, rollback target, BEFORE metrics | Nothing to compare against, and no known-good rollback target |
| 4 | Deploy, preserving config; **rename** the old container | Lost restart policy / limits / volumes; unrecoverable rollback |
| 5 | Run the pre-registered checks | — |
| 6 | Emit a receipt | Claims without evidence |
| 7 | Roll back automatically on any blocking failure | A bad deploy left running because verification was manual |

Phase 2 **fails closed**: if the built image does not contain what the
manifest asserts, nothing is deployed and the receipt records
`ABORTED_ARTIFACT_MISMATCH`. A tag is a label anyone can move and a commit sha
describes source, not bytes — only a grep inside the image is evidence.

## Manifest schema

```jsonc
{
  "step": "step-1-run-lifecycle",
  "description": "...",
  "container": "pdpp-core-prod-drain",   // the production container
  "imageRepo": "pdpp-core",
  "imageTag": "canary-step1",
  "dockerfileTarget": "core",
  // MUST contain @sha256: — a floating base is rejected at parse time.
  "nodeBaseImage": "node:24.19.0-bookworm-slim@sha256:3638d9a6...",
  "postgresContainer": "pdpp-postgres-1",

  // At least one is REQUIRED. Checked inside the image BEFORE deploying.
  "artifactAssertions": [
    { "id": "...", "description": "...", "path": "/app/...", "pattern": "...", "minCount": 1 }
  ],

  "checks": [ /* see below */ ]
}
```

Every check has `id` (unique), `description`, `kind`, and `blocking`. Only a
failing **blocking** check triggers rollback.

### Check kinds

- **`sql_scalar`** — `sql`, `predicate`, optional `bound`. Predicates:
  `must_not_increase`, `must_not_decrease`, `must_equal`, `must_stay_zero`,
  `must_be_at_most`, `must_be_at_least`. Threshold/equality predicates require
  `bound`. A `must_not_*` predicate with no BEFORE value fails closed.
- **`sql_timestamp`** — `sql`, `predicate: "must_not_advance"`. Appearance and
  disappearance both count as failures.
- **`container_fact`** — `fact: "restart_count" | "running_image"`. Use
  `must_change` on `running_image` to prove the container actually picked up
  the new bytes.
- **`log_pattern`** — `pattern`, `maxOccurrences`, `sinceSeconds`. `0` means
  "must not appear"; a positive value allows an expected containment message.
- **`http_health`** — `url`, `expectStatus`.
- **`connector_run`** — `connectionId`, `connectorSlug`, `timeoutSeconds`.
  Triggers a real run and waits for `succeeded`. A timeout reports `timeout`,
  not `failed`: an unfinished run is an unknown.

## The OTP denylist — a code-level gate

`usaa`, `chase`, `heb`, `amazon`, `venmo`, `reddit`.

Each of these sends a **real one-time password to the owner's phone** when a
run starts. One was burned when a crash killed a run 49 seconds after the code
arrived.

Enforcement is in code, not a comment:

1. **At manifest-parse time** — `parseManifest` throws `ManifestError` on a
   `connector_run` naming a denylisted connector. The manifest never loads, so
   the deploy path is never entered and no receipt is written.
2. **Again at the trigger site** — `triggerConnectorRun` re-checks before
   issuing any HTTP request. This is the last point before an irreversible
   side effect, and a check there should not rely on a caller having validated.

The denylist is a hard-coded constant, not manifest configuration: a denylist
a manifest can edit is one an operator can disable at 2am, which is exactly
when it matters. Matching normalizes case and separators, so `USAA`,
`chase-bank` and `chase_bank` are all caught, while `chaseable` is not.

`connectorSlug` is a required field precisely so the gate cannot be dodged by
supplying only an opaque `cin_...` the parser cannot classify.

## Env derivation — the rule, and both failure modes

`docker inspect .Config.Env` returns the container's FULL environment: the
operator's `-e` flags **and** everything baked into the image. Replaying all 97
vars onto a new image re-injects the OLD image's values. So some filtering is
needed — and this is where it went wrong twice in one day, in both directions.

**The tempting rule, which is catastrophic.** "Drop anything the image also
declares" — filtering by NAME. Measured against the live container that drops
25 vars, and 5 of them are real operator overrides that merely share a name
with an image default:

```
PDPP_DB_PATH                   image=/var/lib/pdpp/pdpp.sqlite
                               live =/root/.pdpp/pdpp.sqlite      <-- the database
PDPP_CONNECTOR_ARTIFACT_ROOT, PDPP_EMBEDDING_CACHE_DIR,
PDPP_REFERENCE_ORIGIN, PDPP_REFERENCE_REVISION
```

Dropping `PDPP_DB_PATH` points production at the **wrong database**. Nothing
about the name distinguishes a real override from an image default.

**The over-correction.** Filtering by a hand-written list dropped `NODE_ENV`
and `PLAYWRIGHT_BROWSERS_PATH` and broke connector execution.

**The rule used here.** Drop a variable only when the new image declares the
**same name AND the same value**. Then dropping it is provably a no-op: the
image supplies an identical value, or a deliberately updated one that *should*
win (this is how a new base image's `PATH` takes effect). Any differing value
is, by construction, information the image does not have — an override — and is
carried.

Measured live: **77 carried, 20 dropped, 5 overrides preserved and reported.**

Because "provably a no-op" is a claim about values the operator cannot see at
a glance, the tool **reports every dropped var and prints each carried
override with both values** so a wrong call is caught before it lands.

Secrets are redacted by name in both console output and receipts.

## The TEXT-timestamp trap

`records.emitted_at`, `device_ingest_batch_outcomes.created_at`,
`run_history.started_at` and friends are **`text`**, not `timestamptz`.
Postgres compares TEXT to a cast interval lexicographically and silently
matches the wrong rows. Measured live, for the same intended window:

```sql
-- WRONG: returned 208
where created_at > (now() - interval '1 hour')::text
-- RIGHT: returned 8
where (created_at)::timestamptz > now() - interval '1 hour'
```

A 26x overcount that still looks like a number. `parseManifest` **rejects** a
query that compares such a column to an interval without an explicit
`::timestamptz`. Set `"requireExplicitCast": false` on a check to accept the
risk deliberately.

Related trap, in the seeded manifest: the naive "non-terminal runs" metric
(`run.started` minus terminal events) measured **2**, not 0 — both were runs
legitimately in flight, seconds old. A `must_stay_zero` on that form would
fire a **false rollback** on any deploy landing while a connector is running.
The shipped check bounds it by age (`status='running'` older than 2 hours), so
it means *stuck*, not *busy*.

## Receipt format

JSON at `<receipt-dir>/canary-<step>-<timestamp>.json`:

```jsonc
{
  "tool": "deploy-canary",
  "step": "...", "ref": "...", "refCommit": "<full sha>",
  "image": "pdpp-core:canary-step1", "imageDigest": "sha256:...",
  "nodeBaseImage": "node:24.19.0-bookworm-slim@sha256:...",
  "container": "pdpp-core-prod-drain",
  "rollbackTarget": { "image": "pdpp-core:drain32", "containerName": "...-prev-<ts>" },
  "env": {
    "carriedCount": 77,
    "droppedAsImageIdentical": ["NODE_ENV", "PATH", "..."],
    "carriedOverrides": [{ "name": "PDPP_DB_PATH", "liveValue": "...", "imageValue": "..." }]
  },
  "artifactAssertions": [{ "id": "...", "pattern": "...", "expectedMin": 1, "actual": 1, "passed": true }],
  "checks": [{ "id": "...", "kind": "...", "blocking": true, "before": 8, "after": 8, "passed": true, "detail": "8 <= 8" }],
  "rolledBack": false,
  "verdict": "PASS",           // PASS | FAIL | DRY_RUN | ABORTED_ARTIFACT_MISMATCH
  "startedAt": "...", "finishedAt": "...", "dryRun": false
}
```

Every check records **both** `before` and `after`, which is what makes D14's
before/after comparison a gate rather than a narration.

## Rollback

On any blocking failure the tool stops the new container, renames it aside
(`...-prev-<ts>-failed`, so its logs survive for diagnosis), renames the
original back, and starts it. The receipt sets `"rolledBack": true`,
`"verdict": "FAIL"`, and lists each blocking failure.

The outgoing container is **renamed, never removed**, so rollback does not
depend on this tool having reconstructed the `docker run` spec correctly — if
reconstruction were the only copy of the config, a bug here would make
rollback impossible exactly when it is needed.

**The tool never removes a Docker volume.** There is no `docker volume` call
and no `down -v` anywhere in it. A prior incident destroyed 562 volumes.

It also deliberately does not use `scripts/reference-stack.sh`: that would
start a **parallel** stack rather than replacing production, which during an
incident looks like a successful deploy while the old container keeps serving.

## Tests

```sh
cd reference-implementation
node --test --import tsx test/canary-harness-manifest.test.ts
```

Covers predicate evaluation, denylist enforcement (including casing and
separator spellings), receipt-relevant redaction, rollback triggering, env
derivation against the real 97-var/25-var fixtures, and container-spec
preservation. Fixtures are taken from the live instance, so the assertions are
about real failure modes.

Mutation-checked: reverting `deriveEnv` to name-based filtering (the
catastrophic rule) fails 4 tests; disabling the OTP denylist fails 1.
