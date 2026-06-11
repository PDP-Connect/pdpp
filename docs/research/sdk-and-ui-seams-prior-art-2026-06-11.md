# PDPP SDK and UI Seams — Prior Art and Recommendation

**Date:** 2026-06-11  
**Author:** Research agent  
**Status:** Recommendation — not yet implemented

---

## Part A: Current Fragmentation in PDPP

### How many distinct RS clients exist today

The repo has **five distinct runtime HTTP client implementations** that talk to the Resource Server (RS) or Authorization Server (AS). None of them is the same module — they each hand-roll their own `fetch` wrapper, auth header injection, URL construction, error handling, and pagination.

| # | File | Name | Auth mechanism | Surface | Language | Typed |
|---|------|------|---------------|---------|----------|-------|
| 1 | `packages/mcp-server/src/rs-client.js` | `RsClient` | Bearer token (scoped grant) | `/v1/*` read surface | JS | No |
| 2 | `apps/console/src/app/dashboard/lib/ref-client.ts` | `refFetch` | Owner session cookie | `/_ref/*` control-plane (40 exported functions, 1855 lines) | TS | Yes (hand-written) |
| 3 | `apps/console/src/app/dashboard/lib/rs-client.ts` | `authedFetch` | Owner bearer token | `/v1/*` read surface for the dashboard | TS | Yes (hand-written) |
| 4 | `packages/cli/src/read/commands.js` | `fetchReadJson` | Bearer token (`PDPP_TOKEN` env) | `/v1/streams`, `/v1/schema`, `/v1/search`, `/v1/aggregate` | JS | No |
| 5 | `packages/polyfill-connectors/src/orchestrator.ts` | `asFetch` + `ownerLoginCookie` | Owner session cookie | AS endpoints (`/owner/login`, `/device/approve`, `/oauth/device_authorization`) | TS | No |
| 6 | `packages/polyfill-connectors/src/local-device-client.ts` | `LocalDeviceClient#fetch` | Injected device-scoped fetch | `/_ref/device-exporters/*` RS device surface | TS | No |

Client 6 (`LocalDeviceClient`) uses injected fetch — it's the closest thing to the right pattern — but it only covers the device surface, not the general `/v1/*` read surface.

There is also a **types-only** module (`packages/operator-ui/src/lib/rs-client.ts`, 188 lines) with no runtime code; it declares shared response shapes but does not itself make any HTTP calls.

### Where the divergence bites

- **Error handling**: `RsClient` (MCP) defines custom typed error classes with `.code` fields. `authedFetch` (console rs-client) throws plain `ReferenceServerUnreachableError` / `ResourceServerHttpError`. CLI's `fetchReadJson` throws a generic `PdppUsageError`. No shared error hierarchy.
- **URL construction**: `RsClient` has a proper `buildUrl` method. The console clients use `new URL(...)` inline. The CLI uses a `buildUrl` helper function but reimplements the same logic.
- **Pagination**: The console's `rs-client.ts` has a full `paginateSampleRecords` loop. The CLI manually handles `cursor`. The MCP `rs-client.js` does not handle pagination at all (left to the tool layer).
- **Types**: The console has ~3000 lines of hand-maintained TypeScript interfaces across `ref-client.ts` and `rs-client.ts` that must be kept in sync manually whenever RS response shapes change.
- **Transport injection**: Only `RsClient` (MCP) and `LocalDeviceClient` support injecting a custom `fetch` implementation — a prerequisite for isomorphic use and unit testing. The others hard-code `globalThis.fetch`.
- **Owner vs. bearer surface**: The console's `ref-client.ts` (owner session cookie, `/_ref/*`) and `rs-client.ts` (owner bearer token, `/v1/*`) are already two separate clients for what conceptually should be unified: the owner's view of the system. An alternative UI author would need to replicate both.

The 42 non-test source files that contain raw `fetch(` calls confirm the problem is not confined to a few files. The RS surface is accessed from scripts, smoke tests, console page components, and operator-UI components, each pasting in the same URL-construction-plus-auth-header pattern.

---

## Part B: Prior-Art Synthesis

### B1. Isomorphic, typed SDK design

**Stripe (`stripe-node`)**

Source: `src/RequestSender.ts`, `src/net/FetchHttpClient.ts`, `src/stripe.core.ts` in [https://github.com/stripe/stripe-node](https://github.com/stripe/stripe-node)

Stripe's SDK is the gold standard for typed, isomorphic Node/browser client design. Its key structural choices:

- **`HttpClient` interface** (`src/net/HttpClient.ts`): a thin abstract base class defining `makeRequest`. In Node environments, the default is a `NodeHttpClient` backed by the built-in `http` module. In browser environments, a `FetchHttpClient` backed by `globalThis.fetch` is provided. Callers can inject any conforming implementation at constructor time: `new Stripe(key, { httpClient: myClient })`. This is the cleanest form of transport injection — the SDK itself never imports `node:http` unconditionally; the runtime variant is selected at the entry point.
- **Error hierarchy**: A single `StripeError` base class; subtypes (`StripeAPIError`, `StripeConnectionError`, `StripeInvalidRequestError`, etc.) carry `.code`, `.statusCode`, `.type`, `.param` fields. Every error the SDK can throw is a known, typed descendant of `StripeError`.
- **Auto-pagination**: List endpoints return a result object with `.autoPagingEach(fn)` and `[Symbol.asyncIterator]()` methods, so callers can `for await (const item of stripe.customers.list())` transparently across page boundaries.
- **Types**: Stripe's public TypeScript types track the API spec but are **hand-maintained** (as of 2026, Stripe keeps types for the latest API version only). They are published as a separate `@stripe/stripe-js` for the browser surface.

**Supabase (`supabase-js`)**

Source: [https://supabase.com/docs/reference/javascript/introduction](https://supabase.com/docs/reference/javascript/introduction)

`supabase-js` is explicitly "isomorphic JavaScript library" working in browser and Node. It uses `globalThis.fetch` uniformly (available in both since Node 18), injecting a custom fetch at construction time for environments that need it (e.g., SvelteKit passes its enhanced `fetch` in server load functions). This is the simpler, modern approach: instead of a `HttpClient` interface hierarchy, just accept a `fetch` function as a constructor option and default to `globalThis.fetch`. This is exactly the approach `packages/mcp-server/src/rs-client.js` already follows (`fetch = globalThis.fetch` in the constructor).

**openapi-fetch**

Source: [https://openapi-ts.dev/openapi-fetch/](https://openapi-ts.dev/openapi-fetch/), [https://openapi-ts.dev/openapi-fetch/api](https://openapi-ts.dev/openapi-fetch/api)

`openapi-fetch` is 6 kB, zero-runtime, works in browser and Node. It wraps `globalThis.fetch` but accepts a custom `fetch` option in `createClient({ baseUrl, fetch: myFetch })`. Middleware provides the auth-injection hook:

```ts
const client = createClient<paths>({ baseUrl: "https://myapi.dev/v1/" });
client.use({
  async onRequest({ request }) {
    request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
});
```

The middleware model separates auth from transport cleanly, is composable (multiple middleware stack), and sidesteps the question of where the token comes from — the middleware closure captures it from whatever scope owns the credential.

**Plaid (`plaid-node`)**

Source: [https://raw.githubusercontent.com/plaid/plaid-node/master/README.md](https://raw.githubusercontent.com/plaid/plaid-node/master/README.md)

Plaid's SDK is auto-generated from OpenAPI using `openapi-generator`. The `Configuration` object accepts `baseOptions` (headers/agents) for auth. The SDK is primarily Node-targeted (uses `axios` under the hood), and is not meaningfully isomorphic. Plaid's approach illustrates what to avoid: generated axios-based clients are hard to use in browser or edge environments, carry large runtime bundles, and make mocking in tests awkward.

**Key takeaway for PDPP**: The modern consensus is:
1. Accept an injectable `fetch` (defaulting to `globalThis.fetch`) — this is sufficient for isomorphism in 2026.
2. Layer auth via middleware or a closure, not hardcoded.
3. Provide typed error classes with structural `.code` fields.
4. Provide auto-pagination iterators for list endpoints.

### B2. Schema → Types generation

**The core problem for PDPP**: The RS advertises its streams, fields, filter operators, expand relations, and pagination flags through `GET /v1/schema` — a custom capability document, not an OpenAPI spec. To get the type-generation benefits of the openapi ecosystem, PDPP must bridge this gap.

Three options and their tradeoffs:

**Option 1: Emit OpenAPI from the RS, then use openapi-typescript**

`openapi-typescript` ([https://openapi-ts.dev/introduction](https://openapi-ts.dev/introduction), [https://openapi-ts.dev/cli](https://openapi-ts.dev/cli)) generates TypeScript type-only `.d.ts` files from any OpenAPI 3.0/3.1 spec. It supports fetching the spec from a live URL:

```bash
npx openapi-typescript https://pdpp.example/v1/openapi.json -o ./src/types/pdpp.d.ts
```

Combined with `openapi-fetch` (`createClient<paths>(...)`), this gives fully typed request/response shapes with zero runtime overhead and zero hand-maintenance.

**Tradeoff**: The RS must emit a valid OpenAPI spec. The current `/v1/schema` document is a capability document, not OpenAPI. A parallel `/v1/openapi.json` endpoint would need to be added to the RS, translating capability doc shapes into OpenAPI path/component definitions. This is non-trivial for dynamic schemas (schemas that vary per connection/connector), but the RS already has `GET /v1/schema?stream=<name>` scoped queries — a static OpenAPI doc covering the envelope shapes plus per-stream query params is achievable. The dynamic field types (per-connector `field_capabilities`) would need to be expressed as `additionalProperties` or generic maps.

**Option 2: Bespoke generator off `/v1/schema`**

A generator script runs at build time (or in a `postinstall`-style step), fetches `/v1/schema`, and emits TypeScript interfaces for each stream's record shape, query parameters, and filter operators. The output is a `.d.ts` file checked into the repo (or generated on demand).

This is what the owner described doing for the vana-sdk analog: "types for wrapped upstream APIs generated dynamically." The benefit is exact fidelity to the PDPP capability doc — no OpenAPI translation loss. The cost is building and maintaining the generator itself.

**Tradeoff**: More upfront work (write the generator), but the result is more precisely typed for PDPP's model (stream-scoped filter operators, expand capabilities, connection_id disambiguation, etc. are first-class in the generated types). The generator can be a small script that fetches `/v1/schema?detail=full` and emits TypeScript. This is the approach used by Supabase for its database type generation (`supabase gen types`) — a thin CLI that introspects the live database and emits `types/supabase.ts`.

**Option 3: Zod schema-first**

Define Zod schemas that describe the RS response shapes, then derive TypeScript types from those schemas via `z.infer<typeof MySchema>`. Runtime validation on responses becomes a first-class capability — every response the SDK receives is validated against the schema, and type errors surface at runtime rather than silently producing unexpected shapes.

**Tradeoff**: Zod adds ~60 kB to the bundle (Zod v4 is smaller), and runtime validation adds latency on every response parse. The schemas must still be kept in sync with the live RS manually, or generated from `/v1/schema` (which turns this into a variation of Option 2). Zod is most valuable when you need runtime validation (e.g., untrusted responses in a browser context, or when the RS server version may lag the client). For internal SDK use where both ends are controlled, the overhead may not be justified.

**Recommended approach**: Option 2 (bespoke generator), with a path to Option 1 later. Build a generator that fetches `/v1/schema?detail=full` and emits `.d.ts` stream types. This is one small script (100–200 lines), directly produces the exact types PDPP needs, and keeps the toolchain simple. If the RS later needs to expose a public API for third-party integrations, add the OpenAPI endpoint as a parallel surface and optionally switch the generator output format.

### B3. SDK-driven-UI patterns — "dogfood the SDK" discipline

The pattern used by companies that have successfully eliminated private fetch paths:

**Structural enforcement via package boundaries**: The SDK lives in a package (`@pdpp/sdk`) that exports only the public surface. The console, CLI, and MCP server all depend on `@pdpp/sdk` — they cannot import implementation files from the RS package or from each other's lib/ directories. This is enforced by the monorepo package structure itself (pnpm workspace imports respect package boundaries), not by a lint rule.

**Lint rules as the second line of defense**: For teams that want belt-and-suspenders enforcement, ESLint's `no-restricted-imports` rule can ban any import whose path contains `/_ref/` or direct fetches to the RS host. Example: `"no-restricted-imports": ["error", { "patterns": ["*/lib/ref-client", "*/lib/rs-client", "getOwnerToken"] }]`. This catches drift early in CI.

**No-private-fetch architectural test**: A lightweight test can grep all non-SDK source files for `fetch(` and assert the only occurrences are inside `@pdpp/sdk`. This is equivalent to the `check-owner-journey-acceptance.mjs` script in PDPP's own `scripts/` directory — but for the RS access boundary rather than the UX journey.

**The "dogfood" discipline from Stripe**: Stripe's internal dashboard uses `stripe-node` exclusively — the same SDK external developers use. This means bugs in the SDK are found by Stripe themselves. The discipline is enforced by making internal tooling a regular SDK consumer. For PDPP, the console becoming a pure SDK consumer means any SDK regression immediately breaks the official UI, creating a strong incentive to keep the SDK correct.

**Type-safety as the mechanical enforcer**: When the SDK's typed return types (`StreamRecord`, `SearchResultPage`, `SchemaDocument`, etc.) are generated from the live schema, any response shape change in the RS that isn't reflected in the SDK becomes a TypeScript error in any downstream consumer. This is the most powerful form of enforcement: it doesn't rely on developer discipline.

---

## Part C: Recommendation — Three Concrete SDK Architecture Options

### Option R1: Thin transport wrapper + bespoke type generator (recommended)

**Architecture**: A new `@pdpp/sdk` package containing:

1. **`PdppClient` class** — mirrors `RsClient` in `packages/mcp-server/src/rs-client.js` but promoted to a first-class SDK package with full TypeScript support. Constructor: `new PdppClient({ baseUrl, accessToken, fetch? })`. Defaults `fetch` to `globalThis.fetch`. No Node-specific imports — truly isomorphic. Supports middleware for auth, logging, and retry.

2. **Generated types** — a `codegen/` script that fetches `GET /v1/schema?detail=full` at build time and emits `src/generated/schema.d.ts`. The CLI `pnpm run codegen` in the SDK package regenerates types whenever the schema changes. Types cover: per-stream record shapes (from `field_capabilities`), query parameters, filter operators, expand relations, pagination envelopes.

3. **Typed methods** — `client.schema()`, `client.records(stream, params)`, `client.fetch(id)`, `client.search(q, params)`, `client.aggregate(stream, params)` — each typed against the generated schema. Return types are the generated interfaces.

4. **Pagination helper** — `client.recordsIterator(stream, params)` returns an async iterator that transparently handles `has_more` / `next_cursor`. Callers use `for await (const record of client.recordsIterator('transactions'))`.

5. **Error hierarchy** — `PdppError` base class; subtypes: `PdppNetworkError` (fetch threw), `PdppHttpError` (non-2xx, carries `.status` and `.body`), `PdppSchemaError` (response failed validation). Identical to MCP server's existing error classes, extracted into the SDK.

**What moves**: MCP server's `RsClient` is replaced by `@pdpp/sdk`. CLI's `fetchReadJson` is replaced by `@pdpp/sdk`. Console's `rs-client.ts` (the `/v1/*` bearer surface, 1166 lines) is replaced by `@pdpp/sdk`. Console's `ref-client.ts` (the `/_ref/*` owner surface, 1855 lines) either migrates to the SDK under a separate `OwnerClient` class or remains as-is initially (see below).

**Owner surface question**: The `/_ref/*` routes are a control-plane/owner-only surface. An SDK can reasonably offer two client classes: `PdppReadClient` (scoped bearer, `/v1/*`, usable in browser) and `PdppOwnerClient` (owner credential, `/_ref/*`, server-only). The UI's `ref-client.ts` becomes `PdppOwnerClient`. This preserves the security boundary while unifying the implementation.

**Tradeoffs**:
- Build a type generator (one-time cost ~2 days). 
- Requires migrating 3 existing clients to the SDK (each is a search-replace plus type-checking pass). 
- Generated types cover the `/v1/*` surface well but the `/_ref/*` surface must still be hand-typed (that surface is not advertised in `/v1/schema`). 
- This is the most direct path to the owner's north star: "build a complete alternative UI just using the SDK."

### Option R2: openapi-typescript + openapi-fetch (ecosystem-standard)

**Architecture**: Add `GET /v1/openapi.json` to the RS that emits an OpenAPI 3.1 document for the entire `/v1/*` surface (record envelopes, query params, error shapes). Then:

1. Run `npx openapi-typescript https://pdpp.example/v1/openapi.json -o packages/sdk/src/generated/pdpp.d.ts` in CI.
2. Wrap with `openapi-fetch`: `const client = createClient<paths>({ baseUrl, fetch })`.
3. Add a bearer-token middleware: `client.use(bearerMiddleware(token))`.
4. Publish as `@pdpp/sdk`.

**Tradeoffs**:
- Leverages a well-maintained, battle-tested ecosystem (openapi-typescript is used by Vercel, OpenCode, PayPal per hey-api docs; openapi-fetch is 6 kB).
- The generated types are structural path-keyed objects (`paths["/v1/streams/{stream}/records"]["get"]["parameters"]`) which are ergonomic in `openapi-fetch` but verbose in hand-written code.
- The RS must emit a stable OpenAPI document. Dynamic per-connector field schemas need to be represented generically (`additionalProperties: true` on the `data` property of `StreamRecord`), reducing type precision for the payload fields.
- The `/_ref/*` owner surface needs a separate approach (it's control-plane, not in `/v1/`).
- This approach is easiest to explain to external SDK consumers and most familiar to developers coming from Stripe/Plaid.

### Option R3: Zod schema-first with runtime validation (most safety, largest bundle)

**Architecture**: Define the entire SDK surface as Zod schemas. Use the `/v1/schema` generator to produce Zod schemas (not just TS types) for stream records. Every response is validated at runtime before being returned to the caller.

```ts
const RecordSchema = z.object({ id: z.string(), stream: z.string(), data: z.record(z.unknown()), ... });
const RecordsPageSchema = z.object({ data: z.array(RecordSchema), has_more: z.boolean(), ... });
```

**Tradeoffs**:
- Eliminates an entire class of bugs: RS response regressions are caught at the SDK boundary rather than propagating silently.
- Adds ~60 kB (Zod v4 is smaller, ~15 kB minified+gzipped) — acceptable for server-side use, borderline for browser bundles.
- Zod schema definitions are more verbose than TypeScript interfaces; generated Zod schemas from a custom doc are harder to write than generated TS interfaces.
- Overkill for the browser read surface (bearer-scoped reads from a controlled RS); better suited for the owner control-plane surface where mutation errors matter more.
- A middle path: use Zod only for request parameter validation (not response parsing), keeping the type generation simple while still catching bad inputs at the SDK boundary.

---

## Part D: What to Dispatch Next

### Immediate (no code)

1. **Decide the scope boundary**: Is the SDK `/v1/*` only (read surface, scoped bearer), or does it also cover `/_ref/*` (owner control-plane, session cookie)? The two surfaces have different auth models, different intended consumers (AI agents vs. the dashboard), and different stability guarantees. The answer shapes the package structure.

2. **Decide on Option R1 vs R2**: R1 (bespoke generator, thin wrapper) is lower ecosystem dependency and more precisely typed for PDPP's custom schema. R2 (openapi-fetch ecosystem) is more familiar to external developers and lower maintenance if the RS OpenAPI doc is kept accurate. Both require similar migration effort on the consumer side.

### First engineering task (1–2 days)

3. **Promote `RsClient` to `@pdpp/sdk`**: The existing `packages/mcp-server/src/rs-client.js` is already the correct shape (transport injection, bearer auth, typed error classes, `getJson`/`postJson`/`buildUrl`). Move it to a new `packages/sdk/src/client.ts`, rewrite in TypeScript, add middleware support, and have `packages/mcp-server` import from `@pdpp/sdk` instead. This zero-risk refactor unblocks the rest and proves the package boundary works.

4. **Write the type generator** (if R1): A `packages/sdk/scripts/codegen.ts` (~150 lines) that fetches `GET /v1/schema?detail=full` and emits TypeScript interfaces for each stream. Add to `package.json` scripts as `"codegen": "tsx scripts/codegen.ts"`. Check generated output into `src/generated/schema.d.ts`.

### Migration sequence (1–2 sprints per client)

5. Migrate CLI (`fetchReadJson` → `@pdpp/sdk`). Low risk; the CLI already uses bearer tokens and has a small surface.
6. Migrate console `rs-client.ts` (`authedFetch` + `/v1/*` functions → `@pdpp/sdk`). Medium risk; 1166 lines but most are data types and helper functions that can coexist during transition.
7. Migrate console `ref-client.ts` (`/_ref/*` owner surface → `PdppOwnerClient` in `@pdpp/sdk` or a separate `@pdpp/owner-sdk`). High surface area (1855 lines, 40 exported functions), but mostly mechanical — each function is a typed wrapper around one `/_ref/` endpoint.

### Enforcement

8. After CLI and console are migrated, add a `no-restricted-imports` ESLint rule in the monorepo that bans `getOwnerToken`, `refFetch`, `authedFetch`, and `fetchReadJson` imports outside the SDK package itself. Add a `scripts/check-sdk-boundary.mjs` test (analogous to `check-owner-journey-acceptance.mjs`) that greps for raw `fetch(` calls to the RS host outside `packages/sdk`.

---

## Key Sources

- Stripe transport injection: https://raw.githubusercontent.com/stripe/stripe-node/master/src/RequestSender.ts and `src/net/FetchHttpClient.ts`
- Stripe README (auto-pagination, error model): https://raw.githubusercontent.com/stripe/stripe-node/master/README.md
- openapi-fetch (isomorphic, middleware auth): https://openapi-ts.dev/openapi-fetch/ and https://openapi-ts.dev/openapi-fetch/middleware-auth
- openapi-typescript (CLI, generate from remote URL): https://openapi-ts.dev/introduction
- hey-api openapi-ts (Zod + TanStack Query generation): https://github.com/hey-api/openapi-ts
- openapi-zod-client (Zod schema generation from OpenAPI): https://github.com/astahmer/openapi-zod-client
- Plaid node (OpenAPI-generated SDK, Configuration pattern): https://raw.githubusercontent.com/plaid/plaid-node/master/README.md
- Supabase (isomorphic JS, generate types from live schema): https://supabase.com/docs/reference/javascript/introduction

---

## Summary

**Fragmentation count**: 5 distinct runtime HTTP client implementations hit the RS/AS today (MCP `RsClient`, console `refFetch`, console `authedFetch`, CLI `fetchReadJson`, polyfill-connectors `asFetch`/`LocalDeviceClient`). 42 non-test source files contain raw `fetch(` calls.

**Recommended architecture (3 sentences)**: Create a `@pdpp/sdk` package that promotes the existing `RsClient` from `packages/mcp-server/src/rs-client.js` to a first-class TypeScript package with injectable `fetch`, middleware-based auth, and typed error hierarchy — the transport pattern is already correct, it just needs to graduate to a shared package. Pair it with a bespoke codegen script that fetches `GET /v1/schema?detail=full` and emits `.d.ts` stream types, so types are generated dynamically from the live schema rather than hand-maintained across 3000 lines of duplicated interfaces. Enforce the boundary by having the CLI, MCP server, and console all depend exclusively on `@pdpp/sdk`, then add a lint rule and a repo-check script that fails CI on any raw `fetch(` call to the RS outside the SDK package.
