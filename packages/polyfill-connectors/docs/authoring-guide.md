# PDPP Connector Authoring Guide

This is the opinionated template every connector in this package now
follows. Deviations happen — but if you're writing a new connector,
start here and don't invent structure.

## File layout

```
connectors/<name>/
├── index.ts              # Runtime entry. Calls runConnector({...}).
├── parsers.ts            # Pure functions. Imported by index.ts + tests.
├── types.ts              # Shared interfaces (record shapes, cursors).
├── schemas.ts            # Zod validators (if the stream has a schema).
├── parsers.test.ts       # node:test, table-driven, synthetic fixtures.
├── integration.test.ts   # Optional. collect()-layer invariant tests.
├── collect-helpers.ts    # Optional. Exports for integration tests
│                         # when index.ts has side effects at module load.
├── __fixtures__/         # Hand-crafted HTML/JSON. Committed.
└── scrub-rules.ts        # Optional. Connector-specific PII patterns.
```

Captured live fixtures live at `fixtures/<name>/raw/` (gitignored).
The scrubber (`bin/scrub-fixtures.ts`) produces
`fixtures/<name>/scrubbed/` (also gitignored until an LLM-based
scrubber lands — see OpenSpec `add-polyfill-connector-system/tasks.md`).

## The runConnector contract

Every connector ends with:

```ts
runConnector({
  name: "<name>",
  validateRecord,                // Zod-backed; see schemas.ts
  browser: { profileName: "<n>" }, // ← only for browser connectors
  async ensureSession({ context, page, sendInteraction }) { ... },
  async collect(ctx) { ... },
});
```

`collect(ctx)` is where business logic lives. It receives:

- `ctx.requested` — `Map<stream, StreamScope>`. Check with
  `requested.has("orders")` before doing work for that stream.
- `ctx.state` — prior cursor, merged from prior runs.
- `ctx.emit` — protocol messages (PROGRESS, SKIP_RESULT, STATE, …).
- `ctx.emitRecord(stream, data)` — emit a RECORD, shape-checked against
  the schema. Failures become SKIP_RESULT automatically.
- `ctx.progress(msg)` — non-fatal status.
- `ctx.capture` — fixture-capture handle (non-null when
  `PDPP_CAPTURE_FIXTURES=1`).
- Browser connectors also get `ctx.page` and `ctx.context`.

## Rules the tooling enforces

These are non-negotiable; Biome and lefthook fail the commit otherwise.

- **No `any`**, no `!` non-null, no `@ts-ignore`, no `as unknown as X`
  double-casts. Narrow types properly or write a declaration shim in
  `types/*.d.ts`.
- **Cognitive complexity ≤ 20** per function (Biome
  `noExcessiveCognitiveComplexity`). Decompose into named helpers;
  do NOT raise the threshold.
- **Top-level regexes** when possible. Inside `page.evaluate()`
  callbacks they must stay local (serialized to browser) — suppress
  with `// biome-ignore lint/performance/useTopLevelRegex: runs in
  browser context`.
- **Imports use explicit `.ts` extensions** for local files. We run
  `.ts` directly via `tsx`; no `.js` emission.
- **Test files** (`*.test.ts`) are held to the same bar as production
  code, except `useTopLevelRegex` and `noExcessiveCognitiveComplexity`
  are relaxed (tests often do both).

## Decomposition pattern

When `collect()` grows beyond 20 complexity:

1. Extract pure parsers to `parsers.ts`. A parser takes data, returns
   data. No `page`, no `client`, no I/O.
2. Bundle shared dependencies into a single `EmitDeps` interface:

   ```ts
   interface EmitDeps {
     capture: CaptureDep;
     emit: EmitFn;
     emitRecord: EmitRecordFn;
     emittedAt: string;
     wantsItems: boolean;
     wantsOrders: boolean;
   }
   ```

3. Decompose `collect()` into per-stream async helpers that take
   `EmitDeps` + the minimum other context they need. Gmail, amazon,
   usaa are good references.

## Test pattern

`parsers.test.ts` — table-driven, synthetic fixtures. Gate real-fixture
tests behind `existsSync`:

```ts
test("parseX: local real fixture parses ≥N records", {
  skip: !existsSync(LOCAL_RAW_DIR),
}, () => { ... });
```

`integration.test.ts` — covers `collect()` invariants consumers depend
on. Mock `emitRecord` with an array-recorder; assert emit order, scope
filtering, cursor advancement. If `index.ts` calls `runConnector` at
module scope, extract the testable helpers into `collect-helpers.ts`
to avoid importing the runtime side effects. See amazon for the full
pattern.

## Fixture capture

Set `PDPP_CAPTURE_FIXTURES=1` during a run to record DOM snapshots and
emitted records under `fixtures/<name>/raw/<iso-timestamp>/`. Scrub
them with `npx tsx bin/scrub-fixtures.ts <name>`. The default scrubber
is regex-only (emails, phones, SSNs, cards); it's insufficient for
real captures that contain addresses or merchant payloads. Until the
LLM-based scrubber lands, captured fixtures stay local-only.

## Why each of these exists

- `parsers.ts` — pure functions are cheap to test and impossible to
  regress on network/auth flakes.
- `types.ts` — shared record shapes between `parsers.ts` and
  `index.ts` without circular imports.
- `integration.test.ts` — unit tests on parsers prove record *shapes*
  are correct. Integration tests prove the *sequence* of emit calls is
  correct. Both matter.
- `collect-helpers.ts` — splits the testable subset of `collect()` out
  of the side-effectful `index.ts` so tests don't hang on stdin.
