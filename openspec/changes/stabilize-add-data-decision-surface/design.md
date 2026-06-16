# Design

## Target

The Add data page should answer one question quickly: "What can I add now, and what is the next real step?" It should not be a catalog encyclopedia, connector roadmap, or nested import management page.

This follows the owner-console execution plan: sources/connection is the dominant object, and setup details belong one click after the owner expresses intent.

## Live Evidence

Captured on 2026-06-16 against `https://pdpp.vivid.fish/dashboard/records/add`:

- `tmp/workstreams/add-data-live-audit-v1.json`
- `tmp/workstreams/add-data-live-desktop-v1.png`
- `tmp/workstreams/add-data-live-mobile-v1.png`

Findings:

- The page renders "Why this, and what to expect" 10 times on the default page.
- The first fold is a stack of near-identical cards, each with "Recommended next" even when the choice is obvious.
- Google Maps Timeline and WhatsApp expand into nested acquisition paths, source-reuse rows, and external help links inside the main picker.
- A "Requires server setup" section appears as another card group in the decision flow instead of a concise prerequisite summary.

The earlier false-action bug is mostly gone; this tranche addresses the next layer: scanability and intent-first disclosure.

## Owner-Facing Model

Default Add data row:

- Source name.
- Short method line, such as "Local collector", "Provider credential", or "File import".
- Support fact, such as "Add now", "Add account", "Import file", or "Server setup required".
- One real primary action if the owner can start now.

Collapsed or secondary detail:

- Rationale/guidance.
- Acquisition-method instructions.
- Existing-source reuse choices.
- External source instructions.
- Server prerequisite detail.

Unavailable sources:

- Hidden from the default list.
- Searchable or behind a collapsed secondary section.
- No primary setup button.

Server-prerequisite sources:

- Not mixed into the add-now list as full setup cards.
- Summarized in a concise secondary callout with the destination to deployment readiness.

## Tradeoffs

- Keeping all acquisition instructions inline makes the page self-contained but breaks comparability and forces every owner to read detail they did not ask for. This is the current failure.
- Hiding all non-add-now sources risks making the connector universe feel smaller. The compromise is default-hidden but searchable/secondary unavailable entries.
- Existing-source reuse matters for artifact imports, especially WhatsApp, but the add-source picker is the wrong place to make the owner manage individual prior imports. The import destination can offer the exact existing-source decision after the owner chooses that connector.

## Acceptance Checks

- The default `/dashboard/records/add` page has no repeated "Why this" disclosure.
- The default available-source rows are comparable in height and structure.
- Google Maps Timeline and WhatsApp do not blast acquisition instructions and existing-source management inline in the default list.
- Server-prerequisite sources are summarized outside the primary add-now group.
- Unavailable sources remain hidden/collapsed by default and cannot render a primary setup button.
- Live headed proof captures desktop/mobile screenshots, console errors, failed network requests, suspicious copy, and action inventory.
