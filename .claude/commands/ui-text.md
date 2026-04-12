---
description: Use when Codex needs to migrate UI copy to the shared Text component and align typography sizing with the semantic intent system (for example login-page style cleanup, component refactors, and preventing ad-hoc text utility drift).
---

---
name: ui-text
description: Use when Codex needs to migrate UI copy to the shared Text component and align typography sizing with the semantic intent system (for example login-page style cleanup, component refactors, and preventing ad-hoc text utility drift).
---

# UI Text System

Use this skill when editing components that render user-facing text and currently rely on ad-hoc `text-*` utilities or inconsistent sizing classes.

## Core principle

Use semantic `Text` intents first, utility classes second.

- Keep semantic HTML (`h1`, `p`, `a`, `button`) and place typography in `Text` props.
- Prefer intent-driven styling over literal `text-*` size utilities.
- In this repo, `intent` already carries size, line-height, and letter-spacing. Pick the right intent before adding `weight` or tracking classes.
- Prefer parent-owned vertical rhythm. Hoist repeated sibling spacing to a wrapper with `space-y-*` instead of sprinkling `mb-*` and `mt-*` across individual text nodes.
- Defaults should be strong, but design wins. The system is there to produce good defaults, not to block deliberate visual decisions from the designer.
- The user is the designer. If the implemented component and the written guidance disagree, treat the design direction as the source of truth and update the guidance to match.

## Guardrails

These rules exist because the default failure mode is ad-hoc drift.

- Start strict. Use the system defaults first and only add exceptions when the composition actually needs them.
- Treat literal `text-*`, `tracking-*`, and scattered `mt-*`/`mb-*` as suspect until proven necessary.
- Keep overrides local. If a component needs an exception, make the exception obvious in that component instead of weakening the whole system.
- If you find yourself repeating the same exception across multiple components, stop and consider whether the base token or component API should improve instead.
- Do not “split the difference” against clear design direction. When the designer has made a call, implement that call cleanly.

## Required import

Import `Text` from `@/components/typography/text`.

## Mapping size utilities to semantic intents

Use this mapping when a component currently uses Tailwind aliases:

- `text-xs` -> `intent="fine"`
- `text-sm` -> `intent="small"`
- `text-md` -> `intent="body"`
- `text-lg` -> `intent="large"`
- `text-xl` -> `intent="xlarge"`
- `text-2xl` -> `intent="heading"`
- `text-3xl` -> `intent="subtitle"`
- `text-4xl` -> `intent="title"`
- `text-5xl` -> `intent="display"`
- `text-6xl` (and 7xl–9xl) -> `intent="hero"`

This mapping is based on `src/styles/index.css`.

## Using `withIcon`

Use `withIcon` on `Text` for icon + label rows (logo + title, inline symbol + copy).

What `withIcon` owns by default:

- Layout and gap for the row.
- Default icon sizing that scales with the chosen text intent.
- Shared color when the icon uses `currentColor`.

What to render:

- Pass the icon component as a plain child with no `className` when the defaults are correct, for example `<OdlLogo />`.
- Set `color` on `Text`, not with `text-*` classes on the icon, for the normal case.
- Only add icon classes for deliberate exceptions like an explicit size override or a one-off alignment fix.

If you combine `withIcon` with `truncate`, prefer the built-in `Text` behavior over hand-rolled flex + ellipsis wrappers.

## Buttons

`withIcon` applies to **`Text`**, not to every row that happens to pair an icon with words.

- **`Button` + icon + label**: Keep the **button** (or `Button`) as the interactive surface. Put the Lucide icon and the label string as **direct children** of the button. Do **not** wrap that row in `Text` with `withIcon` for “correctness”—the control component owns layout and type scale for its contents.
- **Button width**: `Button` in `button-base` is already **`inline-flex`** with **`shrink-0`**. Do **not** add or remove **`w-fit`** unless the design or task explicitly calls for it.

## Icons

- **No redundant icon sizing inside buttons or `Text`**: When a Lucide icon sits **inside** `Button` or **`Text`**, do **not** add `className` with `size-*` (or ad-hoc `size-3.5`, etc.) unless the design explicitly calls for an exception. Parents already size SVG children (for example, `Button` applies default icon sizing via its styles—see `src/components/ui/button-base.tsx`). Adding pixel or arbitrary `size-*` classes on the icon fights that system.

## Lucide imports

- **Lucide imports**: Prefer Lucide’s **`*Icon` named exports** from `lucide-react` (e.g. `CopyIcon`, `RotateCcwIcon`, `ExternalLinkIcon`). Use the names the package exports; do not rename imports for style.

## Spacing

General spacing principles:

- Use parent-owned rhythm first. Reach for `space-y-*` on the wrapper before `mt-*` and `mb-*` on individual children.
- Use repo spacing tokens first. Prefer semantic utilities like `space-y-gap`, `space-y-small`, `space-y-minor`, `space-y-submajor`, `space-y-major`, and `space-y-super` over numeric spacing.
- Keep one spacing owner per cluster. A heading, supporting copy, and action group should usually have one parent wrapper controlling vertical rhythm.
- Keep typography and spacing separate. Let `Text` own type; let wrappers own layout.
- Use margins as exceptions, not structure. `mt-*` and `mb-*` are for one-off optical adjustments when the default stack rhythm is not enough.
- Match the spacing token to the semantic unit. Tight copy stacks want smaller tokens; section breaks want larger ones.
- Stay internally consistent. Avoid mixing token stacks, numeric `space-y-*`, and one-off margins in the same small component unless there is a clear visual reason.
- Defaults are strong, but design wins. If the design needs an exception, make it intentionally.

## Exceptions

Exceptions are allowed. They should still be deliberate.

- It is okay to override `weight`, icon size, color classes, or spacing when the default system does not produce the intended result.
- Prefer one clear override over a pile of small compensating utilities.
- When breaking the default pattern, preserve semantics and keep the visual reason legible in the code.
- Engineer convenience is not, by itself, a good reason to bypass the system. Visual correctness is.

## Migration workflow

1. Identify text nodes and intended meaning first, not pixel target.
2. Replace direct text tags with `<Text as="...">` where needed.
3. Convert visual classes:
   - Size: switch from `text-*` utilities to `intent`.
   - Weight: only use `weight` when the design truly needs emphasis beyond the chosen intent. Do not preserve `font-*` classes by default.
   - Color: replace semantic colors (`text-foreground-muted`, `text-accent`, etc.) with `color` props.
   - Tracking: remove ad-hoc `tracking-*` classes unless there is a deliberate exception not covered by the type token.
4. Hoist repeated sibling spacing to parent wrappers with `space-y-*` instead of per-node `mb-*` and `mt-*`.
5. Use the repo spacing tokens first: `space-y-gap`, `space-y-small`, `space-y-minor`, `space-y-submajor`, `space-y-major`, `space-y-super`.
6. Keep spacing, layout, borders, and motion classes on container wrappers.
7. For nested anchors/buttons/labels, use `color="inherit"` in inner text when outer color carries meaning.

## Acceptance checklist

- No visible `h*`, `p`, or anchor text relies on raw `text-*` utility classes for primary sizing.
- Text semantics (`as=...`) match DOM purpose.
- Intent does the default typography work; `weight` and tracking overrides are rare and intentional.
- Color is set via `Text` props where possible.
- Vertical spacing is managed by parent stacks where practical, not scattered across individual text nodes.
- Non-typographic utilities remain on non-text containers.
- `withIcon` lockups: no redundant `shrink-0`, default `text-*` on the icon, or `size-*` unless there is an explicit design exception.
- Exceptions, when present, are clearly intentional and in service of the design rather than convenience.
