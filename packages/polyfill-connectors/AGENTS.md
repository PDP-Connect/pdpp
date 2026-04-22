# Polyfill connectors — agent rules

Rules for any agent (human or AI) touching this package. Tooling enforces
these; don't try to work around the gate.

## Quality bar

Every PR is gated on `pnpm verify`:

1. `pnpm typecheck` — TypeScript strict-plus (every load-bearing flag on)
2. `pnpm check` — Biome + Ultracite (every "no shortcut" rule at `error`)
3. Pre-commit: lefthook runs both + a grep guard against `as unknown as X`

## Non-negotiable in TypeScript files

These are Ultracite rules at `error` severity. Tooling rejects any commit
that introduces them; don't bother submitting work containing any:

- **No `any`.** Use `unknown` and narrow, or write the real type. `any`
  disables type checking — the rule name is the reason.
- **No `@ts-ignore`.** Use `@ts-expect-error` with a comment if genuinely
  needed (which is almost never).
- **No non-null assertion (`x!`).** If you know x is non-null, narrow it
  with an if-check or `??`. `!` silently becomes a runtime crash the day
  the upstream shape changes.
- **No `as unknown as X` double-cast.** If you need to bridge types, use
  a proper narrowing function or Zod parse. The grep guard catches this
  until Biome ports typescript-eslint's `consistent-type-assertions`.
- **No banned types (`Function`, `Object`, `{}`, boxed `String`/`Number`).**
  Use the lowercase primitives or a real signature.
- **No `const enum`.** Use a literal union type.
- **No `namespace`.** Use ES modules.

## Third-party response parsing (the common trap)

API responses are `unknown` — they come from the wire, the server can
change them, and type-assertions mask drift. The discipline:

```ts
// WRONG — hides drift, crashes at runtime
const data = await res.json() as OrderResponse;

// WRONG — hides drift differently
const data: OrderResponse = await res.json();

// RIGHT — parse at the boundary; the schema is the type
const data = orderResponseSchema.parse(await res.json());
```

`validateRecord` in each connector's `schemas.ts` is a Zod-backed parser.
Use it. New shapes get new schemas; don't add `any` just because a field
is optional-looking.

## Migration state (April 2026)

The package is mid-migration from JS to TS. Biome is scoped to `.ts`
files only; `.js` files are exempt until renamed. To migrate a file:

1. `git mv connectors/X/index.js connectors/X/index.ts`
2. `pnpm verify` — fix whatever tooling flags
3. The strict bar now applies; treat it as given

Don't mass-rename. One connector at a time, verify green, move on.

## Scope discipline

The runtime owns:
- Collection Profile protocol (START / RECORD / STATE / SKIP_RESULT / DONE)
- Browser lifecycle, tracing, fixture capture
- Counters, retryable-error classification, auth resolution

Connectors own:
- What records to produce
- How to parse them
- Stream-specific business logic (cursors, tombstones via `isTombstone`)

If you find yourself writing protocol plumbing inside a connector, stop
— either the runtime already has a seam for it, or we should add one.
"Extend the runtime rather than work around it."
