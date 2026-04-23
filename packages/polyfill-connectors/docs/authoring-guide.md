# PDPP Connector Authoring Guide

This is the opinionated template every connector in this package now
follows. Deviations happen — but if you're writing a new connector,
start here and don't invent structure.

## File layout

```
connectors/<name>/
├── index.ts              # Runtime entry. runConnector({...}) guarded by isMainModule.
├── parsers.ts            # Pure functions. Imported by index.ts + tests.
├── types.ts              # Shared interfaces (record shapes, cursors).
├── schemas.ts            # Zod validators (if the stream has a schema).
├── parsers.test.ts       # node:test, table-driven, synthetic fixtures.
├── integration.test.ts   # Optional. collect()-layer invariant tests.
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

## Protocol conventions

These are not auto-enforced but ARE enforced by code review + pinned
by `integration.test.ts` in every connector with parent-child record
streams.

### Parent-first emit order

When a connector emits streams that relate to each other (orders +
order_items, accounts + transactions, sessions + messages,
conversations + messages, threads + messages) the **parent record
emits before any of its children**. Downstream consumers doing
streaming upserts rely on this for referential integrity.

Concretely:
- `emitOrderAndItems` in amazon emits `orders` before `order_items`.
- `processConversationDetail` in chatgpt emits `conversations` before
  `messages`.
- `runAllMailPasses` in gmail emits `threads` before `messages`.
- `scanProjectDirs` in claude_code uses a two-pass structure:
  scan-for-accumulators → emit `sessions` → scan-for-messages.

When the parent is an aggregate built by observing children (gmail
threads, claude_code sessions), use one of:
- A self-contained fetch that enumerates the parent independently
  (gmail's `runThreadsPass` fetches `1:*` with `threadId` + `envelope`
  and aggregates in-memory without reading the message bodies the
  per-message pass needs).
- A two-pass buildOnly/emit split (claude_code's `buildOnly: true`
  flag threads through `processJsonlLine` to suppress emits while
  still updating the accumulator).

Integration tests MUST assert parent-index < first-child-index in the
emit sequence. See `connectors/chatgpt/integration.test.ts` for the
pattern.

### `isMainModule` guard for `runConnector`

Every connector's `index.ts` guards its bootstrap:

```ts
import { isMainModule } from "../../src/is-main-module.ts";

if (isMainModule(import.meta.url)) {
  runConnector({ ... });
}
```

This lets tests import `index.ts` without the runtime kicking in and
blocking the event loop on stdin. CLI execution
(`tsx connectors/<name>/index.ts`) still works — that's what
`isMainModule` returns true for.

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
on. Mock `emitRecord` with `makeRecordingEmit(validateRecord)` from
`src/test-harness.ts` so records land through the real zod shape-check;
assert emit order, scope filtering, cursor advancement. Import the
testable helpers directly from `./index.ts` — the `isMainModule` guard
on `runConnector({...})` keeps the runtime from firing at import time.
See amazon for the full pattern.

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
- `isMainModule` guard on `runConnector({...})` in `index.ts` — lets
  tests import `index.ts` directly. Without it, the runtime would fire
  at import time and block the test runner's event loop waiting for
  the stdin protocol handshake.
