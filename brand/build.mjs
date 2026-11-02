// Code Tycoon logo build. Regenerate everything with: node build.mjs
// Needs work/wm.svg first:
//   py <goldy-logo>/scripts/wordmark.py --text "code tycoon" --font _fonts/SpaceGrotesk-Bold.ttf \
//      --tracking -10 --kern ty=-20 --out work/wm.svg --metrics work/wm.json
import { readFileSync, writeFileSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url);
const r = (n) => +n.toFixed(2);
const P = (pts) => 'M' + pts.map(([x, y]) => `${r(x)} ${r(y)}`).join('L') + 'Z';

// ---- The mark: one 2:1 isometric tower whose lit windows are nested code. ----
// Construction (mark units): half-width A = 22, slope M = 0.5 (2:1 pixel iso).
// One cut width everywhere: the roof seam, the corner seam and every window are `cut` wide.
const A = 22, M = 0.5, G = 3.25;

// Each window = [indent, end] as fractions of the face's inner width:
// open, nest, nest deeper, close, close.
const FLOORS = [[0, 0.72], [0.22, 1], [0.44, 0.86], [0.22, 0.6], [0, 0.34]];
const FLOORS_SMALL = [[0, 0.78], [0.36, 1], [0, 0.46]];
const SMALL = { floors: [[0, 0.78], [0.36, 1], [0, 0.46]], cut: 5.5, pitch: 11, h: 44, top: 6, side: 4 };

// Windows are cut out of a whole face, so the silhouette stays one complete tower.
// (Built from separate strips instead, the face reads as crumbling, or as an F/E.)
function mark({ floors = FLOORS, cut = G, pitch = 7.5, h = 50, top = 4.5, side = 3 }) {
  const B = A * M, cx = A, gy = h + 2 * B; // origin: top-left of the bounding box
  const d = [];
  d.push(P([[cx - A, gy - B - h], [cx, gy - h], [cx + A, gy - B - h], [cx, gy - 2 * B - h]])); // roof
  d.push(P([[cx + cut / 2, gy - cut / 2 * M], [cx + A, gy - B], [cx + A, gy - B - h + cut], [cx + cut / 2, gy - h + cut - cut / 2 * M]])); // right face
  d.push(P([[cx - A, gy - B], [cx - cut / 2, gy - cut / 2 * M], [cx - cut / 2, gy - h + cut - cut / 2 * M], [cx - A, gy - B - h + cut]])); // left face
  const x0 = cx - A + side, w = A - cut / 2 - 2 * side;
  let y = gy - B - h + cut + top + side * M; // window top at x0
  for (const [i0, i1] of floors) {
    const a = x0 + i0 * w, b = x0 + i1 * w, yy = (x) => y + (x - x0) * M;
    d.push(P([[a, yy(a)], [a, yy(a) + cut], [b, yy(b) + cut], [b, yy(b)]])); // reversed winding = hole
    y += pitch;
  }
  return { d: d.join(''), w: 2 * A, h: gy };
}

// ---- Wordmark (outlined Space Grotesk Bold, font units, baseline at y = 0) ----
const wmSrc = readFileSync(here('./work/wm.svg'), 'utf8');
const wmInner = wmSrc.slice(wmSrc.indexOf('<g'), wmSrc.lastIndexOf('</g>') + 4).replace(/fill="[^"]*"/, 'fill="currentColor"');
const wm = JSON.parse(readFileSync(here('./work/wm.json'), 'utf8'));
const X0 = wm.bbox.xMin, X1 = wm.bbox.xMax, ASC = 700, DESC = 200; // 'y' descender

// Lockup rules (font units): mark = 1.75 x cap height, so a floor is one letter stem thick;
// its front-bottom corner sits on the baseline with a 14-unit overshoot (same as the font's
// round letters); gap to the word = 3 stems, so it stays wider than the word space.
const MK = mark({});
const S = 1225 / MK.h;
const OVER = 14, GAP = 380;

const svg = (vb, body, color = '#0B0F1A') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(r).join(' ')}" style="color:${color}">\n${body}\n</svg>\n`;
const markAt = (x, yTop, s, color = 'currentColor', m = MK) =>
  `<path fill-rule="evenodd" fill="${color}" transform="translate(${r(x)} ${r(yTop)}) scale(${r(s)})" d="${m.d}"/>`;
const word = (dx, dy, color) =>
  `<g transform="translate(${r(dx)} ${r(dy)})"${color ? ` style="color:${color}"` : ''}>${wmInner}</g>`;

// Horizontal: mark left, word right, shared baseline.
function horizontal(markColor, wordColor, ink) {
  const mw = MK.w * S, mTop = OVER - MK.h * S;
  const wx = mw + GAP - X0;
  const body = markAt(0, mTop, S, markColor) + '\n' + word(wx, 0, wordColor);
  return svg([0, mTop, wx + X1, -mTop + DESC], body, ink);
}

// Stacked: mark centred over the word.
function stacked(markColor, wordColor, ink) {
  const wordW = X1 - X0, ms = 1.9 * 1225 / MK.h, mw = MK.w * ms, mh = MK.h * ms;
  const mTop = -ASC - 340 - mh;
  const body = markAt((wordW - mw) / 2, mTop, ms, markColor) + '\n' + word(-X0, 0, wordColor);
  return svg([0, mTop, wordW, -mTop + DESC], body, ink);
}

const INK = '#0B0F1A', GOLD = '#F2B23E', PAPER = '#F4F1EA';
const markFile = (m, ink) => svg([0, 0, m.w, m.h], `<path fill-rule="evenodd" fill="currentColor" d="${m.d}"/>`, ink);
const SM = mark(SMALL);

// Favicon: gold small mark on an ink tile, so it holds on light and dark browser tabs.
const fs = 50 / SM.h;
const favicon = svg([0, 0, 64, 64], `<rect width="64" height="64" rx="12" fill="${INK}"/>\n` +
  markAt((64 - SM.w * fs) / 2, (64 - SM.h * fs) / 2, fs, GOLD, SM), INK);

writeFileSync(here('./logo.svg'), horizontal('currentColor', null, INK));
writeFileSync(here('./logo-stacked.svg'), stacked('currentColor', null, INK));
writeFileSync(here('./logo-mono.svg'), horizontal('currentColor', null, '#000'));
writeFileSync(here('./logo-dark.svg'), horizontal(GOLD, PAPER, PAPER));
writeFileSync(here('./mark.svg'), markFile(MK, INK));
writeFileSync(here('./mark-small.svg'), markFile(SM, INK));
writeFileSync(here('./favicon.svg'), favicon);
console.log("mark", MK.w, MK.h, "scale", r(S), "cut", r(G * S));
