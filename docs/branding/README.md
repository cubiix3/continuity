# Continuity brand assets

The Continuity mark is a continuous loop: an outer arc and a return arc, joined by
an inner stroke, with two nodes where work is handed on. The mark is geometric
SVG; the wordmark lettering is a raster taken from the original logo artwork.

## Files

| File | Use |
| --- | --- |
| `continuity-mark.svg` | Mark for dark backgrounds (transparent) |
| `continuity-mark-light.svg` | Mark for light backgrounds (transparent) |
| `continuity-logo-dark.png` | Mark + wordmark for dark backgrounds (transparent, 1320×240) |
| `continuity-logo-light.png` | Mark + wordmark for light backgrounds (transparent, 1320×240) |
| `continuity-readme-banner-dark.png` / `-light.png` | README header, selected by GitHub theme |
| `continuity-social-preview.png` | GitHub social preview (1280×640) |

The Dashboard embeds the mark inline in its sidebar and serves
`packages/dashboard/public/favicon.svg` (mark on a graphite tile). Neither loads
external assets.

## Colors

| Role | Value |
| --- | --- |
| Primary accent (light UI, Dashboard `--accent`) | `#2d6a50` |
| Mark on dark: stroke gradient, node dots | `#3f6153` → `#a3e9c5`, dots `#b8eed1` |
| Mark on light: stroke gradient, node dots | `#9cc6b0` → `#2b7555`, dots `#1f6448` |
| Small sizes (favicon, Dashboard sidebar) | shorter ramps: dark `#6aa98a` → `#a8ecc9`, light `#5f9c80` → `#2b7555` |
| Dark background (graphite) | `#14171a` |
| Light foreground (wordmark on dark) | `#ecefed` |
| Light-mode ink (wordmark on light) | `#1c1e1d` |

## Usage

- Use the mark alone at 16–32 px; use the full lockup from about 120 px wide.
- Keep clear space of at least half the mark's height around the lockup.
- Do not recolor the mark outside these values, add effects, or place the dark
  variant on light backgrounds (or the reverse).
- Assets are covered by the repository's [Apache-2.0 license](../../LICENSE).
