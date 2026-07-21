# PDPP Web UI Kit

The PDPP marketing + reference site kit. Every surface here is a high-fidelity cosmetic recreation of a component shipped in `apps/web` of the `vana-com/pdpp` monorepo.

## Components

| File | Role | Source reference |
|------|------|------------------|
| `SiteHeader.jsx` | Sticky top nav with logo, section links, GitHub CTA | `components/SiteHeader.tsx` |
| `Hero.jsx` | Cross-quadrant hero with copper left rule + 3-up rail | `components/Hero.tsx` |
| `ConsentCard.jsx` | **Human** surface — user-facing grant approval | `components/pdpp/consent-card.tsx` |
| `GrantInspector.jsx` | **Protocol** surface — grant as machine-readable artifact | `components/pdpp/grant-inspector.tsx` |
| `StreamInventory.jsx` | Declared streams, shapes, modes | `components/pdpp/stream-inventory.tsx` |
| `GrantsList.jsx` | Owner dashboard — active / expiring / revoked grants | `app/design/page.tsx` |
| `Teaching.jsx` | `CodeBlock` + `FlowDiagram` — reusable teaching units | `components/pdpp/*` |

## Usage

Open `index.html`. The header nav switches between:
- **home** — landing page (Hero, ConsentCard + GrantInspector side-by-side, flow, code, enforcement rules)
- **spec** — docs-style two-column spec layout with sidebar
- **design** — reference page showing the full grants dashboard

## What this kit deliberately omits

- Font files: fonts load from Google Fonts CDN. Swap for self-hosted Geist Variable / JetBrains Mono WOFF2 if shipping offline.
- Icons: the system **doesn't use an icon set**. The one `‹svg›` in this kit is the GitHub mark in the header — everything else is typographic (`›`, `↺`, `→`, `·`, dots).
- Server logic: all interactions are client-side React state. Revoke, Grant access, and cursor navigation are cosmetic.
- Dark mode: defined in tokens, not realised anywhere in the source repo.
