---
description: description:
---

---
name: tailwind-merge-recipe
description:
  Extend tailwind-merge to recognize custom CSS variable tokens. Use when
  merging Tailwind classes with custom CSS variables or class conflicts appear.
---

# Custom Tailwind Merge Recipe for Custom CSS Variables

This guide shows how to extend `tailwind-merge` to properly handle custom CSS
variables and theme extensions in Tailwind CSS.

## Problem

When using custom CSS variables in Tailwind (via `@theme inline`), the default
`tailwind-merge` doesn't recognize these custom classes, causing class conflicts
and improper merging.

## Solution

Extend `tailwind-merge` with custom validators that match your CSS variable
patterns.

## Implementation

```typescript
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const customTwMerge = extendTailwindMerge({
  extend: {
    theme: {
      // Custom font sizes (text-*)
      text: [
        "fine",
        "pill",
        "meta",
        "small",
        "body",
        "large",
        "subheading",
        "heading",
        "title",
        "supersub",
        "super",
      ],

      // Custom colors with pattern validators
      color: [
        // Static color names
        "success",
        "card",
        "card-foreground",

        // Dynamic patterns using validators
        (value: string) => {
          const patterns = [
            /^(solid|fill|border|ring|background)-\w+$/,
            /^background-(subtle|ui|uihover|ui-active)$/,
            /^a-(solid|fill|border|background)(-\w+)?$/,
            /^g-\w+(-dark)?$/,
          ];
          return patterns.some((pattern) => pattern.test(value));
        },
      ],

      // Custom spacing (p-*, m-*, gap-*, etc.)
      spacing: [
        "inset",
        "nav",
        "header",
        "tab",
        "gap",
        "small",
        "major",
        (value: string) => /^w\d+$/.test(value), // w4, w5, w6, etc.
      ],

      // Custom border radius
      radius: ["soft", "button", "card", "squish"],

      // Custom containers (max-w-*)
      container: ["default", "stream", "text", "hero"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return customTwMerge(clsx(inputs));
}
```

## Key Patterns

1. **Static arrays**: For known, finite sets of values
2. **Validator functions**: For dynamic patterns using regex
3. **Category mapping**: Match CSS variable categories to Tailwind utilities

## CSS Variable Structure

Your CSS should follow consistent naming patterns:

```css
@theme inline {
  --text-body: clamp(12px, 10.8571px + 0.4286vw, 14px);
  --text-heading: clamp(17px, 14.1429px + 0.5714vw, 22px);

  --color-accent-solid: var(--accent-solid);
  --color-g-deals: var(--g-yellow);

  --spacing-w4: clamp(10.5px, 6.5714px + 0.7857vw, 16px);
  --spacing-major: clamp(64px, 41.1429px + 4.5714vw, 96px);
}
```

## Benefits

- Proper class merging: `cn("text-body", "text-heading")` → `"text-heading"`
- No class conflicts with custom variables
- Type-safe with proper IntelliSense support
- Maintains Tailwind's utility-first approach

## Usage

```typescript
// Before: classes might conflict
className={clsx("bg-accent-solid", someCondition && "bg-accent-solid-hover")}

// After: proper merging
className={cn("bg-accent-solid", someCondition && "bg-accent-solid-hover")}
```
