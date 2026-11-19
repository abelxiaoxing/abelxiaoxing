/**
 * Minimal zero-dependency SVG building helpers + design tokens.
 * Only native SVG primitives are emitted (<rect>, <line>, <path>, <circle>,
 * <text>, <linearGradient>, <clipPath>) plus a tiny CSS @keyframes pulse.
 * No external fonts, no @import, no external images.
 */

/** GitHub-recognised language colours (data encoding, not decoration). */
export const LANG_COLORS = {
  Python: '#3572A5',
  JavaScript: '#f1e05a',
  'C++': '#f34b7d',
  C: '#555555',
  HTML: '#e34c26',
  CSS: '#563d7c',
  TypeScript: '#3178c6',
  Shell: '#89e051',
  Lua: '#000080',
  Vue: '#41b883',
  Rust: '#dea584',
  Go: '#00ADD8',
  Other: '#71717A',
};

export const THEMES = {
  dark: {
    name: 'dark',
    card: '#111114',
    border: '#27272A',
    text1: '#FAFAFA',
    text2: '#A1A1AA',
    text3: '#71717A',
    accent: '#10B981',
    accentFillOpacity: 0.12,
    motif: '#FAFAFA',
  },
  light: {
    name: 'light',
    card: '#FAFAFA',
    border: '#E4E4E7',
    text1: '#09090B',
    text2: '#52525B',
    text3: '#71717A',
    accent: '#059669',
    accentFillOpacity: 0.1,
    motif: '#09090B',
  },
};

export const SANS = "'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
export const MONO = "'JetBrains Mono','SF Mono',ui-monospace,'Cascadia Mono','Source Code Pro',Menlo,Consolas,monospace";

/** XML-escape text content and attribute values. */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const n = (v) => Number(Math.round(v * 100) / 100);

/** Build a <text> element. Coordinates are treated as the baseline anchor. */
export function text({ x, y, str, size = 14, fill, weight = 400, mono = false, ls = 0, anchor = 'start', opacity }) {
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-family="${mono ? MONO : SANS}"`,
    `font-size="${n(size)}"`,
    `font-weight="${weight}"`,
    `fill="${fill}"`,
  ];
  if (ls) attrs.push(`letter-spacing="${n(ls)}"`);
  if (anchor !== 'start') attrs.push(`text-anchor="${anchor}"`);
  if (opacity !== undefined) attrs.push(`opacity="${n(opacity)}"`);
  return `<text ${attrs.join(' ')}>${esc(str)}</text>`;
}

export function rect({ x, y, w, h, rx = 0, fill = 'none', fillOpacity, stroke, strokeWidth = 1, opacity, clip }) {
  const attrs = [`x="${n(x)}"`, `y="${n(y)}"`, `width="${n(w)}"`, `height="${n(h)}"`];
  if (rx) attrs.push(`rx="${n(rx)}"`);
  if (fill !== undefined) attrs.push(`fill="${fill}"`);
  if (fillOpacity !== undefined) attrs.push(`fill-opacity="${n(fillOpacity)}"`);
  if (stroke) attrs.push(`stroke="${stroke}" stroke-width="${n(strokeWidth)}"`);
  if (opacity !== undefined) attrs.push(`opacity="${n(opacity)}"`);
  if (clip) attrs.push(`clip-path="url(#${clip})"`);
  return `<rect ${attrs.join(' ')} />`;
}

export function line({ x1, y1, x2, y2, stroke, strokeWidth = 1, opacity, dash }) {
  const attrs = [
    `x1="${n(x1)}"`, `y1="${n(y1)}"`, `x2="${n(x2)}"`, `y2="${n(y2)}"`,
    `stroke="${stroke}"`, `stroke-width="${n(strokeWidth)}"`,
  ];
  if (dash) attrs.push(`stroke-dasharray="${dash}"`);
  if (opacity !== undefined) attrs.push(`opacity="${n(opacity)}"`);
  return `<line ${attrs.join(' ')} />`;
}

export function circle({ cx, cy, r, fill = 'none', stroke, strokeWidth = 1, opacity, cls }) {
  const attrs = [`cx="${n(cx)}"`, `cy="${n(cy)}"`, `r="${n(r)}"`];
  if (fill !== undefined) attrs.push(`fill="${fill}"`);
  if (stroke) attrs.push(`stroke="${stroke}" stroke-width="${n(strokeWidth)}"`);
  if (opacity !== undefined) attrs.push(`opacity="${n(opacity)}"`);
  if (cls) attrs.push(`class="${cls}"`);
  return `<circle ${attrs.join(' ')} />`;
}

export function path({ d, fill = 'none', stroke, strokeWidth = 1, opacity, dash, linecap = 'round' }) {
  const attrs = [`d="${d}"`, `fill="${fill}"`];
  if (stroke) attrs.push(`stroke="${stroke}" stroke-width="${n(strokeWidth)}" stroke-linecap="${linecap}" stroke-linejoin="round"`);
  if (dash) attrs.push(`stroke-dasharray="${dash}"`);
  if (opacity !== undefined) attrs.push(`opacity="${n(opacity)}"`);
  return `<path ${attrs.join(' ')} />`;
}

/** Wrap body in a standard <svg> document with a11y title and the pulse keyframes. */
export function svgDocument({ w, h, title, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
<title>${esc(title)}</title>
<style>
.pulse { animation: pulse 2.6s ease-in-out infinite; }
.halo { animation: halo 2.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@keyframes halo { 0%, 100% { opacity: 0.18; } 50% { opacity: 0.05; } }
@media (prefers-reduced-motion: reduce) { .pulse, .halo { animation: none; } }
</style>
${body}
</svg>
`;
}
