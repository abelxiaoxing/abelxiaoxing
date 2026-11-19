/**
 * Zero-dependency text width estimation for the profile SVG generator.
 *
 * SVG rendered inside GitHub's <img> sandbox cannot load external fonts, so we
 * rely on a system font stack. Exact glyph metrics are therefore unknowable at
 * generation time; instead we use a conservative per-character advance table
 * (tuned for Inter / SF Pro / Segoe UI and JetBrains Mono / SF Mono) with a
 * safety margin, so that fitText() never lets copy overflow its box and
 * right-aligned numerals stay within a few px of the true edge.
 */

/** Approximate advance widths (em) for the sans stack. */
const SANS_EM = new Map([
  [' ', 0.27], ['\u00a0', 0.27],
  ['i', 0.27], ['l', 0.27], ['j', 0.28], ['I', 0.29],
  ['.', 0.27], [',', 0.27], [':', 0.28], [';', 0.28], ['!', 0.28], ['|', 0.26], ["'", 0.2], ['"', 0.42], ['`', 0.35],
  ['f', 0.33], ['t', 0.35], ['(', 0.34], [')', 0.34], ['[', 0.3], [']', 0.3], ['{', 0.35], ['}', 0.35],
  ['/', 0.36], ['\\', 0.36], ['-', 0.36], ['\u2013', 0.55], ['\u00b7', 0.27], ['\u2022', 0.35],
  ['r', 0.38], ['s', 0.47], ['J', 0.52],
  ['m', 0.83], ['w', 0.83], ['M', 0.94], ['W', 0.94],
  ['@', 0.94], ['%', 0.83], ['&', 0.65], ['?', 0.46], ['#', 0.6], ['*', 0.5], ['_', 0.5], ['\u00b0', 0.4],
  ['+', 0.62], ['=', 0.62], ['<', 0.55], ['>', 0.55], ['\u00d7', 0.6], ['$', 0.55],
  ['\u2026', 0.95], ['\u2014', 1.0], ['\u2605', 1.05], ['\u2197', 0.9],
]);

const DIGIT_EM = 0.6;
const LOWER_EM = 0.53;
const UPPER_EM = 0.7;
const CJK_EM = 1.0;
const FALLBACK_EM = 0.6;

function isCJK(code) {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff01 && code <= 0xff60) || // fullwidth forms
    (code >= 0x3000 && code <= 0x303f)
  );
}

function charEm(ch) {
  const code = ch.codePointAt(0);
  if (SANS_EM.has(ch)) return SANS_EM.get(ch);
  if (code >= 0x30 && code <= 0x39) return DIGIT_EM;
  if (ch >= 'a' && ch <= 'z') return LOWER_EM;
  if (ch >= 'A' && ch <= 'Z') return UPPER_EM;
  if (isCJK(code)) return CJK_EM;
  return FALLBACK_EM;
}

/**
 * Estimated rendered width of `text` in px.
 * @param {string} text
 * @param {{size?: number, weight?: number, mono?: boolean, letterSpacing?: number}} [opts]
 */
export function textWidth(text, opts = {}) {
  const { size = 14, weight = 400, mono = false, letterSpacing = 0 } = opts;
  let px = 0;
  for (const ch of String(text)) px += (mono ? 0.6 : charEm(ch)) * size;
  if (weight >= 600) px *= 1.02;
  if (letterSpacing) px += String(text).length * letterSpacing; // CSS adds spacing after each glyph
  return px;
}

/**
 * Truncate with an ellipsis so the result never exceeds maxWidth.
 * Returns { text, truncated, width }.
 */
export function fitText(text, maxWidth, opts = {}) {
  const str = String(text);
  if (textWidth(str, opts) <= maxWidth) return { text: str, truncated: false, width: textWidth(str, opts) };
  const ell = '\u2026';
  let out = str;
  while (out.length > 0 && textWidth(out + ell, opts) > maxWidth) out = out.slice(0, -1);
  const text2 = out.trimEnd() + ell;
  return { text: text2, truncated: true, width: textWidth(text2, opts) };
}

/**
 * Greedy word-wrap to at most maxLines lines; the last line is ellipsised on overflow.
 * Returns array of { text, width }.
 */
export function wrapText(text, maxWidth, maxLines, opts = {}) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let cur = words[i++];
    while (i < words.length && textWidth(cur + ' ' + words[i], opts) <= maxWidth) {
      cur += ' ' + words[i++];
    }
    lines.push(cur);
  }
  if (i < words.length && lines.length === maxLines) {
    const joined = lines[maxLines - 1] + ' ' + words.slice(i).join(' ');
    lines[maxLines - 1] = fitText(joined, maxWidth, opts).text;
  }
  return lines.map((l) => ({ text: l, width: textWidth(l, opts) }));
}

/** Format integers with thousands separators: 13036 -> "13,036". */
export function fmtInt(n) {
  return Number(n).toLocaleString('en-US');
}
