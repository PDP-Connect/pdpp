---
description: description:
---

---
name: tailwind-sort
description:
  Sort Tailwind classes for legibility. Use when a JSX element or cva has more
  than eight Tailwind classes, or when classes are extracted into a reusable constant/array.
---

# Sort Tailwind classes on a JSX element or a CVA object

## When to group

**Inline `className`:** Only group/sort when there are **8+ Tailwind class
names** on a single element. For 1-7 classes, leave them as a plain string
(`className="..."`) — do not wrap in `cn(...)` just for formatting.

**Extracted constants / reusable arrays:** When classes are pulled into a
named variable (e.g. `const navItemBaseClasses = [...]`) or a `cva` base,
grouping with comments is appropriate at any length because the variable
exists specifically to document a shared style contract.

**`cn` is not a formatting tool.** Only use `cn(...)` when you need
conditional/dynamic class merging, or when an element genuinely has 8+
static classes that benefit from grouping. A short static `className` string
is always preferred over a `cn(...)` call with no conditions.

## Group labels

**Group labels are allowed when they materially improve readability.**
As a rule of thumb:

- 1 group: no labels.
- 2-3 groups: labels are allowed if they clarify intent.
- 4+ groups: labels are recommended.

Remember: only label groups if there are more than 3 groups.

Here's an example in CVA (components/ui/button: buttonVariants).

From:

```ts
cva(
  "ring-offset-background focus-visible:ring-ring inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {}
)
```

To:

```ts
cva(
  [
    // layout
    "inline-flex items-center justify-center gap-2",
    // shape
    "rounded-md",
    // typography
    "text-sm font-medium whitespace-nowrap",
    // focus
    "ring-offset-background focus-visible:ring-ring",
    // disabled
    "disabled:pointer-events-none disabled:opacity-50",
    // svg
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    // transitions
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
  ],
  {}
)
```

Here's an example in JSX (components/ui/tabs: TabsTrigger).

From:

```tsx
/*  */
<div
  className={cn(
    "ring-offset-background focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm",
    className
  )}
/>
```

To:

```tsx
<div
  className={cn(
    // layout
    "inline-flex items-center justify-center",
    // shape
    "rounded-sm px-3 py-1.5",
    // typography
    "text-sm font-medium whitespace-nowrap",
    // focus
    "ring-offset-background",
    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
    // disabled
    "disabled:pointer-events-none disabled:opacity-50",
    // transitions
    "transition-all",
    // states
    "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
    className
  )}
/>
```

Please note that:

- `cn` is a util that merges duplicate Tailwind classes, and handles aggregating
  a string of classes from all conditionals. Uses clsx and tailwind-merge.
- `cx` is calls-variance-authority's exported version of `clsx`. Use this
  instead of `cn` because `cn` will remove text-\* classes but we need those
  unduplicated because they can both style colour and font-size!
  `import { VariantProps, cva, cx } from "class-variance-authority";`
- `cva` from class-variance-authority allows us to create type-safe UI
  components with variants. See: https://cva.style/docs
