#!/usr/bin/env node
// Ignite: animated contribution graph (rest > light by commit value > right-to-left sweep to purple).
// Zero dependencies, Node 18+.
//   node generate.mjs --user <login> [--out dist]     (needs GITHUB_TOKEN)
//   node generate.mjs --data <cells.json> [--out dist] (offline snapshot)
//   node generate.mjs --sample [--out dist]           (fake data, offline preview)
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: A } = parseArgs({
  options: {
    user: { type: 'string' },
    data: { type: 'string' },
    out: { type: 'string', default: 'dist' },
    sample: { type: 'boolean', default: false },
  },
});

// ---------- timeline (seconds) ----------
const CYCLE = 12;
const T = {
  waveStart: 1.0, waveLen: 5.7,          // ignition by commit value; last cell lit at 6.7
  tintAt: [7.0, 7.5],                    // empty cells warm up together during the hold
  coolStart: 7.6, coolSpan: 2.9,         // right-to-left sweep (hold ~0.8s with everything lit)
  roseIn: 0.3, purpleAt: 1.1,            // per cell: orange -> rose at +0.3s, rose -> purple at +1.1s
};

// ---------- layout ----------
const CELL = 11, GAP = 3, PITCH = CELL + GAP, W = 840, H = 190;

// ---------- palettes ----------
// dim = resting purple for commit cells, rose = trailing colour of the sweep
const PALETTES = {
  dark: {
    empty: '#2a1a52', dim: '#5a4a8c',
    low: '#ffc89c', mid: '#ff6a00', high: '#fff1b8',
    white: '#fff6e0', rose: '#e0527e', tint: '#55244f',
    glow: 2.6,
  },
  light: {
    empty: '#e6dcfa', dim: '#a898d6',
    low: '#ffb877', mid: '#ff6a00', high: '#ffc800',
    white: '#ffd84d', rose: '#d6457a', tint: '#f3d1dc',
    glow: 1.8,
  },
};

// ---------- helpers ----------
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const heat = (P, l) => (l < 0.5 ? mix(P.low, P.mid, l / 0.5) : mix(P.mid, P.high, (l - 0.5) / 0.5));
const pct = t => +((t / CYCLE) * 100).toFixed(2);
const r1 = v => +v.toFixed(1);
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- data ----------
async function fetchCells(user) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required (or use --sample)');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'ignite-graph' },
    body: JSON.stringify({
      query: `query($l:String!){user(login:$l){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionCount weekday}}}}}}`,
      variables: { l: user },
    }),
  });
  const j = await res.json();
  if (j.errors || !j.data?.user) throw new Error('GitHub API: ' + JSON.stringify(j.errors || 'user not found'));
  const cells = [];
  j.data.user.contributionsCollection.contributionCalendar.weeks.forEach((w, col) =>
    w.contributionDays.forEach(d => cells.push({ col, row: d.weekday, count: d.contributionCount })));
  return cells;
}

function sampleCells() {
  const rnd = rng(7), cells = [], weeks = 53;
  for (let col = 0; col < weeks; col++)
    for (let row = 0; row < 7; row++) {
      if (col === weeks - 1 && row > 3) continue;
      const busy = 0.45 + 0.35 * Math.sin(col / 4.5) + (row > 0 && row < 6 ? 0.15 : -0.2);
      let count = rnd() < busy ? 1 + Math.floor(-Math.log(1 - rnd()) * 2.5) : 0;
      if (rnd() < 0.015) count += 12 + Math.floor(rnd() * 25);
      cells.push({ col, row, count });
    }
  return cells;
}

// ---------- plan (theme-independent so both variants move identically) ----------
function plan(cells) {
  const rnd = rng(1337);
  const cols = Math.max(...cells.map(c => c.col)) + 1;
  const ox = (W - (cols * PITCH - GAP)) / 2, oy = (H - (7 * PITCH - GAP)) / 2;
  const active = cells.filter(c => c.count > 0).sort((a, b) => a.count - b.count || a.col - b.col || a.row - b.row);
  const n = active.length;
  active.forEach((c, i) => {
    const f = n > 1 ? i / (n - 1) : 0;
    c.t = T.waveStart + T.waveLen * f;       // ignite
    const below = active.filter(o => o.count < c.count).length;
    const eq = active.filter(o => o.count === c.count).length;
    c.level = (below + eq / 2) / n;          // percentile heat, ties share a level
    c.idx = i;
  });
  for (const c of cells) { c.x = ox + c.col * PITCH; c.y = oy + c.row * PITCH; }
  for (const c of active) c.tc = T.coolStart + T.coolSpan * ((cols - 1 - c.col) / Math.max(1, cols - 1)) + c.row * 0.02;
  return { cells, active };
}

// ---------- render ----------
function render({ cells, active }, P) {
  const css = [
    `.c{animation-duration:${CYCLE}s;animation-iteration-count:infinite;animation-timing-function:linear}`,
    `@media (prefers-reduced-motion:reduce){.c{animation:none!important}}`,
  ];
  const cols = Math.max(...cells.map(c => c.col)) + 1;
  const deadCols = new Set(cells.filter(c => c.count === 0).map(c => c.col));
  for (const col of deadCols) {
    const tc = T.coolStart + T.coolSpan * ((cols - 1 - col) / Math.max(1, cols - 1));
    const stops = [[0, P.empty], [T.tintAt[0], P.empty], [T.tintAt[1], P.tint], [tc, P.tint],
      [tc + T.roseIn, mix(P.tint, P.rose, 0.25)], [tc + T.purpleAt, P.empty], [CYCLE, P.empty]];
    css.push(`@keyframes d${col}{${stops.map(([t, col2]) => `${pct(t)}%{fill:${col2}}`).join('')}}`);
  }
  const dead = [], live = [];
  for (const c of cells) {
    const geo = `x="${r1(c.x)}" y="${r1(c.y)}" width="${CELL}" height="${CELL}" rx="2"`;
    if (c.count === 0) { dead.push(`<rect class="c" ${geo} fill="${P.empty}" style="animation-name:d${c.col}"/>`); continue; }
    const Hc = heat(P, c.level), g = k => mix(Hc, P.white, k);
    const stops = [
      [0, P.dim], [c.t, P.dim], [c.t + 0.1, P.white], [c.t + 0.38, Hc],
      [c.tc, Hc], [c.tc + T.roseIn, P.rose], [c.tc + T.purpleAt, P.dim], [CYCLE, P.dim],
    ];
    css.push(`@keyframes k${c.idx}{${stops.map(([t, col]) => `${pct(t)}%{fill:${col}}`).join('')}}`);
    live.push(`<rect class="c" ${geo} fill="${P.dim}" style="animation-name:k${c.idx}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Animated contribution graph">
<title>Contribution graph: lights by commit value, then sweeps back to purple</title>
<defs>
<filter id="glow" filterUnits="userSpaceOnUse" x="-100" y="-100" width="${W + 200}" height="${H + 200}" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="${P.glow}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<style>${css.join('')}</style>
<g>${dead.join('')}</g>
<g filter="url(#glow)">${live.join('')}</g>
</svg>
`;
}

// ---------- main ----------
const cells = A.sample ? sampleCells()
  : A.data ? JSON.parse(readFileSync(A.data, 'utf8'))
  : await fetchCells(A.user || process.env.GITHUB_USER);
const p = plan(cells);
mkdirSync(A.out, { recursive: true });
for (const theme of ['dark', 'light']) {
  const svg = render(p, PALETTES[theme]);
  writeFileSync(`${A.out}/ignite-${theme}.svg`, svg);
  console.log(`${theme}: ${(svg.length / 1024).toFixed(0)} KB, ${p.active.length} active cells`);
}
