## Context

Reddit is the first records-stream connector being enrolled as a committed
`pilot-real-shape` reference. Unlike Amazon's DOM fixture or GitHub's HTTP-JSON
fixture, the durable shape here is the connector's emitted JSONL records. The
fixture therefore needs to lock `validateRecord()` compatibility for every
declared Reddit stream without committing owner data.

## Decision

The committed Reddit pilot is synthetic-but-shape-real:

- It covers all six streams: `submitted`, `comments`, `saved`, `upvoted`,
  `downvoted`, and `hidden`.
- It uses representative record shapes and non-identifying values.
- It stays under `fixtures/reddit/scrubbed/pilot-real-shape/records/`.
- It is replayed by `connectors/reddit/pilot-fixture.test.ts` through the
  connector's live `validateRecord()`.

Real owner capture is deliberately not a prerequisite for closing this change.
If a future owner sitting is useful, that capture can calibrate the synthetic
fixture or be retained as a separately named scrubbed run after LLM-assisted
redaction review. It SHALL NOT replace `pilot-real-shape/` with real owner rows.

## Alternatives Considered

### Require a live Reddit capture before merge

Rejected. A 2026-04-30 attempt was blocked by Reddit login / Cloudflare, and the
shape-locking value does not require owner data. Blocking on a live sitting would
leave the connector without committed drift coverage while adding no construction
benefit to the schema-lock test.

### Commit a reviewed real capture under `pilot-real-shape/`

Rejected. The canonical governance spec already separates committed synthetic
shape fixtures from real owner data. Keeping `pilot-real-shape/` synthetic
preserves repo safety and makes the test oracle reviewable without privacy
context.

## Acceptance Checks

- `node --test packages/polyfill-connectors/connectors/reddit/pilot-fixture.test.ts packages/polyfill-connectors/connectors/reddit/integration.test.ts packages/polyfill-connectors/connectors/reddit/parsers.test.ts packages/polyfill-connectors/connectors/github/pilot-fixture.test.ts`
- `pnpm --dir packages/polyfill-connectors run verify`
- `pnpm exec openspec validate add-reddit-pilot-real-shape-fixture --strict`
- `pnpm exec openspec validate --all --strict`

## Residual Risk

The synthetic fixture can miss a Reddit shape variant not anticipated by the
hand-authored rows. The optional owner-live calibration packet in `tasks.md §5`
exists for that higher-fidelity check, but it is not required to close the
schema-locking pilot.
