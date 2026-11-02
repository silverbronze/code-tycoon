# Code Tycoon logo

**Brief:** an identifier for codetycoon.dev, a tool that shows your codebase as a city you run. It must work as a 16px browser-tab icon and in one colour.

**Idea:** one tower whose lit windows are lines of nested code.

**Route:** a subject move. The product turns code into buildings, so the mark is that turn in a single object, with no legend needed.

## Files

| File | Use |
|---|---|
| `logo.svg` | primary horizontal lockup, ink `#0B0F1A` (uses `currentColor`) |
| `logo-dark.svg` | on dark backgrounds: gold `#F2B23E` mark, paper `#F4F1EA` word |
| `logo-stacked.svg` | stacked lockup |
| `logo-mono.svg` | one flat colour (black) |
| `mark.svg` | the mark alone, for 32px and up |
| `mark-small.svg` | simplified mark (3 windows, wider cuts) for 24px and below |
| `favicon.svg` | gold small mark on an ink tile, readable on light and dark tabs |
| `proof-sheet.png`, `colour-and-favicon.png` | rendered audit sheets |

Run `node build.mjs` to regenerate everything. The wordmark command is in the header of that file. `work/` and `_fonts/` are not in the repo: put Space Grotesk (SIL OFL, from Google Fonts) in `_fonts/` and generate `work/wm.svg` first.

## Construction

- 2:1 pixel isometric (the slope city-builder games use), half-width 22 units.
- One cut width everywhere: the roof seam, the corner seam and every window are 3.25 units wide.
- Windows are cut out of a whole face and indented the way nested code is (open, nest, nest deeper, close, close). The closing lines are short.
- Wordmark: Space Grotesk Bold (the app's UI face, SIL OFL) converted to outlines, tracking −10 and `ty` kerned −20.
- Lockup: the mark is 1.75× cap height, and its front corner sits on the baseline (the city stands on the same street as the words). The gap to the word is 3 stems, wider than the word space.
- Clear space: one cap height on all sides.

## Audit (from the rendered proof)

1. Spelling: c-o-d-e t-y-c-o-o-n, all present, at every size.
2. One sentence, no legend: yes, see Idea above.
3. Identifies character (building, ambition, overview), not the "dev tool" category. There are no brackets, no cursor and no `</>`.
4. Route is a subject move.
5. One idea.
6. Relatives: the window cuts and the letter counters are both plain negative space, and both use square-ended rectangles. One device; the wordmark stays plain.
7. Well-made face, no mutilated letter.
8. Even colour. `ty` was loose and is now kerned.
9. Internal gaps are tighter than external ones. The first build failed this (mark gap ≈ word space). Fixed with a 380-unit gap.
10. No tangents. Every cut is a full 3.25 units.
11–13. At 24px and 16px the full mark's windows close up, so `mark-small` / `favicon` take over: 3 wider windows. The tower silhouette survives the blur test at every size.
14. Stranger reading. Earlier versions **failed**: strips attached to a solid face read as **F/E**, and loose strips read as the tower **crumbling**. Both were fixed by cutting windows into a whole face. Remaining risk: a slotted box can read as a "server" icon. The ragged code indentation is what separates them, so never regularise the windows. Also, "tycoon" contains "coon": never hyphenate, line-break or letter-space the word so that ending stands alone.
15. Subject logic holds: windows sit on floors, the base is solid, light falls on one face.
16. None of the clichés (no growth bars, no cogwheel, no house, no gradient).
17. Flat, no effects, so it won't date as an effect.
