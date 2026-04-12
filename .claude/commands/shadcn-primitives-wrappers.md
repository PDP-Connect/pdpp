---
description: Establish a two-layer UI model (primitives vs product wrappers) for ShadCN components. Use when importing or modifying ShadCN components, deciding whether to adapt primitives or create wrappers, or when aligning typography/tokens with the design system.
---

---
name: shadcn-primitives-wrappers
description: Establish a two-layer UI model (primitives vs product wrappers) for ShadCN components. Use when importing or modifying ShadCN components, deciding whether to adapt primitives or create wrappers, or when aligning typography/tokens with the design system.
---

# ShadCN Primitives + Product Wrappers

## Intent

Keep ShadCN primitives stable and token-normalized in `src/components/ui`, and express product typography/semantics in wrappers in `src/components/typography` or `src/components/elements`.

## Touch vs wrap

Touch the primitive when:

- It uses non-system tokens (`text-sm`, `rounded-md`, `gap-4`, default ShadCN colors).
- It is reused widely and needs consistent defaults.
- Fixing it once prevents repeated call-site overrides.

Wrap the primitive when:

- You need semantic intent (eyebrow, label, badge copy, product defaults).
- Typography should be driven by `Text` or `textVariants`.
- The component is a composed pattern (Badge + Text, Button + Icon + Label).

## Workflow

1. Import the ShadCN component into `src/components/ui`.
2. Normalize tokens using `tailwind-shadcn-adaptation` (typography/spacing/radius) and class sorting.
3. Keep primitives agnostic: layout, shape, state, interaction only. No product semantics.
4. Add a wrapper in `src/components/typography` or `src/components/elements`:
   - Compose the primitive with `Text` or `textVariants`.
   - Use `asChild`/Slot patterns to avoid coupling.
   - Provide opinionated defaults for product usage.

## Cross-skill handoff

- If you're adapting a new primitive, read `tailwind-shadcn-adaptation` first.
- If you see repeated typography overrides in call sites, create a wrapper here.

## Anti-patterns

- Adding typography intent props to `ui` primitives.
- Fixing typography in multiple call sites instead of a wrapper.
- Mixing product semantics into `src/components/ui`.

## Example

- `Badge` normalized once in `src/components/ui/badge.tsx`.
- `EyebrowBadge` in `src/components/typography` composes `Badge` + `Text intent="eyebrow"`.
