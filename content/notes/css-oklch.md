---
title: oklch makes the theme maintainable
date: 2026-07-26
updated: 2026-09-06
tags: [CSS, Design]
category: Engineering
---

Every palette written in hex eventually acquires a note that says "this one is
the blue, but darker". `oklch()` removes the note, because the three axes are
the three things you actually want to vary.

```
oklch(62% 0.14 250)
      │   │    └─ hue         — which colour
      │   └────── chroma      — how saturated
      └────────── lightness   — how light
```

The property that matters: **lightness is perceptual, not arithmetic.** In HSL,
`hsl(60 100% 50%)` (yellow) and `hsl(240 100% 50%)` (blue) claim the same
lightness and look nothing alike — yellow reads as far brighter. Building a
"200/400/600/800" scale in HSL gives you a ramp where every step looks like a
different size of jump. In OKLCH, equal lightness steps look equal.

## What this buys the theme

A tag colour, one number different per tag:

```css
.tag-dot {
  --tag-hue: 62;
  background-color: oklch(60% 0.09 var(--tag-hue));
}
```

Saturation and lightness are frozen, so every tag lands at the same visual
weight and none of them shouts. Only the hue moves, which is the entire
information the colour is carrying.

Dark mode is the same rule with the lightness axis moved, not a second palette:

```css
.dark .tag-dot {
  background-color: oklch(72% 0.09 var(--tag-hue));
}
```

## Support

Baseline since 2023 — Chrome 111, Safari 15.4, Firefox 113. `<hex>` fallback is
unnecessary for any browser this site supports, and a fallback that never
applies is dead code that still has to be maintained.
