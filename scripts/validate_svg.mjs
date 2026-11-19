#!/usr/bin/env node
/**
 * Lightweight validator for generated profile SVGs. Zero dependencies.
 *
 * Checks per file:
 *  1. XML well-formedness (tag matching, quoted attributes, escaped entities)
 *  2. No forbidden strings (NaN / undefined / null / Infinity, unescaped raw &)
 *  3. No external references (@import, url(http…), <image>, href) — offline-safe
 *  4. All geometry coordinates lie inside the viewBox (small tolerance)
 *  5. <text> estimated width stays inside the canvas (uses shared metrics lib)
 *
 * Usage: node scripts/validate_svg.mjs   (exit code 1 on failure)
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textWidth } from './lib/text-metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const TOL = 1.5;

const failures = [];
let checked = 0;

function fail(file, msg) {
  failures.push(`${path.relative(ROOT, file)}: ${msg}`);
}

/* ---------------------------------------------------------- XML checking */

function checkXml(src, file) {
  const stack = [];
  let i = 0;
  const len = src.length;
  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    const textChunk = src.slice(i, lt);
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(textChunk)) {
      fail(file, `raw unescaped "&" in text near offset ${i}`);
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt);
      if (end === -1) return fail(file, 'unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      if (end === -1) return fail(file, 'unterminated comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      if (end === -1) return fail(file, 'unterminated closing tag');
      const name = src.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (open !== name) return fail(file, `tag mismatch: expected </${open ?? 'nothing'}>, got </${name}>`);
      i = end + 1;
      continue;
    }
    const gt = src.indexOf('>', lt);
    if (gt === -1) return fail(file, 'unterminated opening tag');
    const inner = src.slice(lt + 1, gt);
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^[\w:.-]+/);
    if (!nameMatch) return fail(file, `malformed tag near offset ${lt}`);
    const name = nameMatch[0];
    const attrPart = body.slice(name.length);
    if (!/^(\s+[\w:.-]+\s*=\s*"[^"]*")*\s*$/.test(attrPart)) {
      fail(file, `malformed/unquoted attributes in <${name}>`);
    }
    if (!selfClose) stack.push(name);
    i = gt + 1;
  }
  if (stack.length > 0) fail(file, `unclosed tag(s): ${stack.join(', ')}`);
}

/* ------------------------------------------------------- bounds checking */

function attrNum(el, name) {
  const m = el.attrs[name];
  if (m === undefined) return null;
  const v = Number(m);
  return Number.isFinite(v) ? v : NaN;
}

function checkBounds(elements, W, H, file) {
  for (const el of elements) {
    const inX = (v) => v === null || (v >= -TOL && v <= W + TOL);
    const inY = (v) => v === null || (v >= -TOL && v <= H + TOL);
    const ok = (...vals) => vals.every((v) => Number.isFinite(v));

    if (el.name === 'rect') {
      const nums = ['x', 'y', 'width', 'height'].map((a) => attrNum(el, a));
      if (nums.some((v) => !Number.isFinite(v))) fail(file, `<rect> non-numeric geometry`);
      else if (!inX(nums[0]) || !inY(nums[1]) || nums[0] + nums[2] > W + TOL || nums[1] + nums[3] > H + TOL) {
        fail(file, `<rect> out of viewBox: x=${nums[0]} y=${nums[1]} w=${nums[2]} h=${nums[3]}`);
      }
    } else if (el.name === 'circle' || el.name === 'ellipse') {
      const cx = attrNum(el, 'cx'), cy = attrNum(el, 'cy');
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) fail(file, `<${el.name}> non-numeric center`);
      else if (!inX(cx) || !inY(cy)) fail(file, `<${el.name}> center out of viewBox (${cx},${cy})`);
      const rad = el.name === 'circle' ? attrNum(el, 'r') ?? 0 : Math.max(attrNum(el, 'rx') ?? 0, attrNum(el, 'ry') ?? 0);
      if (Number.isFinite(rad) && (cx - rad < -TOL || cy - rad < -TOL || cx + rad > W + TOL || cy + rad > H + TOL)) {
        fail(file, `<${el.name}> extends beyond viewBox`);
      }
    } else if (el.name === 'line') {
      const nums = ['x1', 'y1', 'x2', 'y2'].map((a) => attrNum(el, a));
      if (nums.some((v) => !Number.isFinite(v))) fail(file, `<line> non-numeric coordinates`);
      else if (!inX(nums[0]) || !inX(nums[2]) || !inY(nums[1]) || !inY(nums[3])) {
        fail(file, `<line> out of viewBox`);
      }
    } else if (el.name === 'path') {
      const nums = (el.attrs.d ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (!nums.length) continue;
      // crude but effective: path coordinates come in x,y pairs
      const pairs = [];
      for (let k = 0; k + 1 < nums.length; k += 2) pairs.push([nums[k], nums[k + 1]]);
      for (const [x, y] of pairs) {
        if (!inX(x) || !inY(y)) { fail(file, `<path> point out of viewBox: (${x},${y})`); break; }
      }
    } else if (el.name === 'text') {
      const { x, y, 'text-anchor': anchor = 'start' } = el.attrs;
      if (!ok(attrNum(el, 'x'), attrNum(el, 'y'))) fail(file, `<text> non-numeric position`);
      else if (!inX(+x) || !inY(+y)) fail(file, `<text> position out of viewBox (${x},${y})`);
      const content = el.text;
      const size = attrNum(el, 'font-size') ?? 14;
      const weight = attrNum(el, 'font-weight') ?? 400;
      const mono = (el.attrs['font-family'] ?? '').includes('JetBrains');
      const ls = attrNum(el, 'letter-spacing') ?? 0;
      const w = textWidth(content, { size, weight, mono, letterSpacing: ls });
      const x0 = anchor === 'end' ? +x - w : anchor === 'middle' ? +x - w / 2 : +x;
      const x1 = x0 + w;
      if (x0 < -TOL || x1 > W + 4) {
        fail(file, `<text> may overflow horizontally [est ${Math.round(x0)}..${Math.round(x1)} / W=${W}]: "${content.slice(0, 48)}"`);
      }
    }
  }
}

/* -------------------------------------------------------------- scanning */

function parseElements(src) {
  const elements = [];
  const re = /<(\w+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>([^<]*)|<\/?(\w+)[^>]*>/g;
  // simpler: walk opening tags with plain regex; text only captured for text elements
  const tagRe = /<(\w+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const name = m[1];
    const attrSrc = m[2];
    const attrs = {};
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrSrc)) !== null) attrs[am[1]] = am[2];
    let text = '';
    if (name === 'text') {
      const start = m.index + m[0].length;
      const end = src.indexOf('</text>', start);
      if (end !== -1) {
        text = src.slice(start, end).replace(/<[^>]+>/g, '').trim();
        tagRe.lastIndex = end + 7; // skip past the closing tag
      }
    }
    elements.push({ name, attrs, text });
  }
  return elements;
}

function validateFile(file) {
  const src = readFileSync(file, 'utf8');
  checked += 1;
  checkXml(src, file);

  for (const bad of ['NaN', 'undefined', 'null', 'Infinity']) {
    if (src.includes(bad)) fail(file, `forbidden string "${bad}" present`);
  }
  if (/href|<image|@import|url\(http/i.test(src)) fail(file, 'external reference detected (href/image/@import/url(http))');

  const vb = src.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  if (!vb) { fail(file, 'missing viewBox="0 0 W H"'); return; }
  const W = +vb[1], H = +vb[2];
  checkBounds(parseElements(src), W, H, file);
}

const files = readdirSync(ASSETS).filter((f) => f.endsWith('.svg')).sort();
if (files.length === 0) {
  console.error('no SVG files found in assets/');
  process.exit(1);
}
for (const f of files) validateFile(path.join(ASSETS, f));

console.log(`Validated ${checked} SVG files.`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log('All checks passed: XML well-formed, no forbidden/external refs, geometry inside viewBox, text within bounds.');
