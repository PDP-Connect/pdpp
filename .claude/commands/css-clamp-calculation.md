---
description: description:
---

---
name: css-clamp-calculation
description:
  Explain and derive CSS clamp() values for linear scaling between viewports.
  Use when calculating clamp values or creating responsive size tokens.
---

# CSS Clamp Calculations

Concise guide for deriving CSS `clamp()` that scales linearly between two
viewport widths.

## Cheat sheet (linear 2-point clamp)

Given: `minVW`, `maxVW`, `min`, `max`

```
slope = (max - min) / (maxVW - minVW)
y     = min - slope * minVW

clamp(minpx, ypx + slope*100 vw, maxpx)
```

Verify quickly:

```
at minVW: y + (slope*100)*(minVW/100) = min
at maxVW: y + (slope*100)*(maxVW/100) = max
```

## Worked example (500 → 1200px)

Target: 15px → 24px

```
slope = 9 / 700 = 0.0128571
y     = 15 - 0.0128571*500 = 8.5714
```

Result:

```css
--spacing-inset: clamp(15px, 8.5714px + 1.2857vw, 24px);
```

## Utility function

```typescript
export function generateClampSize(
  minViewportWidth: number,
  maxViewportWidth: number,
  minFontSize: number,
  maxFontSize: number
): string {
  const minClampValue = `${minFontSize}px`;
  const maxClampValue = `${maxFontSize}px`;
  const slope =
    (maxFontSize - minFontSize) / (maxViewportWidth - minViewportWidth);
  const y = minFontSize - slope * minViewportWidth;
  return `clamp(${minClampValue}, ${y.toFixed(4)}px + ${(slope * 100).toFixed(4)}vw, ${maxClampValue})`;
}
```

Examples:

```ts
generateClampSize(500, 1200, 15, 24);
// "clamp(15px, 8.5714px + 1.2857vw, 24px)"

generateClampSize(375, 1440, 28, 48);
// "clamp(28px, 20.9577px + 1.8779vw, 48px)"
```

## Common breakpoints

- 375 → 768 (mobile first)
- 375 → 1440 (mobile → desktop)
- 768 → 1200 (tablet → desktop)
- 500 → 1200 (current project)

## Best practices

- Test at min/max viewports
- Use meaningful design breakpoints
- Keep 3–4 decimals; avoid excessive precision
- Document inputs (minVW, maxVW, min, max) near the clamp

## Tool

- [Clamp Calculator](mdc:https:/clamp.font-size.app)
