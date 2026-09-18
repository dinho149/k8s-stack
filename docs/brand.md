# Dogfood brand

Dogfood is a developer workspace for environments, releases, and tools. Use **Dogfood** in prose and the lowercase **dogfood** wordmark. Write clear, direct instructions; keep dog jokes out of operational messages.

## Artwork

The original golden dog has floppy brown ears, a cream muzzle, black sunglasses, and a small smile. `packages/portal/src/mascot.tsx` is the artwork source. Use `Mascot` for inline artwork and `Wordmark` beside it. Decorative instances are hidden from assistive technology; pass `label` when an instance communicates a standalone identity. The home link supplies its own accessible name.

Public assets include `dogfood.svg`, dark-ink and white `dogfood-wordmark*.svg` lockups, and transparent 192/512 px PNG icons. Wordmark SVGs embed the locally bundled Nunito Sans font. Regenerate assets from the repository root with:

```sh
node_modules/.bin/tsx packages/portal/scripts/export-brand.tsx
```

Chromium must be installed (`make browser-install`). Keep the SVG proportions, original face colors, and clear space of at least one eighth of the face width. Do not replace the drawing with a platform emoji. Use the white wordmark on dark backgrounds. The small favicon uses the face alone.

## Colors and type

| Role                       | Color     |
| -------------------------- | --------- |
| Cobalt / primary action    | `#2455DB` |
| Golden face / brand detail | `#F4BD42` |
| Ink / masthead             | `#18243B` |
| Light canvas               | `#F3F6FC` |
| Surface                    | `#FFFFFF` |
| Brown ears                 | `#84512E` |

Nunito Sans 900 gives the wordmark its round shape; 700 is used for headings. IBM Plex Sans is the interface face and IBM Plex Mono is for code. All fonts ship locally. Theme tokens in `style.css` supply surface, text, action, and semantic colors; gold is decorative, not a substitute for readable text or status labels.

## Motion

Use a one-second greeting on sign-in, a 550 ms ear flick on brand hover or keyboard focus, a single 1.1-second thinking tilt when a request starts, and a 600 ms success nod when its response arrives. Everyday brand instances stay still. Animation never substitutes for textual progress or success feedback. Reduced-motion preferences disable all mascot animation. No idle loop or animation library is needed.
