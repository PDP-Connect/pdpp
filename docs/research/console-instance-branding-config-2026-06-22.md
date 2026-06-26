# Console instance branding — configuration design note (2026-06-22)

Decision note for: restore the PDPP logo, replace the visible "Recordroom" wordmark with the instance brand name, and make BOTH configurable per instance. Scope here = the **configuration mechanism** (decided below). Implementation of the swap is dispatched separately (Sonnet).

## Current state (surveyed)
- The visible "Recordroom" wordmark renders in **exactly 3 places** in `packages/pdpp-brand-react/src/shell-frame.tsx`: sidebar `rr-side__name` (~L252), header `rr-head__brand` (~L266), mobile drawer (~L302). The other ~258 "Recordroom" occurrences are the **`RecordroomShell` component name + its imports** — code identifiers, NOT user-visible; they are OUT OF SCOPE (renaming a component across ~250 files is churn with no user benefit).
- The "logo" is currently a **CSS-only placeholder mark** (`<span className="rr-side__mark" aria-hidden="true" />`, ~L112 — "a sheet casting its carbon"). The real PDPP logo assets ALREADY EXIST and are unused by the shell: `apps/console/public/brand/pdpp-mark.svg`, `pdpp-mark-dark.svg`, `pdpp-favicon.svg`.
- `RecordroomShell` already takes props with defaults: `host = "this server"`, `build = "pdpp 0.1.0"`. `host` is sourced server-side in `apps/console/src/app/dashboard/page.tsx:149` via `getReferencePublicOrigin()`. So there is an established **server-resolves-value → passes-as-prop** pattern to extend.
- Existing server config is **env-var, `PDPP_*` namespace** (PDPP_AS_URL, PDPP_RS_URL, PDPP_REFERENCE_ORIGIN, PDPP_OWNER_PASSWORD, PDPP_ENABLE_DASHBOARD, …). No existing provider-display-name concept.

## DECISION: env var, `PDPP_*` namespace, server-resolved, prop-plumbed, default "PDPP"

**Mechanism:** a single env var `PDPP_INSTANCE_NAME` (string), read server-side, defaulting to **"PDPP"** when unset/empty. Resolved in the same server layer that resolves `host` (the dashboard page / a shared server helper), passed into `RecordroomShell` as a new `brandName` prop. This matches the repo's existing 12-factor `PDPP_*` env pattern and the shell's existing host/build prop-plumbing — no new config system, no new abstraction.

Rationale for env (not a config file): every other instance-level knob here is already env (`PDPP_*`), it is the 12-factor default for deploy-time identity, and it requires zero new file-loading/parse/validation surface. A config file would be a new mechanism for a single string + an optional asset path — not justified.

### Brand name
- New env: `PDPP_INSTANCE_NAME` → default `"PDPP"`.
- New `RecordroomShell` prop: `brandName?: string` (default `"PDPP"`), rendered in the 3 wordmark spots (`rr-side__name`, `rr-head__brand`, drawer) instead of the literal "Recordroom".
- Resolve once server-side (a `getInstanceBrand()` helper alongside `getReferencePublicOrigin()`), pass down. Pages that currently hardcode `build="pdpp 0.1.0"` keep build; only the wordmark changes.

### Logo
- Default: render `apps/console/public/brand/pdpp-mark.svg` (+ `pdpp-mark-dark.svg` for dark theme via the existing theme mechanism; `pdpp-favicon.svg` for the favicon) in place of the CSS `rr-side__mark` placeholder. "Restore the logo" = wire the existing asset, not author a new one.
- **`PDPP_INSTANCE_LOGO_URL` override — DEFERRED (NOT in this batch).** A configurable logo override (a `PDPP_INSTANCE_LOGO_URL` string URL/path that, when set, swaps the bundled PDPP mark; when unset, falls back to `pdpp-mark.svg`, with `alt`/`aria-label` driven by `brandName`) was scoped here as optional+additive. It is **explicitly deferred** to a fast follow. The shipped batch covers brand-name config (`PDPP_INSTANCE_NAME`, route-global via context) + restoring the real PDPP mark inline; the per-instance logo URL is the lower-value bit and is not implemented now. The bundled PDPP mark is always rendered until that follow-up lands.

### Defaults & invariants
- Unset env → "PDPP" + bundled PDPP mark (so an un-configured instance looks like canonical PDPP, never "Recordroom" and never a broken/placeholder mark).
- Empty string env → treat as unset (use default), don't render an empty wordmark.
- The mark must keep an accessible name (`aria-label`/`alt` = brandName); the current placeholder is `aria-hidden` — restoring a real logo means giving it an accessible name.
- Do NOT rename the `RecordroomShell` component or its file/imports — internal identifier, out of scope.

## Out of scope / deferred
- **`PDPP_INSTANCE_LOGO_URL` (per-instance logo override) — DEFERRED** (see the Logo section). Not in this batch; the bundled PDPP mark is always rendered.
- Renaming the `RecordroomShell` component symbol (churn, no user value).
- Per-instance theme/color tokens (separate concern; this note is name + logo only).
- The `build="pdpp 0.1.0"` crumb (version string, separate from brand identity).

## Route-global delivery (Part B — implemented)
The brand name must be **route-global**, not homepage-only. There are ~47 `RecordroomShellWithPalette` mounts across `/dashboard/**`; only `/dashboard/page.tsx` passed `brandName` explicitly, so every other route would render the hardcoded "PDPP" default even when `PDPP_INSTANCE_NAME` is configured. Mechanism (no per-site edits, no server-env in a client component):
- `dashboard/layout.tsx` (server component wrapping every dashboard route) resolves `getInstanceBrand()` ONCE and wraps `{children}` in a new `BrandProvider` (`apps/console/src/app/dashboard/components/brand-provider.tsx`) with the already-resolved string.
- `RecordroomShellWithPalette` (client) reads the brand via `useBrandName()` context and resolves `prop ?? context ?? "PDPP"`, so an explicit prop still overrides and all ~47 mounts inherit the configured brand with zero per-site edits.
- `getInstanceBrand` stays in the server-only `owner-token.ts` module; the client reads only the resolved string from context (never imports the `process.env` helper).

## Acceptance
- `PDPP_INSTANCE_NAME=Acme` → sidebar/header/drawer show "Acme"; unset → "PDPP".
- The real PDPP logo (pdpp-mark.svg) renders in the sidebar (and favicon) by default, dark-theme variant in dark mode, with an accessible name.
- No "Recordroom" text visible anywhere in the console UI; component identifiers unchanged.
- Gate: tsc clean, console tests green, lint clean. (Implementation dispatched to Sonnet.)
