# Next and React documentation systems after the Blume spike

Status: captured. This is framework research, not a migration decision or a protocol change.

## Question

Blume's Astro spike works with PDPP's root-owned Markdown, a custom public page, and the existing React self-host command builder. Are there Next.js or React documentation systems that give PDPP a better production fit?

## What matters for PDPP

- Root `spec-*.md` files and `GOVERNANCE.md` remain canonical. A site consumes or projects them, never takes ownership.
- The public documentation and the mock-backed sandbox should become separate deployable applications.
- A custom public page and small interactive React surfaces are required. A full React application is not.
- Static deployment, readable generated HTML, search, accessible navigation, and controlled visual design matter more than a large component catalogue.
- The current Next/Fumadocs site has already accrued bridge code around source synchronisation, navigation, theme state, generated routes, and legacy skill publication. Migration has to remove that tax, not replace it with equivalent work under a new name.

## Options

| System | What it gives us | Fit for PDPP | Call |
| --- | --- | --- | --- |
| [Fumadocs](https://www.fumadocs.dev/docs/headless) | React documentation primitives, search, source adapters, Markdown tooling, and a default UI. It can run headlessly and now names Next.js, React Router, TanStack Start, Waku, and Astro with React islands as framework targets. | It already runs the current site and remains the strongest choice when the docs must share a Next runtime with genuinely live React routes. Its present cost is concrete: PDPP owns substantial Fumadocs-specific source, navigation, theme, and site-chrome code. | Keep as the no-migration option. Do not choose it again by default if the public site is mostly static documentation. |
| [Nextra](https://nextra.site/docs) | A Next.js content framework with MDX, a docs theme, app-router file conventions, search, static export, and custom themes. Nextra 4 supports only the Next app router. | Lowest conceptual jump from the current app, but it does not solve the underlying separation problem. A migration would swap one Next docs layer for another while retaining Next and rebuilding PDPP-specific integrations. | Not recommended. There is no clear capability win over Fumadocs or the working Blume spike. |
| [Docusaurus](https://docusaurus.io/docs) | Mature React static-site generator with MDX, versioning, i18n, search, plugins, theme customisation, and static HTML per route. It delivers an SPA navigation model. | Choose it when release-versioned documentation and translated documentation are first-class requirements. Those are not current PDPP needs, and its conventions would make a compact protocol site heavier than it needs to be. | Keep as the mature, versioned-docs fallback. Not the next spike. |
| [Rspress](https://rspress.rs/guide/start/introduction) | React static-site generator on Rsbuild, with MDX, full-text search, i18n, versioning, plugins, generated HTML, and a default docs theme. Theme code can override or eject built-in components. | The best pure-React challenger for a static, independently deployed documentation app. It keeps React components in docs without obliging the public site to be a Next application. It is still a fresh migration with no PDPP compatibility proof. | Worth one narrow proof only if the team wants React as the site framework after deciding against Astro. Test canonical Markdown, navigation order, legacy skill publication, and the command-builder island. |
| [Vocs](https://github.com/wevm/vocs) | A lightweight React and Vite documentation framework with Markdown and MDX. Its current project describes it as portable and Vite-powered; current releases include generated LLM Markdown hooks and OpenAPI improvements. | The most interesting small React alternative. It looks closer to Blume's restraint than Docusaurus, but has fewer demonstrated PDPP needs and less built-in breadth than Rspress. | Watch, do not spike yet. It is attractive only if the team explicitly wants a minimal Vite and React stack. |

## Current leaning

Keep Blume as the production candidate. It has earned that position with local PDPP evidence, while every React alternative above is still a paper comparison.

If Astro becomes a real constraint, run one Rspress proof before considering any broader migration. It is the only option here that changes the deployment and framework shape without merely exchanging one Next docs layer for another.

Do not migrate to Nextra. It is a lateral move. Do not lead with Docusaurus unless versioned releases or localisation become a confirmed requirement. Fumadocs remains defensible only if the public site must stay a single Next application with substantial server-rendered React work.

## Promotion trigger

Open an OpenSpec change only after a framework is selected for a multi-step public-site migration. The change must name the target app boundary, canonical content projection, URL and legacy Agent Skill compatibility, sandbox extraction, and migration acceptance checks.

## Sources

- Fumadocs, [Core introduction](https://www.fumadocs.dev/docs/headless) and [current framework overview](https://www.fumadocs.dev/).
- Nextra, [Introduction](https://nextra.site/docs).
- Docusaurus, [Introduction and feature set](https://docusaurus.io/docs).
- Rspress, [Introduction](https://rspress.rs/guide/start/introduction) and [plugin system](https://rspress.rs/plugin/system/introduction).
- Vocs, [project README](https://github.com/wevm/vocs) and [current releases](https://github.com/wevm/vocs/releases).
