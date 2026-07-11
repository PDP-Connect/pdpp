---
name: pdpp-design
description: Use this skill to generate well-branded interfaces and assets for PDPP (the Personal Data Portability Protocol), either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

# PDPP design skill

Read `README.md` at the root of this skill. It contains the full visual foundations, content fundamentals, and iconography rules.

Other files you should know about:
- `colors_and_type.css` — CSS variables for colors, type, motion, layout; semantic `.pdpp-*` type classes. Copy-paste into any new HTML.
- `assets/` — `logo-mark.svg` (the 20×20 blue "P" square), `wordmark.svg`.
- `ui_kits/web/` — the reference site. Components: `SiteHeader`, `Hero`, `ConsentCard` (human temperature), `GrantInspector` (protocol temperature), `StreamInventory`, `GrantsList`, `Teaching` (CodeBlock, FlowDiagram). `kit.css` adds component classes (`pdpp-btn`, `pdpp-badge`, `pdpp-surface-*`). Open `index.html` to see them composed.
- `preview/` — individual specimen cards used in the Design System tab.

## Using this skill

If creating visual artifacts (slides, mocks, throwaway prototypes): link `colors_and_type.css` and `ui_kits/web/kit.css`, copy assets out, produce static HTML for the user to view.

If working on production code: read the rules in `README.md`, mirror token names (`--primary`, `--human`, `--foreground`, etc.), and match the temperature system — every emphasis surface picks either **human** (copper left rule) or **protocol** (blue left rule), never both.

## Core rules to never break

1. **Two temperatures, never mixed.** Human = copper (`--human`). Protocol = blue (`--primary`). Neutral = plain border. Pick one per surface.
2. **No icon set.** Use typographic arrows (`›`, `↺`, `→`, `·`), status dots, and mono labels. If you're reaching for Lucide, stop and try a word or a chip.
3. **Sentence case everywhere.** Uppercase only for mono eyebrow labels and section IDs (`CONSENT`, `GRANT`, `§3.1`).
4. **Technical-quiet voice.** Short declarative sentences. Third person. No hype, no emoji, no exclamation marks. "The grant is the artifact." not "Grants are amazing!".
5. **Mono for identifiers.** Any `client_id`, `purpose_code`, grant ID, or field name renders in `var(--font-mono)`. Lowercase-with-underscores.
6. **Elevation = border, not shadow.** Cards get a 2px colored left border as their primary emphasis signal; shadows are a whisper.

## If the user invokes this skill with no other guidance

Ask what they want to build — a spec page, a consent flow, a dashboard, a doc article. Ask 3–5 clarifying questions (audience? human-facing vs developer-facing? needs data-flow diagram? how many surfaces?). Then output HTML artifacts or production code depending on the need.
