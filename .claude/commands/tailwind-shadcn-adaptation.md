---
description: description:
---

---
name: tailwind-shadcn-adaptation
description:
  Adapt ShadCN primitives to design-system tokens. Use when importing or
  normalizing ShadCN components in a UI primitives directory and before creating
  product wrappers.
---

# ShadCN Component Adaptation

When importing a ShadCN component into a UI components directory (for example
`src/components/ui/` or `packages/ui/src/components/`), apply
these transformations to align with the design system.

## Source of Truth

- **Token recognition**: `*/lib/classes.ts` — the `customTwMerge`
  config defines what tailwind-merge recognizes
- **Token definitions**: `*/styles/vars.css` + `*/styles/index.css` — CSS custom
  properties and `@theme` aliases for text, radius, spacing
- **Sorting rule**: `.cursor/rules/tailwind-sort.mdc` — apply to any element
  with >5 classes

### Repo notes (DataConnect)

- Token recognition: `src/lib/classes.ts`
- Tokens + `@theme` aliases: `src/styles/vars.css`, `src/styles/index.css`
- `classes.ts` currently registers `inset` as a custom spacing token; add any
  additional `inset*` tokens there before use.

## Why This Matters

Tailwind's built-in `text-sm`, `text-lg`, `text-xl` have **hardcoded
line-heights** that don't match our design system. Our semantic tokens
(`text-small`, `text-large`, `text-xlarge`) include proper `--line-height` and
`--letter-spacing` definitions in vars.css. We also alias the Tailwind sizes to
these semantic tokens in `@theme`, but prefer the semantic names for clarity.

## Token Mapping (ShadCN → Design System)

### Typography

| ShadCN      | Design System                                |
| ----------- | -------------------------------------------- |
| `text-xs`   | `text-fine`                                  |
| `text-sm`   | `text-small`                                 |
| `text-base` | `text-body` or `text-button` (app-dependent) |
| `text-lg`   | `text-large`                                 |
| `text-xl`   | `text-xlarge`                                |
| `text-2xl`  | `text-heading`                               |
| `text-3xl`  | `text-subtitle`                              |
| `text-4xl`  | `text-title`                                 |

See `vars.css` and `index.css` for actual values and associated line-heights/letter-spacing.

### Spacing (the -4 rule)

Replace Tailwind's `-4` spacing with `-inset` for consistent internal component
spacing.

| ShadCN Pattern                                        | Design System                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `p-4`, `px-4`, `py-4`, `pt-4`, `pb-4`, `pl-4`, `pr-4` | `p-inset`, `px-inset`, `py-inset`, `pt-inset`, `pb-inset`, `pl-inset`, `pr-inset` |
| `m-4`, `mx-4`, `my-4`, `mt-4`, `mb-4`, `ml-4`, `mr-4` | `m-inset`, `mx-inset`, `my-inset`, `mt-inset`, `mb-inset`, `ml-inset`, `mr-inset` |
| `gap-4`                                               | `gap-inset`                                                                       |
| `space-x-4`, `space-y-4`                              | `space-x-inset`, `space-y-inset`                                                  |

Other spacing tokens must be registered in `classes.ts` before use.

### Border Radius

| ShadCN       | Design System    |
| ------------ | ---------------- |
| `rounded-sm` | `rounded-button` |
| `rounded-md` | `rounded-card`   |
| `rounded-lg` | `rounded-squish` |
| `rounded-xl` | `rounded-dialog` |

Also available: `rounded-soft`. See `vars.css` for values.

## Processing Steps

1. **Sort classes** per the sorting rule (only if >5 classes on an element)
2. **Apply typography mappings** — prefer semantic `text-*` tokens; treat
   Tailwind aliases (`text-sm`, `text-lg`, `text-xl`) as legacy
3. **Apply spacing mappings** — replace `-4` with `-inset`
4. **Apply radius mappings** — use semantic radius tokens
5. **Verify tokens exist** in `classes.ts` — if you need a new token, add it
   there first
6. **If repeated typography overrides appear in call sites**, create a wrapper
   per `shadcn-primitives-wrappers`

## Example Transformation

### Before (raw ShadCN)

```tsx
<div className="flex items-center gap-4 rounded-md p-4 text-sm font-medium transition-colors hover:bg-accent">
```

### After (design system)

```tsx
<div
  className={cn(
    // layout
    "flex items-center gap-inset",
    // shape
    "rounded-card p-inset",
    // typography
    "text-small font-medium",
    // hover
    "hover:bg-accent",
    // transitions
    "transition-colors"
  )}
>
```

## Checklist

Before committing a ShadCN component adaptation:

- [ ] Prefer `text-small`, `text-large`, `text-xlarge` over Tailwind aliases
- [ ] No `-4` spacing — use `-inset` variants
- [ ] No `rounded-sm`, `rounded-md`, `rounded-lg` — use semantic radius tokens
- [ ] Classes sorted and commented (if >5 classes)
- [ ] Any new tokens added to `classes.ts`
- [ ] Wrapper created when product semantics are needed
