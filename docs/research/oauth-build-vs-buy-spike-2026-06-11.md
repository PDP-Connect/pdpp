# OAuth Build-vs-Buy Spike — `auth.js` vs `node-oidc-provider`

**Date:** 2026-06-11
**Author:** Architecture spike (report-only)
**Status:** DECISION MEMO — owner decides; no migration performed
**Scope:** `reference-implementation/server/auth.js` (6,368 LOC) and the OAuth route layer
**Verdict:** **PARTIAL / mostly KEEP — do NOT migrate the grant + consent core. Confidence: HIGH.**
The recommendation that survives the evidence is **(c)-leaning-(b)**: decompose `auth.js`
internally first (extract manifest-validation, isolate the commodity OAuth plumbing behind
a seam); only *consider* outsourcing the narrow commodity slice later, and even then the
case is weak for a **reference** implementation. Full migration is rejected.

---

## 0. TL;DR for the owner

- The opening question — *"are we managing complexity we shouldn't own?"* — has a precise answer:
  **~14% of `auth.js` is complexity you shouldn't own** (the ~878 LOC of connector-manifest
  validation that doesn't belong in an auth file at all). That is an **extraction**, not a
  buy. The OAuth itself is **~33% commodity / ~50% essential-PDPP-grant**, and the commodity
  third is *entangled with* and *small relative to* the essential core.
- A real spike (mounted `oidc-provider@9.8.4`, drove a PDPP-shaped RAR through its own hooks)
  **proves the grant model is *expressible*** through its Rich Authorization Requests +
  custom-consent extension points — but the one PDPP primitive that *defines the product*
  (atomic **`single_use`** consume-once) **has no library equivalent and must stay
  first-party regardless of what you do with the rest.**
- The freshest commodity churn (CIMD / loopback DCR) **landed yesterday and today**
  (2026-06-09 / 2026-06-10). It is **not stable enough to outsource now** — you would be
  freezing a moving surface into a library boundary.
- For a **reference** implementation specifically, "inspectable" beats "outsourced." A black-box
  Koa-based OIDC framework actively *harms* the artifact's purpose (an engineer forks PDPP to
  *read* the protocol). This is the deciding qualitative factor, and it points to KEEP.

---

## 1. The boundary, measured (Q1)

`auth.js` = **6,368 lines, 196 top-level functions**. Programmatic classification of every
function by line-span (`tmp/spike-oidc-provider/` analysis; method: regex-extract defs →
span-to-next-def LOC → name-based domain classification, then manual reassignment of the
50 ambiguous functions). Routes are *not* in `auth.js`; it is the service layer behind
`server/routes/as-oauth.ts` (310 L), `as-dcr.ts` (221 L), `as-authorize.ts` (706 L),
`as-grant-revoke.ts` (192 L), `as-consent-ui-helpers.ts` (1,539 L).

| Class | LOC | % | What it is | Library implements it? |
|---|---|---|---|---|
| **Essential PDPP grant semantics** | ~3,177 | **50%** | grant object, `authorization_details` RAR (35 refs), `access_mode` single_use/continuous, `purpose_code`/`ai_training` consent, batch consent + per-source narrowing, grant_contract versioning, source/storage binding | **No** — novel core |
| **Commodity OAuth** | ~2,091 | **33%** | DCR/CIMD, device flow (RFC 8628), token issuance/refresh/introspection (RFC 7662), redirect/loopback inference, PKCE | Mostly yes |
| **Manifest-validation** | ~878 | **14%** | stream/field-schema, cursor/blobref/aggregate validators, runtime + refresh-policy capability checks | N/A — doesn't belong here (LANE C4) |
| **Util / infra** | ~184 | **3%** | id/time/`pgOne`/`pgExec`, JSON, trace context | N/A — neutral |

### Key boundary functions (line-anchored)

**Commodity (library-replaceable) — the outsourcing candidate set:**
- DCR / client metadata: `normalizeClientRegistrationMetadata@379`, `validateAuthorizationCodeRedirectUris@361`, `inferApplicationTypeFromRedirectUris@357`, `isLoopbackHttpRedirectUri@352`, `registerDynamicClient@2108`, `resolveOAuthClient@3013`
- CIMD (the fresh churn): `createCimdDocument@1683`, `getCimdDocument@1702`, `listCimdDocuments@1727`, `deleteCimdDocument@1754`, `bindDynamicClientToApprovingOwner@1811`
- Device flow: `initiateOwnerDeviceAuthorization@5563`, `markOwnerDeviceAuth*@1456–1512`, `exchangeOwnerDeviceCode@~5780`
- Token / introspection: `issueToken@5907`, `issueOwnerToken@6094`, `introspect@6102`, `exchangeOAuthAuthorizationCode@5264`, `exchangeOAuthRefreshToken@5368`, `hashOAuthRefreshToken@47`, `base64UrlSha256@4034` (PKCE)

**Essential PDPP grant (the core no library has):**
- RAR validation: `normalizeAuthorizationDetail@542` (validates `type:"https://pdpp.org/data-access"`, `source:{kind,id}`, `streams[]`, `access_mode`, `purpose_code`)
- Grant lifecycle: `requireGrantContractAgainstManifest@1099`, grant issuance `@3890–3950` (immutable versioned object), `revokeGrant@6267`, `revokeGrantPackage@5008`
- Consent core: `evaluateBatchApproveAllGate@3286`, `narrowResolvedSelectionForSource@3344` (129 L — per-source owner narrowing), `summarizeBatchCumulativeRisk@3256`, the `ai_training` affirmative gate `@3898–3907`
- Binding: `getRequestSourceBinding@730`, `normalizeStorageBinding@1042`, `describeSourceBinding@1019` (connection routing — PDPP-specific)

### Is the commodity churn stable enough to outsource *now*? **No.**

`git log` on `auth.js` shows the commodity surface is the **freshest-moving** code in the file:

| Commit | Date | Surface |
|---|---|---|
| `e3aa2e17` Seed DCR URI fields from AS_PUBLIC_URL | **2026-06-10** | DCR |
| `4048039d` harden CIMD consent identity | **2026-06-09** | CIMD |
| `7ad82d9e` add CIMD client identities | **2026-06-09** | CIMD/DCR |
| `96ff2002` Cover IPv6 loopback redirect inference | 2026-06-08 | DCR loopback |
| `02406c29` Infer native clients from loopback redirects | 2026-06-08 | DCR loopback |

The CIMD/loopback/DCR work is **days old and still shipping**. Drawing a library boundary
through code this hot means freezing in-flight design decisions into an external contract —
exactly when you have the *least* certainty about the final shape. Outsourcing is a thing
you do to a **settled** commodity, not a hardening one. Revisit this question in a quarter,
not this week.

---

## 2. The drop-in evaluated: `node-oidc-provider` (panva) (Q2)

**Version:** `oidc-provider@9.8.4` (latest; installed and run in the spike).
**Sources:** README API docs (`raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md`,
fetched 2026-06-11), npm page (`npmjs.com/package/oidc-provider`, 9.8.4), repo home — all
indexed; URLs + fetch date on disk per the research rule.

### RFC 9396 RAR support — YES, but experimental

- `features.richAuthorizationRequests` exists with a `validate(ctx, value, client)` hook and
  `rarForAuthorizationCode` / `rarForCodeResponse` / `rarForBackchannelResponse` transformers.
- **It is an *experimental* feature.** The spike captured the live notice: it requires
  `ack: 'experimental-01'`, and the docs state plainly: *"Breaking changes between experimental
  feature updates may occur and these will be published as MINOR semver oidc-provider updates."*
  For a **reference implementation that must be stable and spec-faithful**, riding an
  experimental feature whose breaking changes hide in minor bumps is a material liability.

### Extension points — present and adequate

- **`extraParams`** — register extra authorization-request params into `ctx.oidc.params`; usable
  for PDPP-specific request fields.
- **Custom interaction/consent** — `interactions.url(ctx, interaction)` redirects to your own
  consent UI; you build a `Grant`, call `Grant.prototype.save()`, and return `{ consent: { grantId } }`.
  `loadExistingGrant` lets you bypass the library's default OIDC scope-consent checks
  (`rs_scopes_missing`, etc.) for first-party flows — necessary because PDPP's consent has nothing
  to do with OIDC scopes.
- **Adapter interface** — clean per-model storage abstraction; `Provider.ctx` via `AsyncLocalStorage`
  gives request context inside the adapter. PDPP's SQLite/Postgres stores would back it.
- **`features.resourceIndicators`** (RFC 8707) — present; note its `getResourceServerInfo` helper
  ships as a placeholder you MUST replace.

### Mounting cost — real but bounded

PDPP is Fastify/Express. `oidc-provider` is **Koa-native**. The docs *do* document a Fastify
mount, but it is **not free**: `fastify.use('/oidc', provider.callback())` requires
`@fastify/middie` or `@fastify/express` to bridge Connect/Express-style middleware into Fastify.
You inherit a Koa request lifecycle running inside your Fastify app — two middleware models in
one process. Also: the spike emitted `WARNING: Unsupported runtime. Use Node.js v22.x LTS` —
the library pins an LTS engine; PDPP runs newer.

### THE FEASIBILITY SPIKE (throwaway — `tmp/spike-oidc-provider/`)

Mounted `oidc-provider@9.8.4` with `features.richAuthorizationRequests`, a PDPP RAR validator,
a custom consent interaction, and drove this PDPP-shaped `authorization_details` through the
library's own hooks:

```json
[{ "type": "https://pdpp.org/data-access",
   "source": { "kind": "connector", "id": "chase" },
   "streams": [{ "name": "transactions", "fields": ["amount","date","merchant"] }],
   "access_mode": "single_use",
   "purpose_code": "https://pdpp.org/purpose/ai_training" }]
```

**Empirical results (run output captured):**

| Probe | Result |
|---|---|
| **A. RAR custom type round-trips** | **PASS** — `validate` hook invoked; `https://pdpp.org/data-access` accepted. Natural home for `normalizeAuthorizationDetail`. |
| **B. Custom fields survive** | **PASS** — `streams[].fields`, `access_mode`, `purpose_code` all survive into the grant. RAR is genuinely free-form. |
| **C. `single_use` consume-once** | **FAIL (decisive)** — `single_use` is **opaque data to the library**. `oidc-provider` has **no atomic single-use token primitive**. Consume-once MUST be enforced by PDPP at the introspection/RS layer no matter what. |
| **D. `ai_training` consent gate** | **PASS (with caveat)** — enforceable in our custom interaction handler; library neither blocks nor fights it. *We* own the gate either way. |

**`Grant.prototype.addRar` EXISTS** (confirmed via prototype introspection — alongside
`addOIDCScope`, `addResourceScope`, `save`, etc.). So the library's own Grant model can
*carry* PDPP's RAR. **Expressibility is proven.** The grant model does **not** fundamentally
fight `oidc-provider` — it rides the RAR surface cleanly.

**But expressibility is not the same as fit.** Three frictions the spike surfaced:
1. The library is **OIDC-first**: it forces dev signing keys / `jwks`, `devInteractions`, and
   OIDC scope/claims consent machinery that PDPP **does not use**. You spend effort *disabling*
   the library's defaults to reach PDPP's model.
2. **Introspection is deeply PDPP-custom.** `introspect@6102` returns `grant_json`,
   `grant_package_id`, `trace_id`, `scenario_id`, `storage_binding_json`,
   `inactive_reason: grant_revoked|grant_expired|token_revoked`, across **three token kinds**
   (`client` / `mcp_package` / owner). RFC 7662 in envelope only — the *body* is a PDPP grant
   projection. Replacing it means re-deriving every custom field through the library's hooks,
   fighting its shape.
3. The product-defining behavior (`single_use` atomic consumption) is **outside the library's
   model entirely** — proven by probe C.

---

## 3. The counter-argument: inspectable reference vs outsourced commodity (Q3)

This is a **reference implementation** — its job is to let an engineer fork it and *understand
the protocol by reading it*. That changes the build-vs-buy calculus from the usual SaaS-backend
default:

- **For a product backend**, "outsource the commodity OAuth, own your differentiator" is almost
  always right — you don't want to maintain RFC 8628/7591/7662 plumbing.
- **For a reference**, the commodity plumbing **is part of what you're demonstrating.** An
  engineer reading `auth.js` to learn how device flow binds to a PDPP grant gets a single,
  greppable, dependency-light file. Replace that with `oidc-provider` and the reader now has to
  learn Koa, the library's interaction-policy DSL, its Grant model, its adapter contract, and
  which experimental flags are on — *before* they can see how PDPP's grant works. **A framework
  black-box raises the cost of the artifact's primary use case.**
- The entanglement cuts the same way. Because the commodity third is **interleaved with** the
  essential half (device-code → grant issuance → introspection all thread the PDPP grant object),
  a library boundary doesn't cleanly sever "commodity" from "essential" — it runs a seam
  *through* the grant lifecycle, putting half of each flow on each side of an FFI-like boundary.

**Honest tension, not foregone:** the pull toward `oidc-provider` is real — 33% is a lot of
RFC plumbing to hand-maintain, and the library is OpenID-certified and well-run by a serious
maintainer. If PDPP were a *product* AS, this memo would lean (b) partial-migrate. But for a
**reference**, inspectability wins, and the commodity surface is *currently in motion* (Section 1),
so even the "stable commodity" precondition for outsourcing isn't met yet.

---

## 4. Verdict, migration shape, sequencing (Q4)

### Verdict: **(c) decompose internally now; (b) partial-outsource is a *future option*, not now; (a) full-migrate REJECTED. Confidence HIGH.**

**Decisive single finding:** the grant model is *expressible* in `oidc-provider` (RAR + `addRar`
+ custom consent — proven), but the product's defining primitive (`single_use` atomic
consume-once) and the entire custom introspection contract **have no library equivalent and stay
first-party regardless** — so a migration buys you the *cheap* third (RFC plumbing) at the cost
of (i) a Koa-in-Fastify mount, (ii) an experimental RAR flag whose breaks hide in minor bumps,
(iii) re-deriving the custom introspection body through library hooks, and (iv) degrading the
reference's inspectability — while the *expensive, valuable* half stays exactly where it is.

### What stays first-party REGARDLESS of any decision
- `single_use` atomic consumption (no library primitive — probe C)
- The grant object shape, `grant_contract` versioning, grant-vs-package model
- `authorization_details` PDPP type validation + per-source consent narrowing + cumulative risk
- The `ai_training` affirmative-consent gate and the three authorship classes
- The custom introspection contract (`grant_json`, `trace_id`, `inactive_reason`, three token kinds)
- Source/storage binding (connection routing)

### Recommended sequencing (internal decomposition — the actual work to do)
1. **LANE C4 first — extract manifest-validation (~878 LOC).** Pure mechanical move of the ~23
   validators (`auth.js` ~L211–2905) into `server/connector-manifest.ts`; make
   `isReferenceCompatibleCursorSchema@181` the single source of truth imported by both `auth.js`
   and `records.js` (kills the documented sync hazard). **No behavior change.** This is the
   "complexity you shouldn't own" *in this file* — and it requires zero new dependency.
   Risk: low. Effort: M (the 6,368-line file makes mechanical extraction fiddly).
2. **Isolate the commodity OAuth behind an internal seam.** Group the ~2,091 LOC of
   DCR/CIMD/device/token/introspection behind a thin module boundary (`server/oauth-plumbing.*`)
   *without* changing behavior. This (a) makes the commodity/essential boundary explicit and
   greppable, (b) gives you a clean injection seam *if* you later decide to swap in a library,
   and (c) makes the next reader's job easier. This is the "keep optionality cheap" move.
3. **Pin the normative grant behaviors with tests BEFORE touching anything heavier.** The audit
   flagged the grant MUSTs as under-proven; the prior B-1 verdict said the same. Lock
   `single_use` consumption, three-class consent, and the introspection contract with explicit
   tests so any future refactor has a tripwire.
4. **Only after (1)-(3): re-open the partial-outsource question** — and only if the CIMD/DCR
   surface has settled. Even then, weigh it against the reference-inspectability cost in §3.

### Migration cost IF you ever go partial-(b) (for the owner's calculus)
- **LOC moved:** ~2,091 commodity LOC leave `auth.js`; ~3,177 essential + ~878 manifest stay.
- **Test-suite safety net:** **3,447 total reference-impl test cases**, with **~74** concentrated
  in the auth/OAuth/consent conformance suites (`consent-device-auth-conformance*`,
  `oauth-error-contract`, `dcr*`, `cimd`, `security-consent*`, `security-device-code*`,
  `hosted-mcp-oauth`). Strong net — but note it currently pins the *PDPP* contract (custom
  introspection body, error envelopes), which a library would **change**, so a real migration
  rewrites a chunk of these tests rather than reusing them as-is. That re-pinning is itself a
  material cost and a regression-risk surface.
- **New runtime risks:** Koa-in-Fastify (`@fastify/middie`), Node LTS engine pin, experimental
  RAR flag with minor-version breakage, library upgrade treadmill.
- **What you'd gain:** stop hand-maintaining RFC 8628/7591/7662/7636 plumbing (~33% of the file).

---

## Appendix — artifacts & provenance

- **Throwaway spike (marked, committed for reproducibility):** `tmp/spike-oidc-provider/spike.mjs`
  + `package.json` (`oidc-provider@9.8.4`). Run: `node spike.mjs`. **DO NOT SHIP — feasibility
  probe only.**
- **Boundary classification method:** programmatic def-extraction over `auth.js`, span-to-LOC,
  name-based domain bucketing + manual reassignment of 50 ambiguous functions (see §1).
- **Web sources (indexed 2026-06-11):** `node-oidc-provider` README API docs
  (`raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md`), npm 9.8.4
  (`npmjs.com/package/oidc-provider`), repo home (`github.com/panva/node-oidc-provider`).
  RAR ack string `experimental-01` and the "breaking changes ship as MINOR semver" warning were
  captured **live from the running library**, not just docs.
- **Relates to:** Program Audit Wave 2 finding **B-1** (prior verdict: "spike-worthy now, but
  scoped — do NOT full-migrate") and **LANE C4** (manifest-validation extraction). This memo
  confirms and *sharpens* B-1 with an executed feasibility spike.
