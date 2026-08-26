# Public site and Blume spike scratchpad

Status: active investigation. This records deferred cleanup discovered while testing Blume; it is not a migration decision or protocol change.

## Test boundary

- Build the smallest useful Blume site inside the PDPP workspace.
- Render real root-owned specification and governance content without moving canonical sources.
- Exercise one custom public page and the interactive self-host command builder.
- Keep `/sandbox` out of the Blume app; it remains required but should become its own app.
- Delete the contributor-only `/design` and `/palette` routes after checking their blast radius.
- Do not push or replace the current public site during the spike.

## Deferred findings

### Sandbox ownership

`apps/site/src/app/sandbox/**` is a mock-backed reference application, not documentation. It currently owns 20 page modules and 15 HTTP handlers. Preserve it, then assess moving the complete surface to `apps/sandbox` after the Blume decision.

### Agent Skill source and publication

The public site currently publishes `/.well-known/skills/**`, but the content is not site-owned. Live publication reads canonical `docs/agent-skills/**`. `scripts/sync-agent-skill.ts` deliberately generates the installable `skills/pdpp-data-access/**` copy and checks byte parity; it is distribution output rather than competing ownership. Decide which deployed surface owns the stable HTTP endpoint after the public-site split. Do not treat Skills as Blume page content merely because the current Next app serves the endpoint.

Blume has a native `ai.skills` publisher, so HTTP publication does not require a Next API route. It publishes the current Agent Skills Discovery RFC shape at `/.well-known/agent-skills/**`, including deterministic archives for skills with supporting files. PDPP's current public contract is the older `/.well-known/skills/**` tree and is named inside the skills themselves. A migration should therefore:

1. point Blume `ai.skills` at canonical `docs/agent-skills` for the standard endpoint;
2. generate the legacy `/.well-known/skills/**` static tree from that same canonical directory during the build; and
3. retain the legacy tree until published consumers and in-skill URLs have migrated.

That leaves one canonical source and no application API handler. A redirect alone is insufficient because Blume archives multi-file skills while the legacy contract exposes individual reference files.

### Supporting-document ownership

The supporting documents rendered alongside the specification have mixed owners:

- Root-owned and generated into the site: `spec-architecture.md`, `spec-auth-design.md`, `spec-change-tracking.md`, `spec-connector-ecosystem.md`, `spec-data-query-api.md`, and `spec-deferred.md`.
- Site-owned: `apps/site/content/docs/reference-implementation.md`, `reference-implementation-examples.md`, and `open-questions.md`.
- Root `spec-reference-implementation-examples.md` is the illustrative source; `scripts/spec-check.ts` classifies it as the sole `REFERENCE_ONLY_ROOT_SPEC` and checks its downstream web rendering. The two files are intentional source/projection, but their names obscure that relationship.

Assess what each document still does for PDPP v1. `reference-implementation.md` currently explains implementation behaviour; `reference-implementation-examples.md` renders the root illustrative examples. Delete or archive obsolete site-only explanation only after its audience and parity owner are explicit; preserve root sources until their protocol/programme ownership is reviewed separately.

### Open and historical material

Assess `open-questions.md`, `spec-deferred.md`, and superseded `spec-data-query-api.md` after the site framework decision. They may need consolidation, archival, or deletion, but this spike does not decide their protocol-history value.

Current audit: `spec-deferred.md` is the root informative register; `open-questions.md` is a shorter maintainer-facing projection; `spec-data-query-api.md` is explicitly historical and says Core Section 8 is authoritative. This explains their intended roles but does not yet prove all three deserve a current website route.

## Decisions

- Keep the sandbox, but separate it from the public docs/marketing application.
- Delete `/design` and `/palette` from `apps/site` once their deletion blast radius is proven.
- Keep canonical root specifications and `GOVERNANCE.md` outside any site app.

## Spike result

Verdict: the compatibility blocker found by the spike is fixed against Blume `1.5.3` and proposed upstream in [Blume PR #215](https://github.com/haydenbleasel/blume/pull/215). Blume is now a credible replacement candidate; the remaining work is migration/product shaping rather than a protocol-content incompatibility.

- `pnpm check` passes with no diagnostics.
- `pnpm exec blume build --strict` passes and builds eight routes, search, LLM text artifacts, robots metadata, and agent-readability output.
- `pnpm exec blume validate --strict` now passes with no broken links.
- The proposed Blume patch supports canonical explicit Markdown heading IDs such as `{#record-model}` consistently in rendering, the table of contents, and validation. It also recognizes raw HTML element IDs such as `<a id="restart-abandonment">` as valid fragment targets. The canonical PDPP specs were not rewritten.
- The desktop documentation shell is quieter and easier to scan than the current Fumadocs surface. Mobile navigation and the compact page outline work without custom layout code.
- A real custom Astro page (`/participate`) works.
- The self-host command builder reuses `apps/site/src/lib/self-host-command.ts` as a React island and its controls update the real command correctly. Blume's code-block enhancer mutates a server-rendered `<pre>` before React hydration, causing a hydration mismatch; rendering the command in a preformatted `<div>` avoids the collision. This is small but framework-specific integration code.
- Installing the patched Blume 1.5.3 package inside the pnpm workspace works from a packed copy of the current-upstream worktree. The install reports an `@scalar/astro` peer range that does not include Astro 7, although the strict build passes.
- The protocol navigation defaults to filesystem order rather than the desired reading order; a Blume metadata file would be needed for production.
- Blume theming is token-driven rather than a set of named site themes: accent/background/action colors, light/dark mode, radius, display/body/mono fonts, local font files, `theme.css` variable overrides, Tailwind utilities, and component/layout overrides are available.
- The upstream-shaped patch passes Blume's targeted marker, normalization, rendering, and validation tests (260 tests), package typecheck, and repository formatting/lint checks. The full Blume suite passes 2,989 of 2,990 tests; the sole failure is the pre-existing Orama Japanese-tokenization case `keeps mid-number punctuation inside one term`, which is unrelated to heading or link handling.
- `blume check` and `blume build` both generate the `.blume` runtime and race if launched concurrently; running them sequentially passes. Treat these as serial workspace commands.
- Repacking the earlier local `1.4.2` tarball exposed a stale Astro content-data cache under the installed package's `node_modules/.astro`; clearing that generated cache was required before the renderer picked up the Markdown-pipeline change. The patched `1.5.3` package installed at a new package path and did not reproduce that stale-cache problem.

The next useful step is to turn the spike into a migration plan: define the production page set and navigation, apply PDPP theme tokens, wire standard plus legacy Agent Skill publication, and separate the sandbox from the public site.

## Evidence location

The disposable implementation is `apps/site-blume-spike`. `scripts/sync-canonical-content.mjs` makes the root-source boundary explicit; `pages/participate.astro` proves a custom public page; and `islands/SelfHostCommand.tsx` proves reuse of the existing command-building owner.
