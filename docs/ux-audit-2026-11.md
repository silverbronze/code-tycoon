# UX audit — November 2026

Audit of the local app (overview and city view) with the `ux-guide` probe, a screenshot review per
route and width, and a pass over the heuristics. All findings below marked **Fixed** are fixed in the
same change as this report.

## Method & limits

- **Routes:** `/` (overview) and `/#/p/<project>` (city view, domain map layer, the layer it opens on).
  The app has two views and no login, so this is the whole surface. Not covered: the city and
  schematic layers at phone widths, popups (health, pulse, drawer), the task board's states beyond
  what live data showed, and the voice panel.
- **Widths:** 375, 390, 768, 1280 px. Chrome (GPU on), probe run with `--no-interact`: no clicks,
  no typing, no writes (0 POST/PATCH/PUT/DELETE).
- **Probe limit:** the overview scrolls inside `.overview`, not the page, so the whole-page renders
  only show the first screen. Lower overview sections were judged from the live app, not renders.
- **Dismissed readings:** the `Domain` layer tile label (white on a photo, 3.95:1) is measured
  against the thumbnail's average grey; the label now sits on a darker gradient with a text shadow,
  which the probe does not count. Its compass "tooltip-only" flag is a false positive: the control
  is a visible compass icon and shows a "Reset view" label once the view has moved.
- One evaluator; a second look at the High findings is recommended.

## Visual pass

| Route | Viewport | Verdict |
|---|---:|---|
| `/` | 375 | F-07, F-08 |
| `/` | 390 | F-07, F-08 |
| `/` | 768 | F-04, F-08 |
| `/` | 1280 | F-06 |
| `/#/p/<project>` | 375 | F-01, F-02, F-03 |
| `/#/p/<project>` | 390 | F-01, F-02, F-03 |
| `/#/p/<project>` | 768 | F-01, F-03 |
| `/#/p/<project>` | 1280 | clean |

Fold budget (V3): overview at 375 px, the task box starts at about 575 px (account row, switches,
stats and meters come first); at 1280 px it starts at about 440 px. City view: the map starts right
under the header at every width once F-03 is fixed.

## Findings

**F-01 · High · Fixed.** City view at ≤768 px: the floating pulse strip (sessions, limits, CPU, RAM)
wrapped into a block over the domain panel, covering its tabs (Drift, Map) and help text
(7–8 text collisions). Heuristic: #8 Aesthetic and minimalist; Visual pass V6.
Source: `placeOccluders()` gave the strip a `maxWidth` of at least 200 px whatever the room.
Fix: the strip hides when the open map is narrower than 520 px; the overview shows the same numbers.

**F-02 · High · Fixed.** City view at 375 px: the header did not fit. The voice language select
overlapped the project title, and Uncommitted, rotate and fit went off-screen; icon buttons shrank to
14–18 px wide. Heuristic: #3 User control; Visual pass V6.
Fix: on ≤760 px the header drops the language select, rotate buttons, colour select and Uncommitted
toggle; the title ellipsizes and every other header control keeps its width.

**F-03 · High · Fixed.** City view, domain map layer at ≤1100 px: the 340 px domain panel covered the
whole map on phones and left a ~110 px sliver at 768 px. Heuristic: #8; Visual pass V8.
Fix: below 1100 px the panel becomes a sheet along the bottom of the open map (46% high), the map
frames itself above it (`openBox()` in domain.ts), and the layer switch and compass sit on the
sheet's top edge.

**F-04 · Medium · Fixed.** Secondary text (`--dim`, #8c8c8c) measured 3.1–3.4:1 on white and the pale
card fills: timestamps, paths, costs, hints, table headers. Floor 4.5:1. Heuristic: contrast floor.
Fix: `--dim` is now #6b6b6b (5.3:1 on white, 4.9:1 on #f6f6f6). The red `LIVE` badge (4.3:1 on its
pink fill) is now #b01d23.

**F-05 · Medium · Fixed.** About 48 declarations set text at 9–10.5 px (state tags,
section kickers, drift pills, table headers). Floor is 12 px. Heuristic: type floor.
Fix: first pass raised them to 11 px; a follow-up raised every 10.5–11.5 px declaration (139, in
styles, board, coach, domain, settings and voice CSS) to 12 px. A recount in the live overview at
1280 and 390 px finds no visible text under 12 px; the board and city view keep their layout.

**F-06 · Medium · Fixed.** Overview at 1280 px: the floating mic widget covered a task row's Stop
button, and the page ended only 64 px below the last row, so it could not always scroll clear.
Heuristic: #3 User control. Fix: 112 px of bottom padding on the overview.

**F-07 · Low · Fixed.** Overview at ≤390 px: the stat line wrapped with its `·` separator starting the
second line ("· 5 projects tracked"). Visual pass V6. Fix: separators hide on ≤760 px.

**F-08 · Medium · Fixed.** The project card's "Stop tracking" button is invisible until hover: on touch
screens it could never be found, and keyboard users tabbed onto an invisible control.
Heuristic: signifiers. Fix: it shows on keyboard focus and stays visible (60%) on touch screens.

**F-09 · Low · Fixed.** Controls with no accessible name: voice language select, playback speed select,
replay and play buttons, back arrow, rotate/fit icons. Fix: `aria-label`s. Follow-up: the task
board's task box, project and model selects, route select, answer and note boxes, ship recipe fields,
and the backup folder field in the setup audit are labelled too; the overview has no unnamed field left.

**F-10 · Low · Fixed.** `prefers-reduced-motion` did not stop the blinking live dots (the rule left
`::after` and the iteration count alone). Fix: reduced motion now also covers `::after` and runs
each animation once.

**F-11 · Low · Fixed.** No `main` landmark. Fix: `role="main"` on the overview and city view roots.
A skip link is not needed: neither view has a nav bar to skip.

**F-12 · Medium · Fixed.** Touch targets under 44 px: most chips and toggles are 28–30 px.
Fix: on touch screens (`pointer: coarse`) chips, timeline controls, segment buttons, board selects,
the back arrow and the mic are 44 px; mouse users keep the dense 30 px layout. To make room in the
phone header the live badge shrinks to its dot (the word stays for screen readers), and the timeline
controls scroll sideways instead of running off the bar. Measured at 390 px with touch: every visible
header and timeline control is 44 px.

**Good.** The overview has one clear focal point at every width (the stat line, then the task box).
Nothing scrolls sideways at any width. The black-and-white palette keeps red for things that need you,
and the audit found no other colour competing with it.
