# Single-Origin Reference Composition Plan (2026-04-22)

**Status:** landed as the current local reference-hosting default, with explicit `direct` and `composed` local modes  
**Scope:** reference-hosting and control-plane composition choice; not a PDPP Core protocol change

## Why this exists

The current local reference is split across:

- `apps/web` on `:3000`
- the reference AS on `:7662`
- the reference RS on `:7663`

That split was pragmatic while the control plane was still forming, but it now
imposes avoidable incidental complexity:

- the operator mental model is split across multiple browser origins
- the owner-auth placeholder fits the hosted approval UI naturally but not the
  dashboard, because the dashboard lives elsewhere
- consent/device/operator journeys bounce between products and ports
- browser-facing URLs, verification links, and metadata can drift from the
  surface the operator actually uses

The owner target architecture for the **reference product** is therefore:

- one browser-facing reference origin
- one owner session for browser operator surfaces
- multiple explicit namespaces

This remains a **reference-hosting choice**, not a PDPP protocol law.

## Current landed shape

The landed reference now treats the hosting choice as two explicit local modes:

- `direct` — the AS and RS are consumed on their own listen ports (`:7662` / `:7663`)
- `composed` — the Next app presents one browser-facing origin (default `http://localhost:3000`) and proxies the internal AS/RS surfaces

The local control knobs are:

- `PDPP_REFERENCE_MODE=direct|composed`
- `PDPP_REFERENCE_ORIGIN=http://...` for the browser-facing origin in composed mode

Legacy `AS_PUBLIC_URL` / `RS_PUBLIC_URL` overrides still work, but the owner
recommendation is to treat `PDPP_REFERENCE_MODE` and `PDPP_REFERENCE_ORIGIN` as
the first-class local reference topology controls.

## North star

The reference product should present one browser-facing origin with explicit
namespaces:

- public protocol:
  - `/.well-known/*`
  - `/oauth/*`
  - `/v1/*`
- reference/operator:
  - `/_ref/*`
  - `/owner/*`
  - `/dashboard/*`

Shared owner session applies to:

- `/owner/*`
- `/dashboard/*`

It does **not** become part of:

- `/oauth/*`
- `/v1/*`

## What this tranche will actually do

This tranche takes the current multi-process setup and composes it into a
single browser-facing origin without pretending the internal processes must be
merged.

### 1. Keep the current internal split

Internally, the reference can still run as:

- Next.js web app (`apps/web`)
- reference AS/RS (`reference-implementation/server`)

That separation is still useful for:

- keeping public protocol and richer UI concerns distinct
- preserving the AS/RS as the forkable reference substrate
- avoiding a rushed merge of the website into the server runtime

### 2. Make the web origin the browser-facing reference origin

The web app will proxy the reference server surfaces so the operator and client
see one browser-facing origin.

The proxied browser-facing surface includes:

- `/.well-known/*`
- `/oauth/*`
- `/v1/*`
- `/_ref/*`
- `/owner/*`
- `GET /device`, `POST /device/*`
- `GET /consent`, `POST /consent/*`
- `GET /__pdpp/hosted-ui.css`
- other currently-shipped hosted approval/support routes that are still part of
  the live reference flow

The current `/device` and `/consent` routes remain for compatibility/truthful
continuity in this tranche. A later cleanup can decide whether they should be
aliased or moved under `/owner/*`.

### 3. Make the reference server advertise the browser-facing origin

The AS/RS must stop leaking internal listen ports in browser-facing metadata and
generated verification URLs.

In local/dev composition mode, the reference server should therefore publish
the browser-facing origin through the shared reference-topology layer. Today
that is driven primarily by:

- `PDPP_REFERENCE_MODE=composed`
- `PDPP_REFERENCE_ORIGIN=<browser-origin>`

so that:

- authorization-server metadata points to the proxied `/oauth/*` surface
- protected-resource metadata points to the proxied `/v1/*` surface
- device verification URIs and pending-consent authorization URLs land on the
  browser-facing origin instead of `:7662`

### 4. Gate `/dashboard` with the same owner session

When `PDPP_OWNER_PASSWORD` is unset:

- `/dashboard` stays open, matching current local-dev convenience

When `PDPP_OWNER_PASSWORD` is set:

- `/dashboard/*` requires the same owner session as `/owner/*`, `/device*`, and
  `/consent*`
- there must be **one** owner cookie/session model only
- the dashboard should send unauthenticated browsers to `/owner/login`

The login page remains the same simple reference-only password gate backed by
env (`PDPP_OWNER_PASSWORD`), not a new auth product.

### 5. Keep explicit protocol-exercise flows explicit

The dashboard still contains explicit public-flow exercises:

- owner device flow
- grant request / consent flow

Those should continue to use the real public/reference protocol routes, now via
the composed browser-facing origin.

### 6. Preserve conceptual boundaries

Single-origin composition should improve UX and implementation simplicity
without blurring what is public PDPP versus reference-only operator surface.

This tranche does **not**:

- make the single-origin shape normative for PDPP
- prohibit separate AS/RS origins
- prohibit external operator UIs
- force a single owner-auth implementation across all deployments

## Explicit non-goals

- do not rewrite the reference into one monolithic codebase
- do not make the dashboard itself part of the PDPP public protocol
- do not replace the owner-auth placeholder with a larger auth product
- do not silently widen public protocol semantics
- do not, in this tranche, solve the separate architectural issue where parts
  of the dashboard still auto-mint an owner token for `/v1/*` browsing; that
  remains a follow-up cleanup once the hosting/origin/session model is correct

## Implementation plan

1. Add a shared owner-session verifier that can be reused by both the
   reference server and the Next dashboard runtime.
2. Proxy the browser-facing reference routes through the web origin.
3. Ensure local/dev startup sets the reference server public URLs to the web
   origin while still listening internally on `:7662/:7663`.
4. Gate `/dashboard/*` with the shared owner session when placeholder auth is
   enabled.
5. Rewrite dashboard links and hosted-flow affordances to use same-origin
   browser paths instead of direct `:7662/:7663` URLs.
6. Validate end to end:
   - metadata and generated verification URLs point at the browser origin
   - `/owner/login` and `/dashboard/*` share the same owner session
   - owner device flow and consent flow still complete successfully
   - public `/v1/*` and `/oauth/*` remain ungated as protocol surfaces

## Owner recommendation

Implement this now as **single-origin composition**, not as a rushed codebase
merge.

That means:

- keep Next and the reference server as internal processes
- present one browser-facing origin
- share one owner session across `/owner/*` and `/dashboard/*`
- preserve explicit protocol/reference-only namespace boundaries

If this lands cleanly, it becomes the new reference-hosting default and the
medium-term north star for the control plane.
