#!/usr/bin/env node
/**
 * Profile asset generator for github.com/abelxiaoxing.
 *
 * Node >= 22, native ESM, ZERO third-party runtime dependencies.
 * Pulls live data from the GitHub REST API and npm registry, then renders
 * self-contained local SVGs (dark + light) into ./assets.
 *
 * All text is width-estimated and truncated defensively via
 * scripts/lib/text-metrics.mjs — no copy can overflow a card.
 *
 * Usage: node scripts/generate_profile.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitText, textWidth, wrapText, fmtInt } from './lib/text-metrics.mjs';
import {
  THEMES, LANG_COLORS, MONO, esc, text, rect, line, circle, path as svgPath, svgDocument,
} from './lib/svg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const CONFIG_PATH = path.join(ROOT, 'profile.config.json');

const config = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(CONFIG_PATH, 'utf8')));

/* ------------------------------------------------------------------ utils */

const pad2 = (v) => String(v).padStart(2, '0');
const r2 = (v) => Math.round(v * 100) / 100;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function warn(msg) {
  console.warn(`  [warn] ${msg}`);
}

async function fetchJSON(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'profile-generator (github.com/abelxiaoxing)', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Largest-remainder rounding so percentages always sum to exactly 100. */
function toPercentages(counts, total) {
  const raw = counts.map((c) => (c / total) * 100);
  const out = raw.map(Math.floor);
  let rem = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < rem; k++) out[order[k % out.length][1]] += 1;
  return out;
}

/* ------------------------------------------------------------- data layer */

/** Fetch last-year contribution totals via GraphQL (requires a token; optional). */
async function fetchContributions(handle, token) {
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar { totalContributions }
        commitContributionsByRepository { repository { nameWithOwner } }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'User-Agent': 'profile-generator (github.com/abelxiaoxing)',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables: { login: handle } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`);
  const cc = json.data?.user?.contributionsCollection;
  const total = cc?.contributionCalendar?.totalContributions;
  if (!Number.isFinite(total)) throw new Error('GraphQL: no totalContributions');
  const repos = (cc.commitContributionsByRepository ?? []).length;
  return { total, repos };
}

async function collectData() {
  const fb = config.fallback;
  const behindProxy = !!(process.env.https_proxy || process.env.HTTPS_PROXY) && !process.env.NODE_USE_ENV_PROXY;
  if (behindProxy) {
    warn('proxy env detected but fetch ignores it — run with NODE_USE_ENV_PROXY=1 for live data, falling back otherwise');
  }
  const out = {
    handle: config.identity.handle,
    publicRepos: fb.publicRepos,
    totalStars: fb.totalStars,
    reposCounted: fb.reposCounted,
    contributionsLastYear: fb.contributionsLastYear,
    contribRepos: fb.contribRepos,
    languages: fb.languages.map(([name, count]) => ({ name, count })),
    memberSince: fb.memberSince,
    npm: { package: fb.npm.package, downloads: fb.npm.downloads, version: fb.npm.version },
    npmPackage: config.featured.find((f) => f.npm)?.npm ?? fb.npm.package,
    featured: config.featured.map((f) => ({
      ...f,
      stars: fb.featuredStars[f.repo],
      lang: fb.featuredLangs[f.repo],
    })),
    sources: { github: 'fallback snapshot', npm: 'fallback snapshot', contributions: 'fallback snapshot' },
    syncedAt: new Date(),
  };

  try {
    const repos = await fetchJSON(`https://api.github.com/users/${out.handle}/repos?per_page=100&sort=updated`);
    const byName = new Map(repos.map((r) => [r.name, r]));
    out.totalStars = repos.reduce((a, r) => a + r.stargazers_count, 0);
    const own = repos.filter((r) => !r.fork && r.language);
    out.reposCounted = own.length;
    const counts = new Map();
    for (const r of own) counts.set(r.language, (counts.get(r.language) || 0) + 1);
    out.languages = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    for (const f of out.featured) {
      const r = byName.get(f.repo);
      if (r) {
        f.stars = r.stargazers_count;
        if (r.language) f.lang = r.language;
      }
    }
    out.sources.github = 'live API';
    try {
      const u = await fetchJSON(`https://api.github.com/users/${out.handle}`);
      out.publicRepos = u.public_repos;
      out.memberSince = u.created_at;
    } catch {
      warn('user endpoint failed — keeping fallback repos/since');
    }
  } catch (e) {
    warn(`GitHub API unreachable (${e.message}) — using fallback snapshot`);
  }

  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) {
    try {
      const contrib = await fetchContributions(out.handle, ghToken);
      out.contributionsLastYear = contrib.total;
      if (contrib.repos > 0) out.contribRepos = contrib.repos;
      out.sources.contributions = 'live GraphQL';
    } catch (e) {
      warn(`contributions GraphQL failed (${e.message}) — using fallback snapshot`);
    }
  }

  try {
    const dl = await fetchJSON(
      `https://api.npmjs.org/downloads/point/last-month/${out.npmPackage}`,
    );
    out.npm.downloads = dl.downloads;
    out.npm.package = out.npmPackage;
    try {
      const tags = await fetchJSON(
        `https://registry.npmjs.org/-/package/${out.npmPackage}/dist-tags`,
      );
      out.npm.version = tags.latest;
    } catch {
      warn('npm dist-tags failed — version omitted');
      delete out.npm.version;
    }
    out.sources.npm = 'live API';
  } catch (e) {
    warn(`npm API unreachable (${e.message}) — using fallback snapshot`);
  }

  return out;
}

/* ------------------------------------------------------------- components */

function statusPill(d, t, { x, cy }) {
  const label = d.status ?? 'open to build';
  const tw = textWidth(label, { size: 11.5, mono: true, letterSpacing: 0.4 });
  const w = 30 + tw + 20;
  const h = 28;
  const parts = [
    rect({ x, y: cy - h / 2, w, h, rx: h / 2, fill: t.accent, fillOpacity: t.accentFillOpacity, stroke: t.border, strokeWidth: 1 }),
    circle({ cx: x + 16, cy, r: 7, fill: t.accent, opacity: 0.18, cls: 'halo' }),
    circle({ cx: x + 16, cy, r: 3.5, fill: t.accent, cls: 'pulse' }),
    text({ x: x + 30, y: cy + 4, str: label, size: 11.5, mono: true, ls: 0.4, fill: t.text2 }),
  ];
  return { svg: parts.join('\n'), width: w };
}

/** Isometric wireframe cube + agent-node graph, 15–25% opacity, right side. */
function heroMotif(d, t) {
  const c = { x: 1005, y: 148, R: 60 };
  const k = (Math.sqrt(3) / 2) * c.R;
  const v = [
    { x: c.x, y: c.y - c.R }, // v0 top
    { x: c.x + k, y: c.y - c.R / 2 }, // v1
    { x: c.x + k, y: c.y + c.R / 2 }, // v2
    { x: c.x, y: c.y + c.R }, // v3 bottom
    { x: c.x - k, y: c.y + c.R / 2 }, // v4
    { x: c.x - k, y: c.y - c.R / 2 }, // v5
  ];
  const outline = `M ${v[0].x} ${v[0].y} L ${v[1].x} ${v[1].y} L ${v[2].x} ${v[2].y} L ${v[3].x} ${v[3].y} L ${v[4].x} ${v[4].y} L ${v[5].x} ${v[5].y} Z`;
  const inner = [
    `M ${c.x} ${c.y} L ${v[1].x} ${v[1].y}`,
    `M ${c.x} ${c.y} L ${v[3].x} ${v[3].y}`,
    `M ${c.x} ${c.y} L ${v[5].x} ${v[5].y}`,
  ].join(' ');

  const nodes = [
    { x: 766, y: 96, r: 3 },
    { x: 842, y: 66, r: 3 },
    { x: 902, y: 120, r: 3.5, accent: true },
    { x: 782, y: 178, r: 3 },
    { x: 862, y: 218, r: 3 },
  ];
  const edges = [
    [0, 1], [1, 2], [0, 3], [3, 4],
  ];

  const parts = [];
  for (const [a, b] of edges) {
    parts.push(line({
      x1: nodes[a].x, y1: nodes[a].y, x2: nodes[b].x, y2: nodes[b].y,
      stroke: t.motif, strokeWidth: 1, opacity: 0.18,
    }));
  }
  parts.push(line({
    x1: nodes[2].x, y1: nodes[2].y, x2: v[5].x, y2: v[5].y,
    stroke: t.motif, strokeWidth: 1, opacity: 0.16, dash: '2 5',
  }));
  for (const nd of nodes) {
    parts.push(nd.accent
      ? circle({ cx: nd.x, cy: nd.y, r: nd.r, fill: t.accent, opacity: 0.5 })
      : circle({ cx: nd.x, cy: nd.y, r: nd.r, stroke: t.motif, strokeWidth: 1, opacity: 0.3 }));
  }
  parts.push(svgPath({ d: outline, stroke: t.motif, strokeWidth: 1, opacity: 0.22, linecap: 'round' }));
  parts.push(svgPath({ d: inner, stroke: t.motif, strokeWidth: 1, opacity: 0.18, linecap: 'round' }));
  return parts.join('\n');
}

function renderHero(d, t) {
  const parts = [];

  const pill = statusPill(d, t, { x: 32, cy: 64 });
  parts.push(pill.svg);

  const nameW = textWidth(d.name, { size: 46, weight: 650 });
  parts.push(text({ x: 32, y: 138, str: d.name, size: 46, weight: 650, fill: t.text1 }));
  parts.push(text({
    x: 32 + nameW + 18, y: 138, str: `@${d.handle}`,
    size: 15, mono: true, fill: t.text3,
  }));

  const tag = fitText(d.tagline, 660, { size: 16 });
  if (tag.truncated) warn(`hero tagline truncated: "${tag.text}"`);
  parts.push(text({ x: 32, y: 174, str: tag.text, size: 16, fill: t.text2 }));

  // Domain chips
  let cx = 32;
  for (const label of d.chips) {
    const tw = textWidth(label, { size: 11, mono: true, letterSpacing: 1 });
    const w = tw + 30;
    parts.push(rect({ x: cx, y: 200, w, h: 26, rx: 13, stroke: t.border, strokeWidth: 1 }));
    parts.push(text({
      x: cx + w / 2, y: 217.5, str: label, size: 11, mono: true, ls: 1,
      fill: t.text2, anchor: 'middle',
    }));
    cx += w + 10;
  }

  parts.push(heroMotif(d, t));

  return svgDocument({ w: 1200, h: 280, title: `${d.name} — AI systems engineer`, body: parts.join('\n') });
}

function renderFocus(d, t) {
  const W = 1200, H = 210, GAP = 12;
  const cw = (W - 2 * GAP) / 3; // 392
  const parts = [];
  d.focus.forEach((card, i) => {
    const x = i * (cw + GAP);
    parts.push(rect({ x, y: 0, w: cw, h: H, rx: 16, fill: t.card, stroke: t.border, strokeWidth: 1 }));

    const idxW = textWidth(card.index, { size: 13, mono: true });
    parts.push(text({ x: x + 26, y: 64, str: card.index, size: 13, mono: true, fill: t.accent }));
    parts.push(text({ x: x + 26 + idxW + 10, y: 64, str: '/', size: 13, mono: true, fill: t.text3 }));
    const title = fitText(card.title, cw - 52 - idxW - 26, { size: 17.5, weight: 600 });
    if (title.truncated) warn(`focus title truncated: "${title.text}"`);
    parts.push(text({
      x: x + 26 + idxW + 22, y: 64, str: title.text, size: 17.5, weight: 600, fill: t.text1,
    }));

    card.lines.forEach((line0, j) => {
      const fitted = fitText(line0, cw - 52, { size: 12.5, mono: true });
      if (fitted.truncated) warn(`focus line truncated: "${fitted.text}"`);
      parts.push(text({ x: x + 26, y: 102 + j * 26, str: fitted.text, size: 12.5, mono: true, fill: t.text2 }));
    });

    parts.push(text({
      x: x + cw - 26, y: 186, str: card.index, size: 92, weight: 700,
      fill: t.text1, opacity: 0.045, anchor: 'end',
    }));
  });
  return svgDocument({ w: W, h: H, title: 'Core focus areas', body: parts.join('\n') });
}

function renderTelemetry(d, t) {
  const W = 1200, H = 190;
  const parts = [
    rect({ x: 0, y: 0, w: W, h: H, rx: 16, fill: t.card, stroke: t.border, strokeWidth: 1 }),
  ];

  const since = (() => {
    const dt = new Date(d.memberSince);
    return `SINCE ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
  })();

  // col 1 — repos
  parts.push(text({ x: 36, y: 72, str: 'PUBLIC REPOS', size: 10.5, mono: true, ls: 1.2, fill: t.text3 }));
  parts.push(text({ x: 36, y: 112, str: fmtInt(d.publicRepos), size: 34, weight: 650, fill: t.text1 }));
  parts.push(text({ x: 36, y: 134, str: since, size: 10, mono: true, ls: 0.6, fill: t.text3 }));

  parts.push(line({ x1: 206, y1: 54, x2: 206, y2: 136, stroke: t.border }));
  // col 2 — contributions (GitHub GraphQL contributionCalendar)
  parts.push(text({ x: 232, y: 72, str: 'CONTRIBUTIONS', size: 10.5, mono: true, ls: 1.2, fill: t.text3 }));
  parts.push(text({ x: 232, y: 112, str: fmtInt(d.contributionsLastYear), size: 34, weight: 650, fill: t.text1 }));
  parts.push(text({ x: 232, y: 134, str: `LAST 12 MO · ${d.contribRepos} REPOS`, size: 10, mono: true, ls: 0.6, fill: t.text3 }));

  parts.push(line({ x1: 398, y1: 54, x2: 398, y2: 136, stroke: t.border }));
  // col 3 — stars
  parts.push(text({ x: 424, y: 72, str: 'TOTAL STARS', size: 10.5, mono: true, ls: 1.2, fill: t.text3 }));
  parts.push(text({ x: 424, y: 112, str: fmtInt(d.totalStars), size: 34, weight: 650, fill: t.text1 }));
  parts.push(text({ x: 424, y: 134, str: 'ALL PUBLIC REPOS', size: 10, mono: true, ls: 0.6, fill: t.text3 }));

  parts.push(line({ x1: 564, y1: 54, x2: 564, y2: 136, stroke: t.border }));
  // col 4 — language mix
  const bx = 596, bw = 300;
  parts.push(text({
    x: bx, y: 72,
    str: `LANGUAGES · ${d.reposCounted} NON-FORK REPOS`,
    size: 10.5, mono: true, ls: 1.2, fill: t.text3,
  }));
  const counts = d.languages.map((l) => l.count);
  const other = Math.max(0, d.reposCounted - counts.reduce((a, b) => a + b, 0));
  const entries = [
    ...d.languages.map((l) => ({ name: l.name, count: l.count, color: LANG_COLORS[l.name] ?? LANG_COLORS.Other })),
    { name: 'Other', count: other, color: LANG_COLORS.Other },
  ].filter((e) => e.count > 0);
  const pcts = toPercentages(entries.map((e) => e.count), d.reposCounted);
  entries.forEach((e, i) => { e.pct = pcts[i]; });

  const clipId = `langbar-${t.name}`;
  parts.push(`<defs><clipPath id="${clipId}"><rect x="${bx}" y="92" width="${bw}" height="8" rx="4" /></clipPath></defs>`);
  parts.push(rect({ x: bx, y: 92, w: bw, h: 8, rx: 4, fill: t.border, opacity: 0.5 }));
  let offset = 0;
  entries.forEach((e, i) => {
    const w = i === entries.length - 1 ? bw - offset : (e.pct / 100) * bw;
    parts.push(rect({ x: bx + offset, y: 92, w, h: 8, fill: e.color, clip: clipId }));
    offset += w;
  });
  entries.forEach((e, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const lx = bx + col * 104, ly = 124 + row * 24;
    parts.push(circle({ cx: lx + 3, cy: ly - 3.5, r: 3.5, fill: e.color }));
    parts.push(text({
      x: lx + 14, y: ly,
      str: fitText(`${e.name.toUpperCase()} ${e.pct}%`, 86, { size: 10, mono: true }).text,
      size: 10, mono: true, fill: t.text2,
    }));
  });

  parts.push(line({ x1: 924, y1: 54, x2: 924, y2: 136, stroke: t.border }));
  // col 5 — package momentum
  parts.push(text({ x: 956, y: 72, str: 'PACKAGE MOMENTUM', size: 10.5, mono: true, ls: 1.2, fill: t.text3 }));
  const dl = fmtInt(d.npm.downloads);
  const dlW = textWidth(dl, { size: 24, weight: 650 });
  parts.push(text({ x: 956, y: 112, str: dl, size: 24, weight: 650, fill: t.text1 }));
  parts.push(text({ x: 956 + dlW + 12, y: 112, str: 'NPM DL · 30D', size: 10, mono: true, ls: 0.6, fill: t.text3 }));
  const pkgLine = d.npm.version ? `${d.npm.package} · v${d.npm.version}` : d.npm.package;
  parts.push(text({
    x: 956, y: 134,
    str: fitText(pkgLine, 208, { size: 10.5, mono: true }).text,
    size: 10.5, mono: true, fill: t.text3,
  }));
  const st = d.syncedAt;
  parts.push(text({
    x: 956, y: 154,
    str: `SYNCED ${st.getUTCFullYear()}-${pad2(st.getUTCMonth() + 1)}-${pad2(st.getUTCDate())} ${pad2(st.getUTCHours())}:${pad2(st.getUTCMinutes())} UTC`,
    size: 10, mono: true, ls: 0.8, fill: t.text3,
  }));

  return svgDocument({ w: W, h: H, title: 'GitHub telemetry — repos, contributions, stars, languages, npm downloads', body: parts.join('\n') });
}

function renderStack(d, t) {
  const W = 1200;
  const PAD = 30, GAP = 12, CHIP_H = 26;
  const rows = d.stack.length;
  const H = 2 * PAD + rows * CHIP_H + (rows - 1) * GAP; // 3 rows -> 162, 4 rows -> 200
  const parts = [
    rect({ x: 0, y: 0, w: W, h: H, rx: 16, fill: t.card, stroke: t.border, strokeWidth: 1 }),
  ];
  d.stack.forEach((grp, gi) => {
    const cy = PAD + CHIP_H / 2 + gi * (CHIP_H + GAP);
    parts.push(text({
      x: 32, y: cy + 3.5, str: grp.group, size: 10.5, mono: true, ls: 1.2, fill: t.text3,
    }));
    let cx = 206;
    for (const item of grp.items) {
      const tw = textWidth(item, { size: 12, mono: true });
      const w = tw + 26;
      if (cx + w > W - 28) { warn(`stack row "${grp.group}" overflow at "${item}"`); break; }
      parts.push(rect({ x: cx, y: cy - 13, w, h: CHIP_H, rx: CHIP_H / 2, stroke: t.border, strokeWidth: 1 }));
      parts.push(text({
        x: cx + w / 2, y: cy + 4, str: item, size: 12, mono: true, fill: t.text2, anchor: 'middle',
      }));
      cx += w + 8;
    }
  });
  return svgDocument({ w: W, h: H, title: 'Technology stack', body: parts.join('\n') });
}

function renderCard(d, t, proj) {
  const W = 580, H = 180;
  const pad = 28;
  const parts = [
    rect({ x: 0, y: 0, w: W, h: H, rx: 16, fill: t.card, stroke: t.border, strokeWidth: 1 }),
  ];

  parts.push(text({
    x: pad, y: 46,
    str: fitText(`${d.handle} / ${proj.repo}`, W - pad * 2 - 40, { size: 11.5, mono: true, ls: 0.5 }).text,
    size: 11.5, mono: true, ls: 0.5, fill: t.text3,
  }));

  // minimal arrow ↗ (drawn as path — unicode arrows risk emoji fallback)
  parts.push(svgPath({
    d: `M ${W - 46} 52 L ${W - 28} 34 M ${W - 28} 34 L ${W - 38} 34 M ${W - 28} 34 L ${W - 28} 44`,
    stroke: t.text3, strokeWidth: 1.6,
  }));

  const title = fitText(proj.title, W - pad * 2 - 36, { size: 21, weight: 650 });
  if (title.truncated) warn(`card title truncated: "${title.text}"`);
  parts.push(text({ x: pad, y: 88, str: title.text, size: 21, weight: 650, fill: t.text1 }));

  const descLines = wrapText(proj.desc, W - pad * 2, 2, { size: 13 });
  descLines.forEach((l, j) => {
    parts.push(text({ x: pad, y: 112 + j * 19, str: l.text, size: 13, fill: t.text2 }));
  });

  parts.push(line({ x1: pad, y1: 141, x2: W - pad, y2: 141, stroke: t.border, opacity: 0.9 }));

  const langColor = LANG_COLORS[proj.lang] ?? LANG_COLORS.Other;
  parts.push(circle({ cx: pad + 4, cy: 157, r: 4.5, fill: langColor }));
  const langLabel = fitText(proj.lang, 220, { size: 12, mono: true }).text;
  parts.push(text({ x: pad + 16, y: 161, str: langLabel, size: 12, mono: true, fill: t.text2 }));
  // npm adoption (only for packages tracked in config), next to the language
  if (proj.npm && d.npm?.package === proj.npm && Number.isFinite(d.npm.downloads)) {
    const langW = textWidth(langLabel, { size: 12, mono: true });
    parts.push(
      `<text x="${r2(pad + 16 + langW + 14)}" y="161" font-family="${MONO}" font-size="12" fill="${t.text3}"><tspan fill="${t.text2}">${fmtInt(d.npm.downloads)}</tspan> npm dl / mo</text>`,
    );
  }
  // star count, anchored right; accent tspan keeps the glyph subtle
  parts.push(
    `<text x="${W - pad}" y="161" font-family="${MONO}" font-size="12" fill="${t.text2}" text-anchor="end"><tspan fill="${t.accent}">\u2605</tspan> ${proj.stars}</text>`,
  );

  return svgDocument({
    w: W, h: H,
    title: `${proj.title} — ${fmtInt(proj.stars)} stars${proj.npm && d.npm?.package === proj.npm ? ` · ${fmtInt(d.npm.downloads)} npm downloads / month` : ''}`,
    body: parts.join('\n'),
  });
}

/* ------------------------------------------------------------------ main */

function main(d) {
  mkdirSync(ASSETS, { recursive: true });
  const written = [];
  const data = {
    ...d,
    focus: config.focus,
    stack: config.stack,
    name: config.identity.name,
    tagline: config.identity.tagline,
    status: config.identity.status,
    chips: ['AGENT SYSTEMS', 'DEEP LEARNING', 'LINUX SYSTEMS'],
  };

  for (const themeName of ['dark', 'light']) {
    const t = THEMES[themeName];
    const emit = (name, svg) => {
      const file = path.join(ASSETS, `${name}-${themeName}.svg`);
      writeFileSync(file, svg);
      written.push(file);
    };
    emit('hero', renderHero(data, t));
    emit('focus', renderFocus(data, t));
    emit('telemetry', renderTelemetry(data, t));
    emit('stack', renderStack(data, t));
    for (const proj of d.featured) {
      emit(`card-${proj.repo.toLowerCase()}`, renderCard(data, t, proj));
    }
  }

  const slug = (f) => path.relative(ROOT, f);
  console.log('\nGenerated assets:');
  for (const f of written) console.log(`  + ${slug(f)}`);
  console.log('\nData summary');
  console.log(`  source github : ${d.sources.github}`);
  console.log(`  source npm    : ${d.sources.npm}`);
  console.log(`  source contrib: ${d.sources.contributions}`);
  console.log(`  public repos  : ${d.publicRepos}   total stars: ${d.totalStars}   contributions/yr: ${d.contributionsLastYear} across ${d.contribRepos} repos`);
  console.log(`  languages     : ${d.languages.map((l) => `${l.name}(${l.count})`).join(', ')} + other, counted over ${d.reposCounted} non-fork repos`);
  console.log(`  npm           : ${d.npm.package} ${fmtInt(d.npm.downloads)} dl/30d${d.npm.version ? ` · v${d.npm.version}` : ''}`);
  console.log(`  featured      : ${d.featured.map((p) => `${p.repo} ★${p.stars} [${p.lang}]`).join(', ')}`);
  console.log(`  synced at     : ${d.syncedAt.toISOString()}`);
}

main(await collectData());
